// 嗨嗨聊天室 server：http 服務 public/ 靜態 + WebSocket 即時聊天。
'use strict';

require('./lib/env')();
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const { attach } = require('./chat');

const PORT = process.env.PORT || 4030;
const PUBLIC = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

const server = http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];
  if (url === '/health') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true}'); return; }
  let file = url === '/' ? 'index.html' : url.replace(/^\/+/, '');
  const full = path.join(PUBLIC, file);
  // 防路徑穿越
  if (!path.resolve(full).startsWith(path.resolve(PUBLIC))) { res.writeHead(403); res.end('forbidden'); return; }
  fs.readFile(full, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('404'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream' });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server, path: '/ws' });
attach(wss);

server.listen(PORT, () => console.log(`[hihi] running on http://localhost:${PORT}  (ws: /ws)`));
