// serial.js — 串口连接层
// 提供两个实现同一接口的类：
//   SimSerialPort —— 模拟 485 串口（周期生成测试帧），默认模式
//   WebSerialPort  —— 真实 USB转485（Web Serial API），预留硬件接入
//
// 接口：{ name, isOpen, isSupported(), open(cfg), close(), send(bytes),
//         onData(bytes), onStatus(msg), onError(err) }
//  onData = 串口 → 应用 的数据流（应用把数据转发给蓝牙）
//  send   = 应用 → 串口（应用把蓝牙收到的数据转发给 485）

import { hexToBytes } from './utils.js';

export class SimSerialPort {
  constructor(config = {}) {
    this.name = '模拟串口';
    this.isOpen = false;
    this.config = {
      intervalMs: config.intervalMs ?? 1000,
      frameHex: config.frameHex ?? '01 03 00 00 00 01 84 0A',
      auto: config.auto ?? true,
      echo: config.echo ?? false,   // 串口回环：send 后延时回显（模拟 485 从站）
    };
    this._frameBytes = null;
    this._timer = null;
    this._seq = 0;
    this.onData = () => {};
    this.onStatus = () => {};
    this.onError = () => {};
  }

  static isSupported() { return true; }

  async open() {
    this.parseFrame();
    if (this.config.auto) this.startAuto();
    this.isOpen = true;
    this.onStatus('模拟串口已启动');
  }

  async close() {
    this.stopAuto();
    this.isOpen = false;
    this.onStatus('模拟串口已停止');
  }

  /** 开始/重启自动周期发送 */
  startAuto() {
    this._startTimer();
  }

  /** 停止自动周期发送 */
  stopAuto() {
    this._clearTimer();
  }

  /**
   * 解析当前测试帧并更新内部帧数据。
   * @param {boolean} [notify=true] 非法时是否触发 onError 提示
   * @returns {Uint8Array} 生效的帧字节
   */
  parseFrame(notify = true) {
    try {
      const bytes = hexToBytes(this.config.frameHex);
      if (bytes.length === 0) throw new Error('测试帧不能为空');
      this._frameBytes = bytes;
      return bytes;
    } catch (e) {
      if (notify) this.onError(new Error(`测试帧非法：${e.message}`));
      if (!this._frameBytes) this._frameBytes = new Uint8Array(0);
      return this._frameBytes;
    }
  }

  /** 手动发送一帧（不依赖自动周期） */
  sendTestFrame() {
    if (this._frameBytes && this._frameBytes.length > 0) {
      this.onData(new Uint8Array(this._frameBytes));
    }
  }

  /** 蓝牙 → 485 方向：模拟串口默认仅记录；开启 echo 则回显 */
  send(bytes) {
    if (!this.isOpen) return;
    if (this.config.echo) {
      setTimeout(() => { this.onData(new Uint8Array(bytes)); }, 20);
    }
  }

  _startTimer() {
    this._clearTimer();
    const ms = Math.max(10, this.config.intervalMs | 0);
    this._timer = setInterval(() => this.sendTestFrame(), ms);
  }

  _clearTimer() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
  }
}

// ===== 真实串口（Web Serial API）=====

export class WebSerialPort {
  constructor() {
    this.name = '真实串口';
    this.isOpen = false;
    this._port = null;
    this._reader = null;
    this._reading = false;
    this.onData = () => {};
    this.onStatus = () => {};
    this.onError = () => {};
  }

  static isSupported() { return 'serial' in navigator; }

  /**
   * 打开串口。必须在用户手势中调用（requestPort 会弹系统选择框）。
   * @param {{baudRate:number, dataBits?:number, stopBits?:number, parity?:string}} cfg
   */
  async open(cfg = {}) {
    if (!WebSerialPort.isSupported()) {
      throw new Error('当前浏览器不支持 Web Serial，请用 Chrome/Edge 桌面版');
    }
    const port = await navigator.serial.requestPort();
    await port.open({
      baudRate: cfg.baudRate ?? 9600,
      dataBits: cfg.dataBits ?? 8,
      stopBits: cfg.stopBits ?? 1,
      parity: cfg.parity ?? 'none',
      flowControl: 'none',
    });
    this._port = port;
    this.isOpen = true;
    this.onStatus(`串口已打开：${this._portLabel()}`);
    this._readLoop();
  }

  _portLabel() {
    try {
      const info = this._port.getInfo?.() || {};
      const parts = [info.usbVendorId, info.usbProductId].filter(Boolean);
      return parts.length ? `USB VID:${parts[0].toString(16)} PID:${parts[1].toString(16)}` : '未知端口';
    } catch (_) { return '未知端口'; }
  }

  async _readLoop() {
    this._reading = true;
    try {
      this._reader = this._port.readable.getReader();
      while (this._reading) {
        const { value, done } = await this._reader.read();
        if (done) break;
        if (value && value.length) this.onData(new Uint8Array(value));
      }
    } catch (err) {
      if (this._reading) { // 非主动关闭，视为拔线/错误
        this.onError(new Error(`串口读失败：${err.message || err}`));
      }
    } finally {
      this._reading = false;
      if (this._reader) {
        try { this._reader.releaseLock(); } catch (_) { /* ignore */ }
        this._reader = null;
      }
    }
  }

  /** 应用 → 串口 */
  async send(bytes) {
    if (!this.isOpen || !this._port) return;
    try {
      const writer = this._port.writable.getWriter();
      try {
        await writer.write(bytes);
      } finally {
        try { writer.releaseLock(); } catch (_) { /* ignore */ }
      }
    } catch (err) {
      this.onError(new Error(`串口写失败：${err.message || err}`));
    }
  }

  async close() {
    this._reading = false;
    if (this._reader) {
      try { await this._reader.cancel(); } catch (err) {
        if (err && err.name !== 'AbortError') { /* 忽略取消错误 */ }
      }
      try { this._reader.releaseLock(); } catch (_) { /* ignore */ }
      this._reader = null;
    }
    if (this._port) {
      try { await this._port.close(); } catch (_) { /* ignore */ }
      this._port = null;
    }
    this.isOpen = false;
    this.onStatus('串口已关闭');
  }
}
