// main.js — 应用控制器：DOM 接线、日志渲染、自检
import { BLEClient, SimBLEClient, NUS_SERVICE, NUS_RX_WRITE, NUS_TX_NOTIFY } from './ble.js';
import { SimSerialPort, WebSerialPort } from './serial.js';
import { Bridge } from './bridge.js';
import { parseModbusFrame, parseModbusStream, appendCrc } from './modbus.js';
import { bytesToHex, bytesToAscii, timestamp, escapeHTML, concatBytes } from './utils.js';

const MAX_ROWS = 400;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ===== DOM =====
const $ = (id) => document.getElementById(id);
const stBtVal = $('st-bt-val');
const stSerialVal = $('st-serial-val');
const cntTx = $('cnt-tx'), cntRx = $('cnt-rx'), cntFrames = $('cnt-frames');

const fwdTx = $('fwd-tx'), fwdRx = $('fwd-rx'), frameIdle = $('frame-idle');

const btEcho = $('bt-echo'), btScan = $('bt-scan'), btDisconnect = $('bt-disconnect'),
      btDevice = $('bt-device'), btPacket = $('bt-packet'), btWriteDelay = $('bt-write-delay'),
      btNotice = $('bt-notice'),
      btPreset = $('bt-preset'), btAllDevices = $('bt-all-devices'), btAutoUuid = $('bt-auto-uuid'),
      btSvc = $('bt-svc'), btRx = $('bt-rx'), btTx = $('bt-tx'),
      btAutoPacket = $('bt-auto-packet'), btMtuPreset = $('bt-mtu-preset'),
      btAtCmd = $('bt-at-cmd'), btAtSend = $('bt-at-send'), btAtCrlf = $('bt-at-crlf');

const serModeSim = $('ser-mode-sim'), serModeReal = $('ser-mode-real'),
      simControls = $('sim-controls'), realControls = $('real-controls'),
      simInterval = $('sim-interval'), simAuto = $('sim-auto'), simFrame = $('sim-frame'),
      simSend = $('sim-send'), serialBaud = $('serial-baud'),
      serialOpen = $('serial-open'), serialClose = $('serial-close'),
      serialNotice = $('serial-notice');

const showTx = $('show-tx'), showRx = $('show-rx'), autoscroll = $('autoscroll'),
      logPause = $('log-pause'), logClear = $('log-clear'), logSelftest = $('log-selftest'),
      logStats = $('log-stats'), logEl = $('log'), tplRow = $('tpl-row');

// ===== 状态 =====
const bleClient = new BLEClient();          // 真实 BLE 单例
const simSerial = new SimSerialPort();       // 模拟串口单例
let currentBle = bleClient;                  // 当前生效的蓝牙客户端（echo 模式时换为 SimBLEClient）
let serialPort = simSerial;                  // 当前生效的串口
let realSerial = null;                       // 真实串口实例（打开时创建）
let bridge = null;
let paused = false;

const counters = { tx: 0, rx: 0, frames: 0 };

// ===== 工具 =====
function showNotice(el, msg) {
  el.textContent = msg;
  el.classList.remove('hidden');
}
function clearNotice(el) { el.classList.add('hidden'); }
/** 短暂显示提示后自动消失 */
function flashNotice(el, msg, ms = 3000) {
  showNotice(el, msg);
  clearTimeout(el._flashTimer);
  el._flashTimer = setTimeout(() => clearNotice(el), ms);
}

/** 归一化 UUID 输入：去掉 0x、转小写、去空白 */
function normUuid(s) {
  return String(s).trim().toLowerCase().replace(/^0x/, '');
}

/** 常见透传模块 UUID 预设 */
const BT_PRESETS = {
  nus:    { svc: NUS_SERVICE, rx: NUS_RX_WRITE, tx: NUS_TX_NOTIFY },
  i6328a: { svc: 'fff0', rx: 'fff3', tx: 'fff4' },
};

function applyBtPreset() {
  const p = BT_PRESETS[btPreset.value];
  if (!p) return; // 自定义：保留用户输入
  btSvc.value = p.svc;
  btRx.value = p.rx;
  btTx.value = p.tx;
}
btPreset.addEventListener('change', applyBtPreset);

// ===== 状态接线 =====
function wireBle(ble) {
  ble.onStatus = (msg) => {
    stBtVal.textContent = msg;
    stBtVal.className = msg.includes('已连接') ? 'st-on'
      : (msg.includes('失败') || msg.includes('断开')) ? 'st-err' : 'st-off';
  };
  ble.onError = (err) => console.error('[蓝牙]', err);
}
function wireSerial(serial) {
  serial.onStatus = (msg) => {
    stSerialVal.textContent = msg;
    stSerialVal.className = (msg.includes('启动') || msg.includes('打开')) ? 'st-on' : 'st-off';
  };
  serial.onError = (err) => {
    console.error('[串口]', err);
    showNotice(serialNotice, err.message || String(err));
  };
}

