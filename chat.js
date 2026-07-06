// 聊天核心：公開主題房、匿名、閱後即焚（訊息不落地，只保留每房最近數則供新加入者看）。
// 每則訊息都過 filter（擋連結/違法/廣告）+ ratelimit（擋洗版）。
'use strict';

const { checkMessage } = require('./lib/filter');
const { createLimiter } = require('./lib/ratelimit');

// 預設主題房（乾淨中性）。ephemeral：history 只留最近 RECENT 則在記憶體，程序結束即消失。
const ROOMS = [
  { id: 'lobby', name: '閒聊大廳' },
  { id: 'mood', name: '心情抒發' },
  { id: 'night', name: '深夜場' },
  { id: 'make-friends', name: '交友配對' },
  { id: 'acg', name: '動漫遊戲' },
];
const ROOM_IDS = new Set(ROOMS.map((r) => r.id));
const RECENT = 25;

const recent = new Map();   // roomId -> [ {nick, text, ts} ]
const clients = new Set();  // 所有連線 { ws, id, nick, room, limiter }
let seq = 1;

function sanitizeNick(n) {
  let s = String(n || '').trim().replace(/[<>&"]/g, '').slice(0, 16);
  if (!s) s = '訪客' + Math.floor(1000 + Math.random() * 9000);
  return s;
}

function roomCount(roomId) {
  let n = 0; for (const c of clients) if (c.room === roomId) n++; return n;
}

function send(ws, obj) { try { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); } catch (e) {} }

function broadcast(roomId, obj, exceptId) {
  for (const c of clients) if (c.room === roomId && c.id !== exceptId) send(c.ws, obj);
}

function pushRecent(roomId, m) {
  const arr = recent.get(roomId) || [];
  arr.push(m); while (arr.length > RECENT) arr.shift();
  recent.set(roomId, arr);
}

function roomList() {
  return ROOMS.map((r) => ({ id: r.id, name: r.name, online: roomCount(r.id) }));
}

// 掛到 ws.Server
function attach(wss) {
  wss.on('connection', (ws, req) => {
    const client = { ws, id: seq++, nick: null, room: null, limiter: createLimiter({ limit: 8, windowMs: 10000 }), ip: (req.headers['cf-connecting-ip'] || (req.socket && req.socket.remoteAddress) || '') };
    clients.add(client);

    // 一連上先給房間清單（還沒 join，得先 join 才能收發）
    send(ws, { type: 'rooms', rooms: roomList() });

    ws.on('message', (buf) => {
      let msg; try { msg = JSON.parse(buf.toString()); } catch (e) { return; }

      if (msg.type === 'join') {
        // 驗證閘：areyoubot PoW 之後接這裡（msg.verify）。MVP 先放行，但保留欄位。
        const room = ROOM_IDS.has(msg.room) ? msg.room : 'lobby';
        client.nick = sanitizeNick(msg.nick);
        client.room = room;
        send(ws, { type: 'joined', room, nick: client.nick, recent: recent.get(room) || [] });
        broadcast(room, { type: 'presence', room, online: roomCount(room), event: 'join', nick: client.nick }, client.id);
        wss.emit('rooms-changed');
        return;
      }

      if (!client.room) return; // 沒 join 不能發

      if (msg.type === 'switch') {
        const prev = client.room;
        const room = ROOM_IDS.has(msg.room) ? msg.room : 'lobby';
        client.room = room;
        broadcast(prev, { type: 'presence', room: prev, online: roomCount(prev), event: 'leave', nick: client.nick }, client.id);
        send(ws, { type: 'joined', room, nick: client.nick, recent: recent.get(room) || [] });
        broadcast(room, { type: 'presence', room, online: roomCount(room), event: 'join', nick: client.nick }, client.id);
        wss.emit('rooms-changed');
        return;
      }

      if (msg.type === 'msg') {
        if (!client.limiter.allow(client.id)) { send(ws, { type: 'sys', msg: '訊息太快了，慢一點～' }); return; }
        const chk = checkMessage(msg.text);
        if (!chk.ok) { send(ws, { type: 'sys', msg: chk.msg || '這則訊息無法送出。' }); return; }
        const m = { nick: client.nick, text: chk.text, ts: Date.now() };
        pushRecent(client.room, m);
        broadcast(client.room, { type: 'msg', ...m });
        send(ws, { type: 'msg', ...m, me: true });
        return;
      }
    });

    ws.on('close', () => {
      clients.delete(client);
      client.limiter.drop(client.id);
      if (client.room) { broadcast(client.room, { type: 'presence', room: client.room, online: roomCount(client.room), event: 'leave', nick: client.nick }, client.id); wss.emit('rooms-changed'); }
    });
    ws.on('error', () => {});
  });

  // 房間人數變動時，廣播新的房間清單給所有人（更新左側在線數）
  let pending = null;
  wss.on('rooms-changed', () => {
    if (pending) return;
    pending = setTimeout(() => { pending = null; const rl = roomList(); for (const c of clients) send(c.ws, { type: 'rooms', rooms: rl }); }, 400);
  });
}

module.exports = { attach, ROOMS };
