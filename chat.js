// 聊天核心：1 對 1 隨機配對（對標 knocktalk）。匿名、閱後即焚（訊息只在兩人之間即時傳，不落地）。
// 每則訊息過 filter（擋連結/違法/廣告）+ ratelimit（擋洗版）。
'use strict';

const { checkMessage } = require('./lib/filter');
const { createLimiter } = require('./lib/ratelimit');

const TOPICS = ['生活', '純聊', '時事娛樂', '工作學業', '感情'];

let seq = 1;
const clients = new Set(); // 所有連線
const waiting = [];        // 等待配對的佇列

function send(ws, obj) { try { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); } catch (e) {} }
function sanitizeNick(n) { let s = String(n || '').trim().replace(/[<>&"]/g, '').slice(0, 16); if (!s) s = '訪客' + Math.floor(1000 + Math.random() * 9000); return s; }
function partnerInfo(x) { return { nick: x.nick, gender: x.gender || null, tags: x.tags || [] }; }

// 從等待佇列找一個相容的對象
function findMatch(c) {
  for (let i = 0; i < waiting.length; i++) {
    const w = waiting[i];
    if (w.id === c.id) continue;
    let ok = false;
    if (c.code && w.code) ok = (c.code === w.code);           // 有暗號：同暗號才配（私下約聊）
    else if (!c.code && !w.code) {
      if (c.mode === 'opposite' || w.mode === 'opposite') {   // 異性模式：需性別相反
        ok = !!(c.gender && w.gender && c.gender !== w.gender);
      } else ok = true;                                        // 隨機
    }
    if (ok) { waiting.splice(i, 1); return w; }
  }
  return null;
}
function dequeue(c) { const i = waiting.indexOf(c); if (i >= 0) waiting.splice(i, 1); }

function pair(a, b) {
  a.partner = b; b.partner = a; a.state = 'paired'; b.state = 'paired';
  send(a.ws, { type: 'matched', partner: partnerInfo(b) });
  send(b.ws, { type: 'matched', partner: partnerInfo(a) });
}
function unpair(c, reason) {
  const p = c.partner;
  c.partner = null; c.state = 'idle';
  if (p) { p.partner = null; p.state = 'idle'; send(p.ws, { type: 'partner_left', reason }); }
}

function requeueOrMatch(c) {
  dequeue(c);
  const m = findMatch(c);
  if (m) pair(c, m);
  else { c.state = 'waiting'; waiting.push(c); send(c.ws, { type: 'waiting' }); }
}

function attach(wss) {
  wss.on('connection', (ws, req) => {
    const c = {
      ws, id: seq++, nick: null, gender: null, mode: 'random', tags: [], code: '',
      partner: null, state: 'idle', limiter: createLimiter({ limit: 8, windowMs: 10000 }),
      ip: (req.headers['cf-connecting-ip'] || (req.socket && req.socket.remoteAddress) || ''),
    };
    clients.add(c);
    send(ws, { type: 'hello', topics: TOPICS, online: clients.size });

    ws.on('message', (buf) => {
      let m; try { m = JSON.parse(buf.toString()); } catch (e) { return; }

      if (m.type === 'start') {
        // 驗證閘：areyoubot PoW 之後接這裡（m.verify）。MVP 先放行、保留欄位。
        c.nick = sanitizeNick(m.nick);
        c.gender = (m.gender === 'male' || m.gender === 'female') ? m.gender : null;
        c.mode = (m.mode === 'opposite') ? 'opposite' : 'random';
        c.tags = Array.isArray(m.tags) ? m.tags.filter((t) => TOPICS.includes(t)).slice(0, 5) : [];
        c.code = String(m.code || '').trim().slice(0, 20);
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

      if (m.type === 'next') { unpair(c, 'next'); requeueOrMatch(c); return; }   // 換下一個
      if (m.type === 'leave') { unpair(c, 'leave'); dequeue(c); c.state = 'idle'; send(ws, { type: 'left' }); return; }
    });

    ws.on('close', () => { dequeue(c); unpair(c, 'disconnect'); clients.delete(c); });
    ws.on('error', () => {});
  });
}

module.exports = { attach, TOPICS };
