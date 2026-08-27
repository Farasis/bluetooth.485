// modbus.js — CRC16-Modbus 与 Modbus RTU 帧解析/解码
import { u16BE } from './utils.js';

// ===== CRC16-Modbus =====
// 多项式 0x8005 反射 → 0xA001，初值 0xFFFF，LSB 优先，无输入/输出异或。
// 传输时 CRC 按小端追加：先低字节后高字节。

/**
 * 计算 CRC16-Modbus
 * @param {Uint8Array|number[]} bytes
 * @returns {number}
 */
export function crc16Modbus(bytes) {
  let crc = 0xffff;
  for (let i = 0; i < bytes.length; i++) {
    crc ^= bytes[i];
    for (let b = 0; b < 8; b++) {
      crc = (crc & 1) ? ((crc >>> 1) ^ 0xa001) : (crc >>> 1);
    }
  }
  return crc & 0xffff;
}

/**
 * 在帧末尾追加 CRC（小端）
 * @param {Uint8Array|number[]} frame
 * @returns {Uint8Array}
 */
export function appendCrc(frame) {
  const crc = crc16Modbus(frame);
  const out = new Uint8Array(frame.length + 2);
  out.set(frame, 0);
  out[frame.length] = crc & 0xff;
  out[frame.length + 1] = (crc >> 8) & 0xff;
  return out;
}

/** 校验帧尾部 2 字节 CRC；len 为完整帧长度 */
function checkCrc(bytes, len) {
  const calc = crc16Modbus(bytes.subarray(0, len - 2));
  const rx = (bytes[len - 1] << 8) | bytes[len - 2];
  return { ok: rx === calc, rx, calc };
}

// ===== 名称/异常码 =====
const FC_NAMES = {
  0x01: '读线圈', 0x02: '读离散输入', 0x03: '读保持寄存器', 0x04: '读输入寄存器',
  0x05: '写单个线圈', 0x06: '写单个寄存器', 0x0F: '写多个线圈',
  0x10: '写多个寄存器', 0x16: '掩码写寄存器', 0x17: '读写多寄存器',
};

const EXC_CODES = {
  0x01: '非法功能码', 0x02: '非法数据地址', 0x03: '非法数据值',
  0x04: '从站设备故障', 0x05: '确认', 0x06: '从站设备忙',
  0x08: '存储奇偶性错误', 0x0A: '网关路径不可用', 0x0B: '网关目标设备响应失败',
};

function h(n) { return n.toString(16).padStart(2, '0').toUpperCase(); }
function h16(n) { return '0x' + n.toString(16).padStart(4, '0').toUpperCase(); }

/** 字节 → 寄存器数组 [{hex, dec}] */
function decodeRegs(data) {
  const regs = [];
  for (let i = 0; i + 1 < data.length; i += 2) {
    regs.push({ hex: h16((data[i] << 8) | data[i + 1]), dec: (data[i] << 8) | data[i + 1] });
  }
  return regs;
}

/** 字节 → 线圈位数组 [boolean] */
function decodeBits(data) {
  const bits = [];
  for (let i = 0; i < data.length; i++) {
    for (let b = 0; b < 8; b++) bits.push(((data[i] >> b) & 1) === 1);
  }
  return bits;
}

// ===== 各功能码解码 =====

