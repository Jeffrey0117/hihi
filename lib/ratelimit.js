// 每連線滑動視窗限流（擋洗版/機器人）。純記憶體。
'use strict';

function createLimiter({ limit = 8, windowMs = 10000 } = {}) {
  // 每個 key（連線）保留時間戳陣列
  const buckets = new Map();
  function allow(key) {
    const now = Date.now();
    const arr = (buckets.get(key) || []).filter((t) => now - t < windowMs);
    if (arr.length >= limit) { buckets.set(key, arr); return false; }
    arr.push(now);
    buckets.set(key, arr);
    return true;
  }
  function drop(key) { buckets.delete(key); }
  return { allow, drop };
}

module.exports = { createLimiter };