function updateBtUI() {
  const connected = currentBle.connected;
  btDisconnect.disabled = !connected;
  btEcho.disabled = connected;
  btAtSend.disabled = !(connected && !btEcho.checked);
  if (connected) {
    btDevice.textContent = currentBle.name === '模拟对端' ? '模拟对端' : (bleClient._device?.name || '已连接设备');
    stBtVal.textContent = currentBle.name === '模拟对端' ? '已连接（模拟对端）' : '已连接';
    stBtVal.className = 'st-on';
  } else {
    stBtVal.textContent = '未连接';
    stBtVal.className = 'st-off';
  }
}

function updateSerialUI() {
  const real = serModeReal.checked;
  simControls.classList.toggle('hidden', real);
  realControls.classList.toggle('hidden', !real);
}

// ===== 桥接 =====
function rebuildBridge() {
  if (bridge) bridge.stop();
  bridge = new Bridge({ ble: currentBle, serial: serialPort });
  bridge.onFrame = handleFrame;
  bridge.start();
  bridge.config.txEnabled = fwdTx.checked;
  bridge.config.rxEnabled = fwdRx.checked;
  bridge.config.idleTimeoutMs = parseInt(frameIdle.value, 10) || 20;
}

// ===== 日志 =====
function handleFrame({ direction, bytes, ts }) {
  appendLog(direction, bytes, new Date(ts));
}

/** 追加一条日志（计数 + 渲染，尊重暂停/显示过滤） */
function appendLog(direction, bytes, date) {
  counters[direction === 'tx' ? 'tx' : 'rx'] += bytes.length;
  counters.frames += 1;
  updateCounters();

  if (paused) return;
  if (direction === 'tx' && !showTx.checked) return;
  if (direction === 'rx' && !showRx.checked) return;

  renderRow(direction, bytes, date);
}

function updateCounters() {
  cntTx.textContent = counters.tx;
  cntRx.textContent = counters.rx;
  cntFrames.textContent = counters.frames;
}

function renderRow(direction, bytes, date) {
  const frag = tplRow.content.cloneNode(true);
  const row = frag.querySelector('.row');
  const isTx = direction === 'tx';

  row.querySelector('.ts').textContent = timestamp(date);
  const dirEl = row.querySelector('.dir');
  dirEl.textContent = isTx ? '发送' : '接收';
  dirEl.classList.add(isTx ? 'tx' : 'rx');
  row.querySelector('.hex').textContent = bytesToHex(bytes);
  row.querySelector('.ascii').textContent = bytesToAscii(bytes);
  row.querySelector('.parse').innerHTML = renderParse(bytes);

  logEl.appendChild(frag);
  while (logEl.children.length > MAX_ROWS) logEl.removeChild(logEl.firstChild);
  if (autoscroll.checked) logEl.scrollTop = logEl.scrollHeight;
}

function renderParse(bytes) {
  const frames = parseModbusStream(bytes);
  if (frames.length === 0) return '<span class="info">无法识别为 Modbus 帧</span>';
  return frames.map((f) => {
    if (f.ok) {
      const cls = f.isException ? 'err' : 'ok';
      return `<span class="${cls}">${escapeHTML('✓ ' + f.desc)}</span>`;
    }
    return `<span class="err">${escapeHTML('✗ ' + failureText(f))}</span>`;
  }).join('<br>');
}

function failureText(f) {
  switch (f.reason) {
    case 'tooShort': return '帧过短，无法识别';
    case 'badCrc':
      return `CRC校验失败（实际 0x${f.crcRx.toString(16).padStart(4, '0')} / 计算 0x${f.crcCalc.toString(16).padStart(4, '0')}）`;
    case 'lengthMismatch':
      return `长度不匹配（期望 ${f.expect} 字节 / 实际 ${f.byteCount} 字节）`;
    default: return `解析失败：${f.reason}`;
  }
}

