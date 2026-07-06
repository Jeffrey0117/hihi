// 無依賴 .env 載入器。
'use strict';
const fs = require('fs');
const path = require('path');
let loaded = false;
module.exports = function loadEnv() {
  if (loaded) return; loaded = true;
  try {
    const p = path.join(__dirname, '..', '.env');
    if (!fs.existsSync(p)) return;
    for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
      const s = line.trim(); if (!s || s.startsWith('#')) continue;
      const eq = s.indexOf('='); if (eq === -1) continue;
      const k = s.slice(0, eq).trim(); let v = s.slice(eq + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      if (k) process.env[k] = v;
    }
  } catch (e) { console.error('[hihi] .env 載入失敗:', e.message); }
};
