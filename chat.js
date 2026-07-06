// 聊天核心：1 對 1 隨機配對（對標 knocktalk）。匿名、閱後即焚。
// A 安全：驗證強制、檢舉→封鎖(累積門檻)、避免再配到同一人、連線限流、訊息過濾。
// B 體驗：一句自介、對方正在輸入、興趣優先配對、在線人數。
'use strict';

const { checkMessage } = require('./lib/filter');
const { createLimiter } = require('./lib/ratelimit');

const TOPICS = ['生活', '純聊', '時事娛樂', '工作學業', '感情'];
const REPORT_THRESHOLD = 3;             // 累積被檢舉幾次 → 封鎖
const BLOCK_MS = 30 * 60 * 1000;        // 封鎖時長

// areyoubot 隱形 PoW 驗證：要聊要驗證。secret 只在後端，用 demo key，正式請去 admin 建 site 換掉。
const AYB_SECRET = process.env.AREYOUBOT_SECRET || 'aybsk_demo';
const AYB_VERIFY_URL = process.env.AREYOUBOT_VERIFY_URL || 'https://areyoubot.isnowfriend.com/api/verify';
async function verifyAreYouBot(token) {
  if (!token) return false;
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

function send(ws, obj) { try { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); } catch (e) {} }
function clean(s, max) { return String(s || '').trim().replace(/[<>&"]/g, '').slice(0, max); }
function nickOf(n) { const s = clean(n, 16); return s || ('訪客' + Math.floor(1000 + Math.random() * 9000)); }
// 頭像：emoji(短) 或 上傳的 base64 圖(data:image，限大小+格式，防注入)
function sanitizeAvatar(a) {
  a = String(a || '').trim();
  if (a.indexOf('data:') === 0) {   // 任何 data: 開頭 → 必須是合法 image base64，否則退回 emoji
    if (a.indexOf('data:image/') !== 0 || a.length > 60000) return '😀';
    if (!/^data:image\/(png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(a)) return '😀';
    return a;
  }
  return clean(a, 12) || '😀';
}
function isBlocked(ip) { const u = blockedUntil.get(ip); if (!u) return false; if (Date.now() > u) { blockedUntil.delete(ip); return false; } return true; }
function partnerInfo(x) { return { nick: x.nick, gender: x.gender || null, tags: x.tags || [], bio: x.bio || '', avatar: x.avatar || '😀' }; }

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
  a.partner = b; b.partner = a; a.state = 'paired'; b.state = 'paired';
  a.avoid.add(b.id); b.avoid.add(a.id);   // 聊過就先不重配（換下一個才有意義）
  send(a.ws, { type: 'matched', partner: partnerInfo(b) });
  send(b.ws, { type: 'matched', partner: partnerInfo(a) });
}
function unpair(c, reason) {
  const p = c.partner;
  c.partner = null; c.state = 'idle';
  if (p) { c.lastPartnerIp = p.ip; p.lastPartnerIp = c.ip; p.partner = null; p.state = 'idle'; send(p.ws, { type: 'partner_left', reason }); }
}
function requeueOrMatch(c) {
  dequeue(c);
  const m = findMatch(c);
  if (m) pair(c, m);
  else { c.state = 'waiting'; waiting.push(c); send(c.ws, { type: 'waiting' }); }
  broadcastStats();
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
        if (c.state === 'paired') unpair(c, 'restart');
        requeueOrMatch(c);
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
          if (r.count >= REPORT_THRESHOLD) {
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

    ws.on('close', () => { dequeue(c); unpair(c, 'disconnect'); clients.delete(c); broadcastStats(); });
    ws.on('error', () => {});
  });
}

module.exports = { attach, TOPICS };
