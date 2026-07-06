// 聊天核心：1 對 1 隨機配對（對標 knocktalk）。匿名、閱後即焚。
// A 安全：驗證強制、檢舉→封鎖(累積門檻)、避免再配到同一人、連線限流、訊息過濾。
// B 體驗：一句自介、對方正在輸入、興趣優先配對、在線人數。
'use strict';

const { checkMessage } = require('./lib/filter');
const { createLimiter } = require('./lib/ratelimit');

const TOPICS = ['生活', '純聊', '時事娛樂', '工作學業', '感情'];
const REPORT_THRESHOLD = 3;             // 累積被檢舉幾次 → 封鎖
const BLOCK_MS = 30 * 60 * 1000;        // 封鎖時長

// 驗證（之後要接真 PoW 再用；設了 AREYOUBOT_* 才會啟用，否則走前端手動勾選）。secret 只在後端。
const AYB_SECRET = process.env.AREYOUBOT_SECRET || '';
const AYB_VERIFY_URL = process.env.AREYOUBOT_VERIFY_URL || '';
async function verifyAreYouBot(token) {
  if (!token || !AYB_VERIFY_URL) return false;
  try {
    const r = await fetch(AYB_VERIFY_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token, secret: AYB_SECRET }) });
    const d = await r.json();
    return d.success === true;
  } catch (e) { console.error('[hihi] areyoubot verify 失敗:', e.message); return false; }
}

let seq = 1;
const clients = new Set();
const waiting = [];
const reports = new Map();              // ip -> { count, ts }
const blockedUntil = new Map();         // ip -> until(ts)
const bySid = new Map();                // sid -> client（重整後斷線重連用）
const RESUME_GRACE_MS = 15000;          // 斷線後保留配對多久，等重連