// ===== 蓝牙控制 =====
btScan.addEventListener('click', async () => {
  clearNotice(btNotice);
  bleClient._lastError = null;
  try {
    if (btEcho.checked) {
      currentBle = new SimBLEClient();
      wireBle(currentBle);
      await currentBle.connect();
    } else {
      if (!('bluetooth' in navigator)) {
        showNotice(btNotice, '当前浏览器不支持 Web Bluetooth，请用 Chrome/Edge 桌面版，通过 localhost 打开页面。');
        return;
      }
      // 扫描前把 UI 里的 UUID / 过滤选项同步进客户端
      bleClient.config.serviceUuid = normUuid(btSvc.value);
      bleClient.config.rxWriteUuid = normUuid(btRx.value);
      bleClient.config.txNotifyUuid = normUuid(btTx.value);
      bleClient.config.includeAllDevices = btAllDevices.checked;
      bleClient.config.autoDetectUuid = btAutoUuid.checked;
      bleClient.config.autoPacketSize = btAutoPacket.checked;
      bleClient.config.mtuPreset = parseInt(btMtuPreset.value, 10) || 23;
      const device = await bleClient.requestDevice();
      btDevice.textContent = device.name || '未知设备';
      await bleClient.connect(device);
      currentBle = bleClient;
      const det = bleClient._detected;
      if (det) {
        btSvc.value = det.service;
        btRx.value = det.rx;
        btTx.value = det.tx;
        showNotice(btNotice, `已自动识别 UUID：服务 ${det.service}，写 ${det.rx}，通知 ${det.tx}，已填入并生效`);
      }
    }
    rebuildBridge();
    updateBtUI();
  } catch (err) {
    const msg = bleClient._lastError || err?.message;
    const isCancel = err?.name === 'NotFoundError' && !bleClient._lastError; // 用户取消扫描
    if (msg && !isCancel) showNotice(btNotice, `连接失败：${msg}`);
    updateBtUI();
  }
});

btDisconnect.addEventListener('click', async () => {
  await currentBle.close();
  updateBtUI();
});

btEcho.addEventListener('change', () => {
  if (btEcho.checked) {
    currentBle = new SimBLEClient();
    wireBle(currentBle);
    rebuildBridge();
  } else {
    currentBle = bleClient;
    wireBle(bleClient);
    rebuildBridge();
  }
});

btPacket.addEventListener('change', () => {
  if (!btAutoPacket.checked) bleClient.config.packetSize = parseInt(btPacket.value, 10) || 20;
});
btWriteDelay.addEventListener('change', () => {
  bleClient.config.interChunkDelayMs = parseInt(btWriteDelay.value, 10) || 5;
});
function syncAutoPacketUI() {
  const auto = btAutoPacket.checked;
  btPacket.disabled = auto;
  bleClient.config.autoPacketSize = auto;
  if (auto) {
    const mtu = parseInt(btMtuPreset.value, 10) || 23;
    bleClient.config.mtuPreset = mtu;
    bleClient.config.packetSize = mtu - 3;
    btPacket.value = String(mtu - 3);
  }
}
btAutoPacket.addEventListener('change', syncAutoPacketUI);
btMtuPreset.addEventListener('change', () => {
  bleClient.config.mtuPreset = parseInt(btMtuPreset.value, 10) || 23;
  syncAutoPacketUI();
});

// ===== 发送 AT 指令（直接写到 BLE 发送特征，不经 485 桥）=====
btAtSend.addEventListener('click', async () => {
  clearNotice(btNotice);
  if (btEcho.checked || !currentBle.connected) {
    showNotice(btNotice, '请取消「模拟对端」并连接真实蓝牙设备后再发送 AT');
    return;
  }
  const text = btAtCmd.value;
  if (!text) return;
  let data = new TextEncoder().encode(text);
  if (btAtCrlf.checked) data = concatBytes(data, new Uint8Array([0x0d, 0x0a]));
  try {
    await currentBle.send(data);
    appendLog('tx', data, new Date());
    flashNotice(btNotice, `已发送：${text}${btAtCrlf.checked ? ' \\r\\n' : ''}`);
  } catch (err) {
    showNotice(btNotice, err.message || '发送失败');
  }
});
btAtCmd.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); btAtSend.click(); }
});

// ===== 串口控制 =====
serModeSim.addEventListener('change', async () => {
  updateSerialUI();
  if (!serModeReal.checked) await switchToSim();
});
serModeReal.addEventListener('change', async () => {
  if (!WebSerialPort.isSupported()) {
    showNotice(serialNotice, '当前浏览器不支持 Web Serial，请用 Chrome/Edge 桌面版。');
    serModeSim.checked = true;
    updateSerialUI();
    return;
  }
  updateSerialUI();
  await switchToReal();
});

async function switchToSim() {
  clearNotice(serialNotice);
  if (realSerial?.isOpen) { await realSerial.close(); realSerial = null; }
  serialPort = simSerial;
  wireSerial(simSerial);
  await simSerial.open();
  rebuildBridge();
  updateBtUI();
}

