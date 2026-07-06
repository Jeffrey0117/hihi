// 訊息過濾（乾淨合法安全第一）：擋連結、擋違法/廣告關鍵字。純文字聊天，不接受任何 URL。
'use strict';

// 一律擋外連（匿名聊天貼連結＝廣告/違法散布的主要途徑）
const URL_RE = /(https?:\/\/|www\.|\b[a-z0-9-]+\.(com|net|org|tw|io|me|cc|xyz|top|vip|app|link|shop)\b|t\.me\/|line\.me\/|\bqr\b)/i;

// 違法/高風險關鍵字（命中直接擋，不只過濾）——重點防未成年/性影像/交易/毒品/暴力徵求
const BLOCK_WORDS = [
  '未成年', '幼女', '幼童', '國中生', '小學', '童顏', 'jb', '蘿莉',
  '外流', '偷拍', '私密影像', '報復式', '換臉',
  '約炮', '援交', '包養', '一夜', '性交易', '嫖', '賣淫',
  '毒品', '大麻', '安非他命', '搖頭', '喪屍', 'ketamine',
  '槍', '販賣', '代購兒', '兒色',
];

// 廣告/導流（洗版）
const SPAM_WORDS = ['加賴', '加line', '加賴聊', '看更多', '點我', '免費看片', '賺錢', '博弈', '娛樂城', '代儲'];

function checkMessage(text) {
  const t = String(text || '').trim();
  if (!t) return { ok: false, reason: 'empty' };
  if (t.length > 300) return { ok: false, reason: 'too_long' };
  if (URL_RE.test(t)) return { ok: false, reason: 'no_links', msg: '為了大家安全，聊天室不開放貼連結。' };
  const low = t.toLowerCase().replace(/\s+/g, '');
  for (const w of BLOCK_WORDS) {
    if (low.includes(w.toLowerCase())) return { ok: false, reason: 'blocked', msg: '這則訊息包含不允許的內容，已被攔下。' };
  }
  for (const w of SPAM_WORDS) {
    if (low.includes(w.toLowerCase())) return { ok: false, reason: 'spam', msg: '請勿張貼廣告／導流訊息。' };
  }
  // 通過：回傳做過基本 HTML escape 的安全文字
  const safe = t.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  return { ok: true, text: safe };
}

module.exports = { checkMessage };