function send(ws, obj) { try { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); } catch (e) {} }
function clean(s, max) { return String(s || '').trim().replace(/[<>&"]/g, '').slice(0, max); }
function nickOf(n) { const s = clean(n, 16); return s || ('訪客' + Math.floor(1000 + Math.random() * 9000)); }
// 頭像：'male' / 'female' 預設頭，或上傳的 base64 圖(限大小+格式)，其他一律無頭貼('')
function sanitizeAvatar(a) {
  a = String(a || '').trim();
  if (a === 'male' || a === 'female') return a;
  if (a.indexOf('data:') === 0) {
    if (a.indexOf('data:image/') !== 0 || a.length > 60000) return '';
    if (!/^data:image\/(png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(a)) return '';
    return a;
  }
  return '';
}
function isBlocked(ip) { const u = blockedUntil.get(ip); if (!u) return false; if (Date.now() > u) { blockedUntil.delete(ip); return false; } return true; }
function partnerInfo(x) { return { nick: x.nick, gender: x.gender || null, tags: x.tags || [], bio: x.bio || '', avatar: x.avatar || '' }; }

function statsObj() { return { online: clients.size, waiting: waiting.length }; }
let statsPending = null;
function broadcastStats() {
  if (statsPending) return;
  statsPending = setTimeout(() => { statsPending = null; const s = statsObj(); for (const c of clients) if (c.state !== 'paired') send(c.ws, { type: 'stats', ...s }); }, 500);
}

function compatible(a, b) {
  if (a.code || b.code) return !!(a.code && b.code && a.code === b.code);       // 暗號：同碼才配
  if (a.mode === 'opposite' || b.mode === 'opposite') return !!(a.gender && b.gender && a.gender !== b.gender);
  return true;
}
function findMatch(c) {
  let best = -1, bestScore = -1;
  for (let i = 0; i < waiting.length; i++) {
    const w = waiting[i];
    if (w.id === c.id) continue;
    if (c.avoid.has(w.id) || w.avoid.has(c.id)) continue;   // 檢舉過/剛聊過的不再配
    if (!compatible(c, w)) continue;
    const overlap = (c.tags || []).filter((t) => (w.tags || []).includes(t)).length; // 興趣交集越多越優先
    if (overlap > bestScore) { bestScore = overlap; best = i; }
  }
  if (best >= 0) { const w = waiting[best]; waiting.splice(best, 1); return w; }
  return null;
}
function dequeue(c) { const i = waiting.indexOf(c); if (i >= 0) waiting.splice(i, 1); }

function pair(a, b) {
  clearTimeout(a.botMatchTimer); clearTimeout(b.botMatchTimer);
  a.partner = b; b.partner = a; a.state = 'paired'; b.state = 'paired';
  a.avoid.add(b.id); b.avoid.add(a.id);   // 聊過就先不重配（換下一個才有意義）
  send(a.ws, { type: 'matched', partner: partnerInfo(b) });
  send(b.ws, { type: 'matched', partner: partnerInfo(a) });
}
function unpair(c, reason) {
  const p = c.partner;
  c.partner = null; c.state = 'idle';
  if (p) {
    if (p.isBot) { c.lastPartnerIp = null; resetBot(p); }   // 對方是機器人 → 靜靜重置回收
    else { c.lastPartnerIp = p.ip; p.lastPartnerIp = c.ip; p.partner = null; p.state = 'idle'; send(p.ws, { type: 'partner_left', reason }); }
  }
}
function requeueOrMatch(c) {
  dequeue(c);
  const m = findMatch(c);
  if (m) pair(c, m);
  else { c.state = 'waiting'; waiting.push(c); send(c.ws, { type: 'waiting' }); if (!c.isBot) scheduleBotMatch(c); }
  broadcastStats();
}

// ===================== 機器人（製造活躍感 / 不讓人乾等）=====================
// 女生機器人(5)：慢慢聊，招呼→性別/地點→年齡→閒聊，不會主動離開。
// 男生機器人(20)：很簡單，說幾句(男/年紀/問男女/約嗎)就離開，模擬一堆來去匆匆的男生。
// 一律算在線；真人配不到真人時，隔幾秒配一隻(依對方需求的性別挑)。
const BOT_F_COUNT = 5;
const BOT_M_COUNT = 20;
const BOT_GREET = ['hi', 'hi~', '嗨', '哈囉', 'hello', '嗨嗨', '你好'];
const BOT_IDENT = ['女', '女生', '高雄', '台中', '女的', '北部', '台北', '台南'];
const BOT_AGE = ['20', '24', '25', '21歲', '23', '19', '22歲', '20歲'];
const BOT_FILLER = ['嗯嗯', '然後呢', '哈哈', '你呢', '還好欸', '在幹嘛', '你住哪', '有點無聊', '對啊', '你幾歲', '剛下班', '你呢？', '😆', '看心情', '躺著滑手機', '不會啊'];
const BOT_M_SCRIPTS = [   // 男生：講完一串就離開
  ['男'], ['男的', '約嗎'], ['你男生女生？', '約嗎'], ['24 男', '約嗎？'],
  ['約嗎'], ['男', '幾歲', '約嗎'], ['男生', '有約嗎'], ['台北 男', '約嗎'], ['你女生嗎', '約嗎'], ['安', '男', '約嗎'],
];
const BOTS = [];
function pick(a) { return a[Math.floor(Math.random() * a.length)]; }
function botSend(bot, data) {   // 機器人「收到」server 訊息 → 只有女生會對真人講話反應
  let d; try { d = typeof data === 'string' ? JSON.parse(data) : data; } catch (e) { return; }
  if (d && d.type === 'msg' && !d.me && bot.kind === 'female') botReply(bot);
}
function initBots() {
  let n = 0;
  const mk = (kind) => {
    const b = {
      isBot: true, kind, id: 900000 + (n++), nick: '訪客',
      gender: kind === 'female' ? 'female' : 'male',
      avatar: kind === 'female' ? 'female' : 'male',
      mode: 'random', tags: [], code: '', bio: '',
      partner: null, state: 'idle', avoid: new Set(), verified: true,
      step: 0, mi: 0, mscript: null, ip: 'bot', silenceTimer: null, replyTimer: null, botMatchTimer: null,
      ws: { readyState: 1, send: null },
    };
    b.ws.send = (data) => botSend(b, data);
    BOTS.push(b); clients.add(b);   // 算進在線人數
  };
  for (let i = 0; i < BOT_F_COUNT; i++) mk('female');
  for (let i = 0; i < BOT_M_COUNT; i++) mk('male');
}
function idleBotFor(c) {   // 依對方需求挑：找異性就給異性機器人；隨機就任意(男多女少→多半是男生，很真實)
  let want = null;
  if (c.mode === 'opposite' && c.gender) want = c.gender === 'male' ? 'female' : 'male';
  const pool = BOTS.filter((b) => b.state === 'idle' && (!want || b.gender === want));
  return pool.length ? pick(pool) : null;
}
function botReply(bot) {   // 女生：對方講話→停頓一下再回一句
  if (!bot.partner || bot.replyTimer) return;
  clearTimeout(bot.silenceTimer); bot.silenceTimer = null;
  const human = bot.partner;
  send(human.ws, { type: 'typing' });
  bot.replyTimer = setTimeout(() => {
    bot.replyTimer = null;
    if (bot.partner !== human) return;
    let text;
    if (bot.step === 0) text = pick(BOT_GREET);
    else if (bot.step === 1) text = pick(BOT_IDENT);
    else if (bot.step === 2) text = pick(BOT_AGE);
    else text = pick(BOT_FILLER);
    bot.step++;
    send(human.ws, { type: 'msg', text, ts: Date.now() });
  }, 1400 + Math.random() * 2400);
}
function maleNextLine(bot, delay) {   // 男生：照腳本一句句講，講完就離開
  clearTimeout(bot.replyTimer);
  bot.replyTimer = setTimeout(() => {
    bot.replyTimer = null;
    if (!bot.partner) return;
    if (bot.mi < bot.mscript.length) {
      const human = bot.partner;
      send(human.ws, { type: 'typing' });
      setTimeout(() => {
        if (bot.partner !== human) return;
        send(human.ws, { type: 'msg', text: bot.mscript[bot.mi], ts: Date.now() });
        bot.mi++;
        maleNextLine(bot, 3000 + Math.random() * 4000);
      }, 800 + Math.random() * 1200);
    } else {
      botLeave(bot);
    }
  }, delay);
}
function botOnMatched(bot) {
  bot.step = 0; bot.mi = 0;
  if (bot.kind === 'male') {
    bot.mscript = pick(BOT_M_SCRIPTS);
    maleNextLine(bot, 2000 + Math.random() * 3500);   // 男生主動開口
  } else {
    clearTimeout(bot.silenceTimer);   // 女生通常等對方先講；太久沒人開口就主動破冰
    bot.silenceTimer = setTimeout(() => {
      if (bot.partner && bot.step === 0) { send(bot.partner.ws, { type: 'msg', text: pick(BOT_GREET), ts: Date.now() }); bot.step = 1; }
    }, 12000 + Math.random() * 9000);
  }
}
function botLeave(bot) {   // 男生講完 → 像真人一樣離開，對方看到「對方已離開」
  const human = bot.partner;
  if (human) { human.partner = null; human.state = 'idle'; send(human.ws, { type: 'partner_left', reason: 'bot_leave' }); }
  resetBot(bot);
}
function resetBot(bot) {
  clearTimeout(bot.silenceTimer); clearTimeout(bot.replyTimer);
  bot.silenceTimer = bot.replyTimer = null;
  bot.partner = null; bot.state = 'idle'; bot.step = 0; bot.mi = 0; bot.mscript = null; bot.avoid = new Set();
}
function pairWithBot(human, bot) {
  clearTimeout(human.botMatchTimer);
  human.partner = bot; bot.partner = human;
  human.state = 'paired'; bot.state = 'paired';
  human.avoid.add(bot.id);
  send(human.ws, { type: 'matched', partner: partnerInfo(bot) });
  botOnMatched(bot);
}
function scheduleBotMatch(c) {
  if (c.botMatchTimer) return;
  c.botMatchTimer = setTimeout(() => {
    c.botMatchTimer = null;
    if (c.state !== 'waiting') return;
    const b = idleBotFor(c);
    if (!b) return;   // 沒有合適的機器人 → 繼續等真人
    dequeue(c);
    pairWithBot(c, b);
    broadcastStats();
  }, 3500 + Math.random() * 6000);
}

function attach(wss) {
  wss.on('connection', (ws, req) => {
    const c = {
      ws, id: seq++, nick: null, gender: null, mode: 'random', tags: [], code: '', bio: '', avatar: '😀',
      partner: null, state: 'idle', avoid: new Set(), verified: false,
      limiter: createLimiter({ limit: 8, windowMs: 10000 }),
      ip: (req.headers['cf-connecting-ip'] || (req.socket && req.socket.remoteAddress) || 'unknown'),
    };
    clients.add(c);
    send(ws, { type: 'hello', topics: TOPICS, ...statsObj() });
    broadcastStats();

    ws.on('message', async (buf) => {
      let m; try { m = JSON.parse(buf.toString()); } catch (e) { return; }

      if (m.type === 'start') {
        if (isBlocked(c.ip)) { send(ws, { type: 'blocked' }); return; }
        // 驗證強制：整個 session 驗一次。優先真 PoW token；areyoubot 服務未就緒時退回手動勾選(m.verify)。
        if (!c.verified) {
          let ok = false;
          if (m.token) ok = await verifyAreYouBot(m.token);
          if (!ok && m.verify === true) ok = true;   // fallback：服務未就緒時用手動驗證
          if (!ok) { send(ws, { type: 'need_verify' }); return; }
          c.verified = true;
        }
        c.nick = nickOf(m.nick);
        c.gender = (m.gender === 'male' || m.gender === 'female') ? m.gender : null;
        c.mode = (m.mode === 'opposite') ? 'opposite' : 'random';
        c.tags = Array.isArray(m.tags) ? m.tags.filter((t) => TOPICS.includes(t)).slice(0, 5) : [];
        c.code = clean(m.code, 20);
        c.bio = (function () { const b = clean(m.bio, 40); const chk = checkMessage(b || '　'); return chk.ok ? b : ''; })(); // 自介也過濾
        c.avatar = sanitizeAvatar(m.avatar); // 頭像：emoji 或上傳 base64 圖
        if (m.sid) { c.sid = clean(m.sid, 40); bySid.set(c.sid, c); }
        if (c.state === 'paired') unpair(c, 'restart');
        requeueOrMatch(c);
        return;
      }

      if (m.type === 'resume') {   // 重整後回來：把還在寬限期的舊配對搬到這條新連線
        const sid = clean(m.sid, 40);
        const oc = sid ? bySid.get(sid) : null;
        if (oc && oc !== c && oc.disconnected && oc.partner) {
          clearTimeout(oc.graceTimer);
          const partner = oc.partner;
          c.partner = partner; partner.partner = c;
          c.state = 'paired'; c.verified = true;
          c.avatar = oc.avatar; c.bio = oc.bio; c.gender = oc.gender; c.tags = oc.tags; c.nick = oc.nick; c.mode = oc.mode; c.avoid = oc.avoid; c.lastPartnerIp = oc.lastPartnerIp;
          c.sid = sid; bySid.set(sid, c);
          oc.partner = null; clients.delete(oc);
          send(ws, { type: 'resumed', partner: partnerInfo(partner) });
        } else {
          send(ws, { type: 'resume_failed' });
        }
        return;
      }

      if (m.type === 'msg') {
        if (c.state !== 'paired' || !c.partner) return;
        if (!c.limiter.allow(c.id)) { send(ws, { type: 'sys', msg: '訊息太快了，慢一點～' }); return; }
        const chk = checkMessage(m.text);
        if (!chk.ok) { send(ws, { type: 'sys', msg: chk.msg || '這則訊息無法送出。' }); return; }
        const payload = { type: 'msg', text: chk.text, ts: Date.now() };
        send(c.partner.ws, payload);
        send(ws, { ...payload, me: true });
        return;
      }

      if (m.type === 'typing') { if (c.partner) send(c.partner.ws, { type: 'typing' }); return; }

      if (m.type === 'profile') {   // 中途改頭貼/自介 → 更新自己 + 即時通知對方
        c.avatar = sanitizeAvatar(m.avatar);
        const b = clean(m.bio, 40); const chk = checkMessage(b || '　'); if (chk.ok) c.bio = b;
        if (c.partner) send(c.partner.ws, { type: 'partner_profile', avatar: c.avatar, bio: c.bio });
        return;
      }

      if (m.type === 'report') {
        const p = c.partner;
        if (p) {
          const r = reports.get(p.ip) || { count: 0 }; r.count++; r.ts = Date.now(); reports.set(p.ip, r);
          c.avoid.add(p.id);
          if (!p.isBot && r.count >= REPORT_THRESHOLD) {
            blockedUntil.set(p.ip, Date.now() + BLOCK_MS);
            send(p.ws, { type: 'blocked' });
            dequeue(p); if (p.partner) unpair(p, 'blocked');
          }
          unpair(c, 'reported');
          send(ws, { type: 'sys', msg: '已檢舉並離開，不會再配到這個人。' });
          requeueOrMatch(c);
        }
        return;
      }

      if (m.type === 'report_last') {   // 對方離開後的檢舉（檢舉剛才那位）
        if (c.lastPartnerIp) {
          const r = reports.get(c.lastPartnerIp) || { count: 0 }; r.count++; r.ts = Date.now(); reports.set(c.lastPartnerIp, r);
          if (r.count >= REPORT_THRESHOLD) blockedUntil.set(c.lastPartnerIp, Date.now() + BLOCK_MS);
          c.lastPartnerIp = null;
        }
        send(ws, { type: 'sys', msg: '已檢舉剛才的對象，謝謝。' });
        return;
      }

      if (m.type === 'next') { unpair(c, 'next'); requeueOrMatch(c); return; }
      if (m.type === 'leave') { unpair(c, 'leave'); dequeue(c); c.state = 'idle'; send(ws, { type: 'left' }); broadcastStats(); return; }
    });

    ws.on('close', () => {
      dequeue(c);
      if (c.state === 'paired' && c.partner) {
        // 可能是重整 → 靜靜保留配對，寬限期內可 resume（不打擾對方，快速重整無感）
        c.disconnected = true;
        c.graceTimer = setTimeout(() => {
          if (c.disconnected) { unpair(c, 'disconnect'); if (c.sid) bySid.delete(c.sid); clients.delete(c); broadcastStats(); }
        }, RESUME_GRACE_MS);
      } else {
        unpair(c, 'disconnect'); if (c.sid) bySid.delete(c.sid); clients.delete(c); broadcastStats();
      }
    });
    ws.on('error', () => {});
  });
}

initBots();   // 啟動即上線 5 隻機器人（算在線人數 + 當真人配不到時的備援對象）

module.exports = { attach, TOPICS };