/** 读类 0x01/0x02/0x03/0x04：请求 8B，响应 byteCount+5B，需判别 */
function decodeReadFrame(bytes, slave, fc) {
  const name = FC_NAMES[fc];

  // 请求候选
  let reqFields = null;
  if (bytes.length >= 8) {
    reqFields = { start: u16BE(bytes, 2), qty: u16BE(bytes, 4) };
  }
  // 响应候选
  let respLen = null, respByteCount = null, respFields = null;
  if (bytes.length >= 3) {
    respByteCount = bytes[2];
    respLen = respByteCount + 5;
    if (respLen <= bytes.length) {
      const data = bytes.slice(3, respLen - 2);
      respFields = (fc === 0x01 || fc === 0x02)
        ? { byteCount: respByteCount, bits: decodeBits(data) }
        : { byteCount: respByteCount, regs: decodeRegs(data) };
    }
  }

  // 候选选择
  let mode; // 'req' | 'resp'
  if (reqFields && respFields) {
    if (respLen === bytes.length && respLen !== 8) mode = 'resp';
    else if (8 === bytes.length && respLen !== 8) mode = 'req';
    else {
      // 长度重合或都不精确匹配，用 CRC 判定，优先合法者
      const okReq = checkCrc(bytes, 8).ok;
      const okResp = checkCrc(bytes, respLen).ok;
      mode = (okResp && !okReq) ? 'resp' : (okReq && !okResp) ? 'req' : 'req';
    }
  } else if (respFields) mode = 'resp';
  else if (reqFields) mode = 'req';
  else return { ok: false, reason: 'tooShort', length: null };

  const isResp = mode === 'resp';
  const len = isResp ? respLen : 8;
  const crcRes = checkCrc(bytes, len);
  const fields = isResp ? respFields : reqFields;
  const data = isResp ? bytes.slice(3, len - 2) : bytes.slice(2, len - 2);

  let desc;
  if (isResp) {
    if (fc === 0x01 || fc === 0x02) {
      desc = `${name}响应 · 从站=${h(slave)} 数据=${respByteCount}字节`;
    } else {
      const regStr = respFields.regs.map(r => `${r.hex}=${r.dec}`).join(' ');
      desc = `${name}响应 · 从站=${h(slave)} 寄存器=${respByteCount / 2}个${regStr ? ' · ' + regStr : ''}`;
      if (respByteCount % 2 !== 0) desc += ' ⚠字节数异常';
    }
  } else {
    desc = `${name}请求 · 从站=${h(slave)} 起始=${h16(reqFields.start)} 数量=${reqFields.qty}`;
  }

  if (!crcRes.ok) {
    return { ok: false, reason: 'badCrc', length: len, crcRx: crcRes.rx, crcCalc: crcRes.calc };
  }
  return {
    ok: true, slave, fc, isException: false, data,
    crcRx: crcRes.rx, crcCalc: crcRes.calc, crcOk: true,
    length: len, kind: isResp ? 'response' : 'request', fields, desc,
  };
}

/** 写单个线圈 0x05：请求=回显，8B，value 校验 FF00/0000 */
function decodeWriteSingleCoil(bytes, slave) {
  const len = 8;
  if (bytes.length < len) return { ok: false, reason: 'tooShort', length: len };
  const coilAddr = u16BE(bytes, 2);
  const value = u16BE(bytes, 4);
  const valStr = value === 0xff00 ? 'ON' : value === 0x0000 ? 'OFF' : `非法值(0x${h16(value)})`;
  const crcRes = checkCrc(bytes, len);
  const fields = { coilAddr, value: valStr };
  if (!crcRes.ok) return { ok: false, reason: 'badCrc', length: len, crcRx: crcRes.rx, crcCalc: crcRes.calc };
  return {
    ok: true, slave, fc: 0x05, isException: false, data: bytes.slice(2, len - 2),
    crcRx: crcRes.rx, crcCalc: crcRes.calc, crcOk: true, length: len, kind: 'request', fields,
    desc: `写单个线圈(请求/回显) · 从站=${h(slave)} 线圈=${h16(coilAddr)} 值=${valStr}`,
  };
}

/** 写单个寄存器 0x06：请求=回显，8B */
function decodeWriteSingleReg(bytes, slave) {
  const len = 8;
  if (bytes.length < len) return { ok: false, reason: 'tooShort', length: len };
  const regAddr = u16BE(bytes, 2);
  const value = u16BE(bytes, 4);
  const crcRes = checkCrc(bytes, len);
  const fields = { regAddr, value };
  if (!crcRes.ok) return { ok: false, reason: 'badCrc', length: len, crcRx: crcRes.rx, crcCalc: crcRes.calc };
  return {
    ok: true, slave, fc: 0x06, isException: false, data: bytes.slice(2, len - 2),
    crcRx: crcRes.rx, crcCalc: crcRes.calc, crcOk: true, length: len, kind: 'request', fields,
    desc: `写单个寄存器(请求/回显) · 从站=${h(slave)} 寄存器=${h16(regAddr)} 值=${h16(value)}`,
  };
}

