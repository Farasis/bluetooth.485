// utils.js — 字节/格式通用工具（纯函数，无状态）

/**
 * 当前时间戳字符串 "HH:MM:SS.mmm"
 * @param {Date} [ts]
 * @returns {string}
 */
export function timestamp(ts = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(ts.getHours())}:${p(ts.getMinutes())}:${p(ts.getSeconds())}.${p(ts.getMilliseconds(), 3)}`;
}

/**
 * 字节数组 → "01 03 00 00 84 0A" 形式的十六进制字符串
 * @param {Uint8Array} bytes
 * @param {string} [sep]
 * @returns {string}
 */
export function bytesToHex(bytes, sep = ' ') {
  if (!bytes || bytes.length === 0) return '(空)';
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    if (i > 0) out += sep;
    out += bytes[i].toString(16).padStart(2, '0').toUpperCase();
  }
  return out;
}

/**
 * 字节数组 → ASCII 可读串，控制字符显示为 '.'
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function bytesToAscii(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    out += (b >= 0x20 && b <= 0x7e) ? String.fromCharCode(b) : '.';
  }
  return out;
}

/**
 * 十六进制字符串 → Uint8Array。
 * 容忍 "01 03"、"0103"、"0x01,0x03"、换行、混合大小写。
 * @param {string} str
 * @returns {Uint8Array}
 * @throws {Error} 非法字符/奇数长度时抛出 "非法HEX: ..."
 */
export function hexToBytes(str) {
  let s = String(str)
    .replace(/0x/gi, ' ')
    .replace(/[,:;\s-]+/g, '')
    .trim();
  if (s.length === 0) return new Uint8Array(0);
  if (s.length % 2 !== 0) throw new Error(`非法HEX: 长度 ${s.length} 为奇数`);
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byte = parseInt(s.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) throw new Error(`非法HEX: 含非十六进制字符 "${s.slice(i * 2, i * 2 + 2)}"`);
    out[i] = byte;
  }
  return out;
}

/** 大端读取 u16；越界返回 null */
export function u16BE(bytes, i) {
  if (i < 0 || i + 1 >= bytes.length) return null;
  return ((bytes[i] << 8) | bytes[i + 1]) & 0xffff;
}

/** 小端读取 u16；越界返回 null */
export function u16LE(bytes, i) {
  if (i < 0 || i + 1 >= bytes.length) return null;
  return ((bytes[i + 1] << 8) | bytes[i]) & 0xffff;
}

/**
 * HTML 转义（日志内容注入 innerHTML 前必须调用）
 * @param {*} s
 * @returns {string}
 */
export function escapeHTML(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 合并多个字节源 → 新的 Uint8Array */
export function concatBytes(...parts) {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}
