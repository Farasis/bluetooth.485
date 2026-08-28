// ble.js — 蓝牙连接层
// 提供两个实现同一接口的类：
//   BLEClient   —— 真实 BLE 透传（默认 Nordic UART Service / NUS，服务/特征 UUID 可配置，
//                  例如 I6328A/VG6328A 模块用 FFF0/FFF3/FFF4）
//   SimBLEClient —— 模拟对端（Echo）：收到的数据原样回显，无硬件时验证完整链路
//
// 接口：{ name, connected, isSupported(), connect(), close(), send(bytes),
//         onData(bytes), onStatus(msg), onError(err) }
//  onData = 设备 → 应用 的通知流（应用把数据转发给 485/串口）
//  send   = 应用 → 设备（应用把 485 收到的数据转发给蓝牙）

export const NUS_SERVICE = '6e400001-b5a3-f393-e0a9-e50e24dcca9e'; // Nordic UART Service
export const NUS_RX_WRITE = '6e400002-b5a3-f393-e0a9-e50e24dcca9e'; // app → device（写）
export const NUS_TX_NOTIFY = '6e400003-b5a3-f393-e0a9-e50e24dcca9e'; // device → app（通知）

/** 常见 UART 透传服务 UUID（自动识别时的候选，按优先级排列） */
export const UART_CANDIDATES = [
  NUS_SERVICE,
  '0000fff0-0000-1000-8000-00805f9b34fb', // I6328A 等：FFF3 写 / FFF4 通知
  '0000ffe0-0000-1000-8000-00805f9b34fb', // 常见：FFE1 兼具写+通知
  '0000ffb0-0000-1000-8000-00805f9b34fb', // 常见：FFB2/FFB3
  '0000ff00-0000-1000-8000-00805f9b34fb', // 常见
];

/** UUID 简写：128 位标准 UUID 转 4 位短形式（0000fff0-… → fff0） */
function shortUuid(uuid) {
  const m = String(uuid).toLowerCase().match(/0000([0-9a-f]{4})-0000-1000-8000-00805f9b34fb$/);
  return m ? m[1] : String(uuid);
}

/** DataView → 只读对应区间的 Uint8Array（DataView 可能指向更大的 ArrayBuffer） */
function toUint8(dv) {
  return new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength);
}

export class BLEClient {
  constructor() {
    this.name = 'BLE';
    this.connected = false;
    this._device = null;
    this._server = null;
    this._service = null;
    this._rxChar = null;
    this._txChar = null;
    this._connecting = false;
    this._detected = null;           // 自动识别到的 UUID（成功后供界面回填）
    this._lastError = null;          // 最近一次连接失败原因（供界面显示）
    this.config = {
      serviceUuid: NUS_SERVICE,      // GATT 服务 UUID
      rxWriteUuid: NUS_RX_WRITE,     // app → device（写特征）
      txNotifyUuid: NUS_TX_NOTIFY,   // device → app（通知特征）
      includeAllDevices: false,      // true 时扫描全部设备（需 optionalServices）
      autoDetectUuid: false,         // true 时连接后自动枚举写/通知特征
      packetSize: 20,                // 手动写分包大小（默认 MTU 安全值）
      autoPacketSize: false,         // true 时按 mtuPreset 自动分包（MTU-3）
      mtuPreset: 23,                 // 模块支持的 ATT MTU（23/247/512 等）
      interChunkDelayMs: 5,          // 分包间隔，WriteWithoutResponse 时是唯一背压
    };
    this.onData = () => {};
    this.onStatus = () => {};
    this.onError = () => {};
  }

  static isSupported() { return 'bluetooth' in navigator; }

  /**
   * 扫描设备（须在用户点击手势内调用）。返回选中的 BluetoothDevice。
   */
  async requestDevice() {
    if (!BLEClient.isSupported()) {
      throw new Error('当前浏览器不支持 Web Bluetooth，请用 Chrome/Edge 桌面版');
    }
    const svc = this.config.serviceUuid;
    if (this.config.includeAllDevices || this.config.autoDetectUuid || !svc) {
      // 自动识别时放行所有候选 UART 服务，连接后逐一枚举
      const opts = new Set([svc, ...UART_CANDIDATES].filter(Boolean));
      return navigator.bluetooth.requestDevice({
        acceptAllDevices: true,
        optionalServices: [...opts],
      });
    }
    return navigator.bluetooth.requestDevice({
      filters: [{ services: [svc] }],
    });
  }

  /**
   * 自动识别数据通道：枚举可访问的服务，找出带写+通知特征的服务。
   * 优先选择已知 UART 服务；单一特征兼具写+通知时（如 FFE1）复用它。
   * @returns {Promise<{service:string, rx:string, tx:string}|null>}
   */
  async _detectUart() {
    let services;
    try {
      services = await this._server.getPrimaryServices();
    } catch (_) { return null; }
    if (!services || services.length === 0) return null;

    // 已知 UART 服务优先
    const rank = new Map(UART_CANDIDATES.map((u, i) => [u.toLowerCase(), i]));
    services.sort((a, b) => {
      const ai = rank.get(a.uuid.toLowerCase());
      const bi = rank.get(b.uuid.toLowerCase());
      return (ai ?? 999) - (bi ?? 999);
    });

    for (const s of services) {
      let chars;
      try { chars = await s.getCharacteristics(); } catch (_) { continue; }
      let writeChar = null, notifyChar = null;
      for (const c of chars) {
        const p = c.properties;
        const canWrite = p.write || p.writeWithoutResponse;
        const canNotify = p.notify || p.indicate;
        if (canWrite && canNotify) return { service: s.uuid, rx: c.uuid, tx: c.uuid };
        if (canWrite && !writeChar) writeChar = c;
        if (canNotify && !notifyChar) notifyChar = c;
      }
      if (writeChar && notifyChar) {
        return { service: s.uuid, rx: writeChar.uuid, tx: notifyChar.uuid };
      }
    }
    return null;
  }