/** 写多个 0x0F/0x10：请求 ≥9B，响应 8B */
function decodeWriteMultiple(bytes, slave, fc) {
  const name = FC_NAMES[fc];

  // 响应 8B：start(2) qty(2)
  if (bytes.length === 8) {
    const start = u16BE(bytes, 2);
    const qty = u16BE(bytes, 4);
    const crcRes = checkCrc(bytes, 8);
    if (!crcRes.ok) return { ok: false, reason: 'badCrc', length: 8, crcRx: crcRes.rx, crcCalc: crcRes.calc };
    return {
      ok: true, slave, fc, isException: false, data: bytes.slice(2, 6),
      crcRx: crcRes.rx, crcCalc: crcRes.calc, crcOk: true, length: 8, kind: 'response',
      fields: { start, qty },
      desc: `${name}响应 · 从站=${h(slave)} 起始=${h16(start)} 数量=${qty}`,
    };
  }
  // 请求：start(2) qty(2) byteCount(1) data(N)
  if (bytes.length < 9) return { ok: false, reason: 'tooShort', length: null };
  const start = u16BE(bytes, 2);
  const qty = u16BE(bytes, 4);
  const byteCount = bytes[6];
  const len = 9 + byteCount;
  if (bytes.length < len) return { ok: false, reason: 'tooShort', length: len };
  const expect = fc === 0x0f ? Math.ceil(qty / 8) : qty * 2;
  const data = bytes.slice(7, len - 2);
  const crcRes = checkCrc(bytes, len);
  if (expect !== byteCount) {
    return { ok: false, reason: 'lengthMismatch', length: len, expect, byteCount, crcRx: crcRes.rx, crcCalc: crcRes.calc };
  }
  if (!crcRes.ok) return { ok: false, reason: 'badCrc', length: len, crcRx: crcRes.rx, crcCalc: crcRes.calc };
  return {
    ok: true, slave, fc, isException: false, data,
    crcRx: crcRes.rx, crcCalc: crcRes.calc, crcOk: true, length: len, kind: 'request',
    fields: { start, qty, byteCount, data },
    desc: `${name}请求 · 从站=${h(slave)} 起始=${h16(start)} 数量=${qty} 数据=${byteCount}字节`,
  };
}

/** 掩码写寄存器 0x16：请求=回显，10B（regAddr2 + andMask2 + orMask2 + CRC2） */
function decodeMaskWrite(bytes, slave) {
  const len = 10;
  if (bytes.length < len) return { ok: false, reason: 'tooShort', length: len };
  const regAddr = u16BE(bytes, 2);
  const andMask = u16BE(bytes, 4);
  const orMask = u16BE(bytes, 6);
  const crcRes = checkCrc(bytes, len);
  const fields = { regAddr, andMask, orMask };
  if (!crcRes.ok) return { ok: false, reason: 'badCrc', length: len, crcRx: crcRes.rx, crcCalc: crcRes.calc };
  return {
    ok: true, slave, fc: 0x16, isException: false, data: bytes.slice(2, len - 2),
    crcRx: crcRes.rx, crcCalc: crcRes.calc, crcOk: true, length: len, kind: 'request', fields,
    desc: `掩码写寄存器(请求/回显) · 从站=${h(slave)} 寄存器=${h16(regAddr)} AND=${h16(andMask)} OR=${h16(orMask)}`,
  };
}

/** 读写多寄存器 0x17 */
function decodeReadWriteMultiple(bytes, slave) {
  // 响应：readByteCount(1) data(N) → len=5+readByteCount
  let respLen = null, respFields = null;
  if (bytes.length >= 3) {
    const rbc = bytes[2];
    respLen = rbc + 5;
    if (respLen <= bytes.length) {
      respFields = { readByteCount: rbc, regs: decodeRegs(bytes.slice(3, respLen - 2)) };
    }
  }
  // 请求：readStart(2) readQty(2) writeStart(2) writeQty(2) writeByteCount(1) data(N) → len=13+wbc
  let reqLen = null, reqFields = null;
  if (bytes.length >= 11) {
    const wbc = bytes[10];
    reqLen = 13 + wbc;
    if (reqLen <= bytes.length) {
      reqFields = {
        readStart: u16BE(bytes, 2), readQty: u16BE(bytes, 4),
        writeStart: u16BE(bytes, 6), writeQty: u16BE(bytes, 8),
        writeByteCount: wbc,
      };
    }
  }

  let isResp;
  if (respFields && reqFields) {
    if (respLen === bytes.length && reqLen !== bytes.length) isResp = true;
    else if (reqLen === bytes.length && respLen !== bytes.length) isResp = false;
    else {
      const okReq = checkCrc(bytes, reqLen).ok;
      const okResp = checkCrc(bytes, respLen).ok;
      isResp = (okResp && !okReq) ? true : (okReq && !okResp) ? false : false;
    }
  } else if (respFields) isResp = true;
  else if (reqFields) isResp = false;
  else return { ok: false, reason: 'tooShort', length: null };

  const len = isResp ? respLen : reqLen;
  const crcRes = checkCrc(bytes, len);
  const fields = isResp ? respFields : reqFields;
  const data = isResp ? bytes.slice(3, len - 2) : bytes.slice(11, len - 2);

  let desc;
  if (isResp) {
    const regStr = fields.regs.map(r => `${r.hex}=${r.dec}`).join(' ');
    desc = `读写多寄存器响应 · 从站=${h(slave)} 读取=${fields.readByteCount}字节${regStr ? ' · ' + regStr : ''}`;
  } else {
    desc = `读写多寄存器请求 · 从站=${h(slave)} 读起始=${h16(fields.readStart)} 读数量=${fields.readQty} 写起始=${h16(fields.writeStart)} 写数量=${fields.writeQty}`;
  }
  if (!crcRes.ok) return { ok: false, reason: 'badCrc', length: len, crcRx: crcRes.rx, crcCalc: crcRes.calc };
  return {
    ok: true, slave, fc: 0x17, isException: false, data,
    crcRx: crcRes.rx, crcCalc: crcRes.calc, crcOk: true, length: len,
    kind: isResp ? 'response' : 'request', fields, desc,
  };
}

