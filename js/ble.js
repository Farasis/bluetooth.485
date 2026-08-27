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
    this.config = {
      serviceUuid: NUS_SERVICE,      // GATT 服务 UUID
      rxWriteUuid: NUS_RX_WRITE,     // app → device（写特征）
      txNotifyUuid: NUS_TX_NOTIFY,   // device → app（通知特征）
      includeAllDevices: false,      // true 时扫描全部设备（需 optionalServices）
      packetSize: 20,                // 写分包大小（默认 MTU 安全值）
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
    if (this.config.includeAllDevices) {
      return navigator.bluetooth.requestDevice({
        acceptAllDevices: true,
        optionalServices: [this.config.serviceUuid],
      });
    }
    return navigator.bluetooth.requestDevice({
      filters: [{ services: [this.config.serviceUuid] }],
    });
  }

  async connect(device) {
    if (this._connecting) return;
    if (this.connected) return;
    if (!device) throw new Error('未选择设备');
    this._connecting = true;
    this._device = device;
    try {
      this._server = await device.gatt.connect();
      device.ongattserverdisconnected = () => this._onDisconnected();

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
    const size = Math.max(1, Math.min(512, this.config.packetSize | 0) || 20);
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
