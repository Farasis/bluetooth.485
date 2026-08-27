// bridge.js — 双向转发 + 按空闲超时组帧
//
// 数据流：
//   TX（发送）串口/485 → 蓝牙   （serial.onData → ble.send）
//   RX（接收）蓝牙 → 串口/485   （ble.onData → serial.send）
// 转发是即时的（不等待组帧）；组帧仅用于日志显示与 Modbus 解析。

import { concatBytes } from './utils.js';

export class Bridge {
  constructor({ ble, serial, config = {} } = {}) {
    this.ble = ble;
    this.serial = serial;
    this.config = {
      txEnabled: config.txEnabled ?? true,     // 串口→蓝牙 转发开关
      rxEnabled: config.rxEnabled ?? true,     // 蓝牙→串口 转发开关
      idleTimeoutMs: config.idleTimeoutMs ?? 20, // 帧空闲超时
      maxFrameBytes: config.maxFrameBytes ?? 4096,
    };
    // 每方向独立的组帧缓冲与定时器
    this._buf = { tx: { bytes: new Uint8Array(0), timer: null, startTs: null } };
    this._buf.rx = { bytes: new Uint8Array(0), timer: null, startTs: null };
    this.onFrame = () => {};
  }

  start() {
    this.serial.onData = (b) => this._in('tx', b); // 串口→蓝牙 → 发送
    this.ble.onData = (b) => this._in('rx', b);    // 蓝牙→串口 → 接收
  }

  stop() {
    this.serial.onData = () => {};
    this.ble.onData = () => {};
    this._flush('tx');
    this._flush('rx');
  }

  _in(dir, bytes) {
    // 1) 转发（即时，不等待组帧）；仅在对方已连接/打开时执行
    if (dir === 'tx' && this.config.txEnabled && this.ble.connected) {
      this.ble.send(bytes).catch((err) => this._err(err));
    } else if (dir === 'rx' && this.config.rxEnabled && this.serial.isOpen) {
      this.serial.send(bytes);
    }

    // 2) 组帧（供日志/解析）
    this._append(dir, bytes);
  }

  _append(dir, bytes) {
    const slot = this._buf[dir];
    slot.bytes = concatBytes(slot.bytes, bytes);
    if (slot.startTs === null) slot.startTs = Date.now();

    if (slot.bytes.length >= this.config.maxFrameBytes) {
      this._flush(dir); // 连续大流量保护：强制成帧
      return;
    }
    if (slot.timer) clearTimeout(slot.timer);
    slot.timer = setTimeout(() => this._flush(dir), this.config.idleTimeoutMs);
  }

  _flush(dir) {
    const slot = this._buf[dir];
    if (slot.timer) { clearTimeout(slot.timer); slot.timer = null; }
    if (slot.bytes.length > 0) {
      const bytes = slot.bytes;
      const ts = slot.startTs;
      slot.bytes = new Uint8Array(0);
      slot.startTs = null;
      this.onFrame({ direction: dir, bytes, ts });
    }
  }

  _err(e) {
    if (this.ble.onError) this.ble.onError(e);
  }
}