  async connect(device) {
    if (this._connecting) return;
    if (this.connected) return;
    if (!device) throw new Error('未选择设备');
    this._connecting = true;
    this._device = device;
    this._detected = null;
    this._lastError = null;
    try {
      this._server = await device.gatt.connect();
      device.ongattserverdisconnected = () => this._onDisconnected();

      // 自动识别 UUID：枚举服务，找出带写/通知特征的数据通道
      if (this.config.autoDetectUuid) {
        const found = await this._detectUart();
        if (found) {
          this.config.serviceUuid = found.service;
          this.config.rxWriteUuid = found.rx;
          this.config.txNotifyUuid = found.tx;
          this._detected = found;
          this.onStatus(`已自动识别：服务 ${shortUuid(found.service)}，写 ${shortUuid(found.rx)}，通知 ${shortUuid(found.tx)}`);
        } else {
          throw new Error('未找到带写/通知特征的数据服务，请用 nRF Connect 查看真实 UUID 后手动填写');
        }
      }

      this._service = await this._server.getPrimaryService(this.config.serviceUuid);
      this._rxChar = await this._service.getCharacteristic(this.config.rxWriteUuid);
      this._txChar = await this._service.getCharacteristic(this.config.txNotifyUuid);

      await this._txChar.startNotifications();
      this._charChangedHandler = (e) => this.onData(toUint8(e.target.value));
      this._txChar.addEventListener('characteristicvaluechanged', this._charChangedHandler);

      this.connected = true;
      this.onStatus(`已连接：${device.name || '未知设备'}`);
    } catch (err) {
      this._cleanup();
      this._lastError = err.message || String(err);
      if (err.name === 'NotFoundError') {
        this.onStatus(`设备不提供服务 ${this.config.serviceUuid}`);
      } else {
        this.onError(err);
        this.onStatus(`连接失败：${err.message || err}`);
      }
      throw err;
    } finally {
      this._connecting = false;
    }
  }

  /**
   * 发送数据到蓝牙设备（按 packetSize 分包）。
   * @param {Uint8Array} bytes
   */
  async send(bytes) {
    if (!this.connected || !this._rxChar) throw new Error('蓝牙未连接');
    // 自动分包：单包 = MTU - 3；否则用手动写包大小
    const autoSize = this.config.autoPacketSize ? Math.max(1, (this.config.mtuPreset || 23) - 3) : 0;
    const size = autoSize || (Math.max(1, Math.min(512, this.config.packetSize | 0) || 20));
    const delay = Math.max(0, Math.min(500, this.config.interChunkDelayMs | 0) || 0);
    for (let i = 0; i < bytes.length; i += size) {
      if (!this.connected) return; // close() 中途中止
      const chunk = bytes.slice(i, i + size);
      if (this._rxChar.properties.writeWithoutResponse) {
        await this._rxChar.writeValueWithoutResponse(chunk);
      } else if (this._rxChar.properties.write) {
        await this._rxChar.writeValueWithResponse(chunk);
      } else {
        throw new Error('该设备 RX 特征不支持写入');
      }
      if (delay > 0 && i + size < bytes.length) {
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }

  async close() {
    const device = this._device;
    this._cleanup();
    if (device && device.gatt.connected) {
      try { device.gatt.disconnect(); } catch (_) { /* 忽略 */ }
    }
    this.onStatus('已断开');
  }

  _onDisconnected() {
    const wasConnected = this.connected;
    this._cleanup();
    if (wasConnected) {
      this.onStatus('设备已断开');
      this.onError(new Error('连接已断开'));
    }
  }

  _cleanup() {
    if (this._txChar && this._charChangedHandler) {
      try {
        this._txChar.removeEventListener('characteristicvaluechanged', this._charChangedHandler);
      } catch (_) { /* ignore */ }
    }
    this._charChangedHandler = null;
    this._txChar = null;
    this._service = null;
    this._rxChar = null;
    this._server = null;
    this.connected = false;
  }
}

// ===== 模拟对端 (Echo) =====

export class SimBLEClient {
  constructor(config = {}) {
    this.name = '模拟对端';
    this.connected = false;
    this.config = {
      echo: config.echo !== false,
      echoDelayMs: config.echoDelayMs ?? 20,
    };
    this.onData = () => {};
    this.onStatus = () => {};
    this.onError = () => {};
  }

  static isSupported() { return true; }

  async connect() {
    this.connected = true;
    this.onStatus('已连接（模拟对端）');
  }

  async close() {
    this.connected = false;
    this.onStatus('模拟对端已断开');
  }

  async send(bytes) {
    if (!this.connected) throw new Error('模拟对端未连接');
    if (this.config.echo) {
      // 原样回显 → 形成 模拟串口 → 桥 → 模拟蓝牙 → 桥 → 日志 的完整环回
      setTimeout(() => { this.onData(new Uint8Array(bytes)); }, this.config.echoDelayMs);
    } else {
      this.onStatus(`模拟对端收到 ${bytes.length} 字节（未回显）`);
    }
  }
}