async function switchToReal() {
  clearNotice(serialNotice);
  serialPort = simSerial; // 未打开真实串口前保持模拟
  rebuildBridge();
}

serialOpen.addEventListener('click', async () => {
  clearNotice(serialNotice);
  try {
    realSerial = new WebSerialPort();
    wireSerial(realSerial);
    await realSerial.open({ baudRate: parseInt(serialBaud.value, 10) || 9600 });
    serialPort = realSerial;
    serialClose.disabled = false;
    rebuildBridge();
  } catch (err) {
    if (err?.name === 'NotFoundError') return; // 用户取消选择
    realSerial = null;
    serialClose.disabled = true;
    showNotice(serialNotice, err.message || String(err));
  }
});

serialClose.addEventListener('click', async () => {
  if (realSerial) { await realSerial.close(); realSerial = null; }
  serialClose.disabled = true;
  await switchToSim();
});

simSend.addEventListener('click', () => simSerial.sendTestFrame());
simFrame.addEventListener('input', () => {
  // 边输入边应用：完整帧立即生效；输入中途非法则静默保留旧帧
  simSerial.config.frameHex = simFrame.value;
  simSerial.parseFrame(false);
});
simFrame.addEventListener('change', () => {
  // 失焦 / 回车：对最终值做校验，非法时给出提示
  simSerial.config.frameHex = simFrame.value;
  simSerial.parseFrame();
});
simInterval.addEventListener('change', () => {
  simSerial.config.intervalMs = parseInt(simInterval.value, 10) || 1000;
  if (simSerial.isOpen && simSerial.config.auto) simSerial.startAuto();
});
simAuto.addEventListener('change', () => {
  simSerial.config.auto = simAuto.checked;
  if (simAuto.checked) simSerial.startAuto(); else simSerial.stopAuto();
});

// ===== 桥接控制 =====
fwdTx.addEventListener('change', () => { bridge.config.txEnabled = fwdTx.checked; });
fwdRx.addEventListener('change', () => { bridge.config.rxEnabled = fwdRx.checked; });
frameIdle.addEventListener('change', () => {
  bridge.config.idleTimeoutMs = parseInt(frameIdle.value, 10) || 20;
});

// ===== 日志控制 =====
logPause.addEventListener('click', () => {
  paused = !paused;
  logPause.textContent = paused ? '继续' : '暂停';
});
logClear.addEventListener('click', () => { logEl.innerHTML = ''; });

showTx.addEventListener('change', () => { /* 渲染时即时过滤 */ });
showRx.addEventListener('change', () => { /* 渲染时即时过滤 */ });

// ===== 自检 =====
logSelftest.addEventListener('click', runSelfTest);

async function runSelfTest() {
  const results = [];
  const push = (name, pass, detail = '') => results.push({ name, pass, detail });

  // 1 CRC 校验点
  try {
    const crc = appendCrc([0x01, 0x03, 0x00, 0x00, 0x00, 0x01]);
    push('CRC16 校验点', crc.length === 8 && bytesToHex(crc, '') === '010300000001840A', bytesToHex(crc));
  } catch (e) { push('CRC16 校验点', false, e.message); }

  const req = appendCrc([0x01, 0x03, 0x00, 0x00, 0x00, 0x01]);
  const resp = appendCrc([0x01, 0x03, 0x02, 0x00, 0x0A]);

  // 2 读保持寄存器请求
  const r = parseModbusFrame(req);
  push('读保持寄存器请求', r.ok && r.slave === 1 && r.fc === 3 && r.kind === 'request' && r.crcOk && r.fields.start === 0 && r.fields.qty === 1, r.desc);

  // 3 读保持寄存器响应
  const r2 = parseModbusFrame(resp);
  push('读保持寄存器响应', r2.ok && r2.kind === 'response' && r2.fields.regs?.length === 1 && r2.fields.regs[0].dec === 10, r2.desc);

  // 4 异常帧
  const exc = parseModbusFrame(appendCrc([0x01, 0x83, 0x02]));
  push('异常帧识别', exc.ok && exc.isException && exc.baseFc === 3 && exc.exceptionName === '非法数据地址', exc.desc);

  // 5 坏 CRC
  const bad = new Uint8Array(req); bad[bad.length - 1] ^= 0xff;
  const r4 = parseModbusFrame(bad);
  push('坏 CRC 识别', !r4.ok && r4.reason === 'badCrc' && r4.length === 8, `${r4.reason} · length=${r4.length}`);

  // 6 写多寄存器
  const wm = parseModbusFrame(appendCrc([0x01, 0x10, 0x00, 0x00, 0x00, 0x02, 0x04, 0x00, 0x0A, 0x00, 0x14]));
  push('写多寄存器请求', wm.ok && wm.fields.qty === 2 && wm.fields.byteCount === 4, wm.desc);

  // 7 拼接流
  const frames = parseModbusStream(concatBytes(req, resp));
  push('拼接流解析', frames.length === 2 && frames[0].ok && frames[1].ok, `${frames.length} 帧`);

  // 8 端到端环回
  const e2e = await runEchoTest(req);
  push('端到端环回', e2e.pass, e2e.detail);

  // 9 方向门控
  const gating = await runGatingTest(req);
  push('方向转发门控', gating.pass, gating.detail);

  renderSelfTest(results);
}