// ===== 入口 =====

/**
 * 从字节流起始位置解析一个 Modbus RTU 帧。
 * @param {Uint8Array} bytes 可能包含多帧的缓冲，从下标 0 解析
 * @returns {object} 成功: {ok:true, slave, fc, ...}; 失败: {ok:false, reason, length?}
 */
export function parseModbusFrame(bytes) {
  if (bytes.length < 5) return { ok: false, reason: 'tooShort', length: null };

  const slave = bytes[0];
  const fc = bytes[1];

  // 异常响应（fc 高位为 1）：5 字节
  if (fc & 0x80) {
    const len = 5;
    const baseFc = fc & 0x7f;
    const exceptionCode = bytes[2];
    const excName = EXC_CODES[exceptionCode] || `未知异常(0x${h(exceptionCode)})`;
    const crcRes = checkCrc(bytes, len);
    if (!crcRes.ok) return { ok: false, reason: 'badCrc', length: len, crcRx: crcRes.rx, crcCalc: crcRes.calc };
    return {
      ok: true, slave, fc, isException: true, baseFc, exceptionCode, exceptionName: excName,
      data: bytes.slice(3, len - 2),
      crcRx: crcRes.rx, crcCalc: crcRes.calc, crcOk: true, length: len, kind: 'exception', fields: {},
      desc: `异常响应 · 从站=${h(slave)} 功能码=${h(baseFc)} · ${excName}`,
    };
  }

  switch (fc) {
    case 0x01: case 0x02: case 0x03: case 0x04:
      return decodeReadFrame(bytes, slave, fc);
    case 0x05: return decodeWriteSingleCoil(bytes, slave);
    case 0x06: return decodeWriteSingleReg(bytes, slave);
    case 0x0f: case 0x10: return decodeWriteMultiple(bytes, slave, fc);
    case 0x16: return decodeMaskWrite(bytes, slave);
    case 0x17: return decodeReadWriteMultiple(bytes, slave);
    default: {
      // 未知功能码：透传工具不判失败，整帧按原始数据 + CRC 校验
      const crcRes = checkCrc(bytes, bytes.length);
      return {
        ok: crcRes.ok, slave, fc, isException: false,
        data: bytes.slice(2, bytes.length - 2),
        crcRx: crcRes.rx, crcCalc: crcRes.calc, crcOk: crcRes.ok,
        length: bytes.length, kind: 'unknown', fields: {},
        desc: `未知功能码(0x${h(fc)}) · 从站=${h(slave)} · ${crcRes.ok ? 'CRC通过' : 'CRC校验失败'}`,
      };
    }
  }
}

/**
 * 解析字节流 → 帧数组。处理拼接的多帧与半帧/错位（按 length 推进，无法判定时逐字节重同步）。
 * @param {Uint8Array} bytes
 * @returns {object[]}
 */
export function parseModbusStream(bytes) {
  const frames = [];
  let i = 0;
  while (i + 5 <= bytes.length) {
    const f = parseModbusFrame(bytes.subarray(i));
    if (f.ok) { frames.push(f); i += f.length; }
    else if (f.length) { frames.push(f); i += f.length; }
    else i += 1;
  }
  return frames;
}