async function runEchoTest(req) {
  const serial = new SimSerialPort({ intervalMs: 0, auto: false, frameHex: bytesToHex(req) });
  const ble = new SimBLEClient({ echo: true, echoDelayMs: 10 });
  const bridge = new Bridge({ ble, serial, config: { idleTimeoutMs: 5 } });
  const got = [];
  bridge.onFrame = ({ direction, bytes }) => got.push({ direction, bytes: new Uint8Array(bytes) });
  await ble.connect();
  bridge.start();
  await serial.open();
  serial.sendTestFrame();
  await sleep(80);
  bridge.stop();

  const tx = got.find((g) => g.direction === 'tx');
  const rx = got.find((g) => g.direction === 'rx');
  const eq = (a, b) => !!a && !!b && a.length === b.length && a.every((v, i) => v === b[i]);
  const pass = eq(tx?.bytes, req) && eq(rx?.bytes, req)
    && parseModbusFrame(tx.bytes).crcOk && parseModbusFrame(rx.bytes).crcOk;
  return { pass, detail: `TX=${tx ? bytesToHex(tx.bytes) : '无'} · RX=${rx ? bytesToHex(rx.bytes) : '无'}` };
}

async function runGatingTest(req) {
  const serial = new SimSerialPort({ intervalMs: 0, auto: false, frameHex: bytesToHex(req) });
  let forwarded = 0;
  serial.send = () => { forwarded++; };
  const ble = new SimBLEClient({ echo: true, echoDelayMs: 10 });
  const bridge = new Bridge({ ble, serial, config: { idleTimeoutMs: 5 } });
  bridge.config.rxEnabled = false;
  const got = [];
  bridge.onFrame = ({ direction }) => got.push(direction);
  await ble.connect();
  bridge.start();
  await serial.open();
  serial.sendTestFrame();
  await sleep(80);
  bridge.stop();
  return {
    pass: forwarded === 0 && got.includes('rx'),
    detail: `转发到串口=${forwarded} 次 · 日志方向=${got.join(',') || '无'}`,
  };
}

function renderSelfTest(results) {
  logEl.innerHTML = '';
  const passed = results.filter((r) => r.pass).length;
  const head = document.createElement('div');
  head.className = 'selftest';
  head.innerHTML = `<b>自检：${passed}/${results.length} 通过</b>`;
  logEl.appendChild(head);
  for (const r of results) {
    const div = document.createElement('div');
    div.className = 'selftest';
    div.innerHTML = `<span class="${r.pass ? 'pass' : 'fail'}">${r.pass ? '✓' : '✗'} ${escapeHTML(r.name)}</span>`
      + (r.detail ? ` — <span class="muted">${escapeHTML(r.detail)}</span>` : '');
    logEl.appendChild(div);
  }
  logStats.textContent = `自检 ${passed}/${results.length} 通过`;
}

// ===== 初始化 =====
async function init() {
  wireBle(bleClient);
  wireSerial(simSerial);
  await simSerial.open();
  rebuildBridge();
  updateBtUI();
  updateSerialUI();

  if (!('bluetooth' in navigator)) {
    showNotice(btNotice, '当前浏览器不支持 Web Bluetooth。请用 Chrome/Edge 桌面版并通过 localhost 打开；模拟对端 (Echo) 与模拟串口不受影响。');
    btScan.disabled = true;
    btPacket.disabled = true;
    btWriteDelay.disabled = true;
    btPreset.disabled = true;
    btAllDevices.disabled = true;
    btAutoUuid.disabled = true;
    btSvc.disabled = true;
    btRx.disabled = true;
    btTx.disabled = true;
    btAutoPacket.disabled = true;
    btMtuPreset.disabled = true;
    btAtCmd.disabled = true;
    btAtSend.disabled = true;
  }
}

init();
