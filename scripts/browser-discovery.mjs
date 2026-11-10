// 浏览器 CDP 端口发现 + 选择 - 单一职责模块
// 被 check-deps.mjs 和 cdp-proxy.mjs 共享。
//
// 选择规则（resolution）：
//   0. config.env 里有 WEB_ACCESS_PORT → 只认这个端口：探测成功即 ok，失败即硬错
//   1. 调用方传入 override 参数（来自命令行 --browser） → 严格模式，找不到则硬错
//   2. config.env 里 WEB_ACCESS_BROWSER 设了 → 严格模式，找不到则硬错
//   3. 都没设 → "ask" 模式，提示调用方询问用户
//
// 不擅自降级：偏好不可用一律硬错，让用户介入。
// 持久态只有 config.env 一处；override 是单次 spawn 通过命令行参数表达，不读 process.env。
//
// 「可用」= CDP 真能附加，不等于 TCP 能连上。Chrome 会拒绝没写进
// --remote-allow-origins 的所有握手来源（实测：任意 Origin 一律 403，不带 Origin
// 直接掐断），而端口照样在听。只探 TCP 会把这种「活着但拒绝调试」的浏览器判成健康，
// 于是每次连接都失败、兜底扫描也反复选中同一个端口，用户看到的就只剩「连不上浏览器」。
// 所以存活判定必须打到 /json/version 并验回包，理由原文还要留给上层报错。

import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SKILL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_PATH = path.join(SKILL_ROOT, 'config.env');

// 已知支持 chrome://inspect#remote-debugging toggle 的浏览器
// 加新浏览器：只改这里
export function knownBrowsers() {
  const home = os.homedir();
  const localAppData = process.env.LOCALAPPDATA || '';
  switch (os.platform()) {
    case 'darwin':
      return [
        { id: 'chrome',        label: 'Chrome',         devToolsPath: path.join(home, 'Library/Application Support/Google/Chrome/DevToolsActivePort') },
        { id: 'chrome-canary', label: 'Chrome Canary',  devToolsPath: path.join(home, 'Library/Application Support/Google/Chrome Canary/DevToolsActivePort') },
        { id: 'chromium',      label: 'Chromium',       devToolsPath: path.join(home, 'Library/Application Support/Chromium/DevToolsActivePort') },
        { id: 'edge',          label: 'Microsoft Edge', devToolsPath: path.join(home, 'Library/Application Support/Microsoft Edge/DevToolsActivePort') },
      ];
    case 'linux':
      return [
        { id: 'chrome',   label: 'Chrome',         devToolsPath: path.join(home, '.config/google-chrome/DevToolsActivePort') },
        { id: 'chromium', label: 'Chromium',       devToolsPath: path.join(home, '.config/chromium/DevToolsActivePort') },
        { id: 'edge',     label: 'Microsoft Edge', devToolsPath: path.join(home, '.config/microsoft-edge/DevToolsActivePort') },
      ];
    case 'win32':
      return [
        { id: 'chrome',   label: 'Chrome',         devToolsPath: path.join(localAppData, 'Google/Chrome/User Data/DevToolsActivePort') },
        { id: 'chromium', label: 'Chromium',       devToolsPath: path.join(localAppData, 'Chromium/User Data/DevToolsActivePort') },
        { id: 'edge',     label: 'Microsoft Edge', devToolsPath: path.join(localAppData, 'Microsoft/Edge/User Data/DevToolsActivePort') },
      ];
    default:
      return [];
  }
}

// TCP 端口探测 —— 只当作 /json/version 之前的快速预筛，不能单独判定「可连」
// （用 TCP 而非 WebSocket 预筛仍然成立：这里刻意不建 WS 连接，避免触发授权弹窗）
export function checkPort(port, host = '127.0.0.1', timeoutMs = 2000) {
  return new Promise((resolve) => {
    const socket = net.createConnection(port, host);
    const timer = setTimeout(() => { socket.destroy(); resolve(false); }, timeoutMs);
    socket.once('connect', () => { clearTimeout(timer); socket.destroy(); resolve(true); });
    socket.once('error',   () => { clearTimeout(timer); resolve(false); });
  });
}

// 读 config.env 文件（不写入 process.env，分清来源）
// 格式：KEY=VALUE，# 开头是注释
function readConfig() {
  const cfg = {};
  let content;
  try { content = fs.readFileSync(CONFIG_PATH, 'utf8'); }
  catch { return cfg; }
  for (const line of content.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i === -1) continue;
    const k = t.slice(0, i).trim();
    const v = t.slice(i + 1).trim();
    if (k && v) cfg[k] = v;
  }
  return cfg;
}

// Chrome 的拒绝理由是一整页 text/html，压成一行给上层报错用
function reasonFrom(body, status) {
  const text = String(body || '').replace(/\s+/g, ' ').trim();
  if (/remote-allow-origins/i.test(text)) {
    return `HTTP ${status}：Chrome 拒绝该来源的调试连接，需要浏览器带 --remote-allow-origins 启动。原文：${text.slice(0, 200)}`;
  }
  if (!text) return `HTTP ${status}：无正文`;
  return `HTTP ${status}：${text.slice(0, 160)}`;
}

// 单次 GET /json/version，返回 { ok, status, body }
function getVersion(port, host, timeoutMs, origin) {
  return new Promise((resolve) => {
    let settled = false;
    const once = (r) => { if (!settled) { settled = true; resolve(r); } };
    const headers = { Accept: 'application/json' };
    if (origin) headers.Origin = origin;
    const req = http.request(
      { host, port, path: '/json/version', method: 'GET', timeout: timeoutMs, headers },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => once({ status: res.statusCode, body }));
      },
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (e) => once({ status: null, error: e && e.message === 'timeout' ? '探测超时' : ((e && e.code) || (e && e.message) || '探测失败') }));
    req.end();
  });
}

// 被拒时把 Chrome 的解释文字捞出来。它只在「带 Origin 的 WebSocket 升级请求」上写
// 正文（实测：普通 GET /json/version 是 404 空正文；带 Origin 的升级请求才是
// 403 + "Rejected an incoming WebSocket connection from the … origin. Use the
// command line flag --remote-allow-origins=…"）。所以这里手写一次升级握手，
// 读完响应就断开，不参与后续通信。
function probeRejectReason(port, host, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const once = (r) => { if (!settled) { settled = true; try { socket.destroy(); } catch {} resolve(r); } };
    const reqText = [
      'GET /json/version HTTP/1.1',
      `Host: ${host}:${port}`,
      'Upgrade: websocket',
      'Connection: Upgrade',
      'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
      'Sec-WebSocket-Version: 13',
      `Origin: http://${host}:${port}`,
      '', '',
    ].join('\r\n');
    const socket = net.createConnection(port, host);
    socket.setTimeout(timeoutMs);
    let buf = '';
    socket.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      const m = /^HTTP\/\d(?:\.\d)? (\d{3})/.exec(buf);
      if (m && buf.indexOf('\r\n\r\n') !== -1) once({ status: parseInt(m[1], 10), body: buf.slice(buf.indexOf('\r\n\r\n') + 4) });
    });
    socket.on('timeout', () => once({ status: null, error: '升级探测超时' }));
    socket.on('error', (e) => once({ status: null, error: (e && e.code) || (e && e.message) || '升级探测失败' }));
    socket.on('close', () => once({ status: null, error: '连接被直接关闭（Chrome 未给原因）' }));
    socket.end(reqText);
  });
}
// Chrome 只把拒绝解释写有限几次，之后就单纯关连接（实测同一端口第 3 次起没有
// 正文）。原因不会变，所以按端口缓存一次有信息量的理由，后面的探测沿用它，
// 避免「第一次能看见真原因、多探一次反而只剩 HTTP 404」这种越查越糊涂的报错。
const lastReason = new Map();

function withCachedReason(port, r) {
  if (r.ok) return r;
  const known = lastReason.get(port);
  const weak = !r.reason || /无正文|未给原因|探测超时|连接被直接关闭/.test(r.reason);
  if (known && weak) return { ok: false, status: known.status ?? r.status, reason: known.reason };
  if (!weak) lastReason.set(port, { reason: r.reason, status: r.status });
  return r;
}
// 存活判定：GET /json/version，且回包里拿得到 browser 级 WebSocket 路径。
// 被拒时 Chrome 的 404 是不带正文的，解释文字只在请求里出现 Origin 时才给（实测
// 403 + "Rejected an incoming WebSocket connection from the … origin"）。所以第一次
// 探测不带 Origin（保持与原行为一致），拿不到有用理由时再带一个 Origin 追一次，
// 只为把真实原因捞出来给上层报错——两次都失败才算不可用，判定结果不受影响。
export async function probeCdp(port, host = '127.0.0.1', timeoutMs = 2500) {
  const first = await getVersion(port, host, timeoutMs, null);
  const verdict = judgeVersion(first, port);
  if (verdict.ok || first.status === 200) return withCachedReason(port, verdict);
  const second = await probeRejectReason(port, host, timeoutMs);
  if (second.status === 101) {
    return withCachedReason(port, { ok: false, status: 101, reason: 'WebSocket 升级被接受，但 /json/version 拿不到端点：端口行为不像标准 CDP' });
  }
  const raw = second.body || second.error || '';
  const explained = raw ? reasonFrom(raw, second.status) : null;
  const useful = explained && !/无正文/.test(explained) ? explained : verdict.reason;
  return withCachedReason(port, { ok: false, status: second.status ?? verdict.status, reason: useful });
}

function judgeVersion(res, port) {
  if (res.error) return { ok: false, status: null, reason: res.error };
  if (res.status !== 200) return { ok: false, status: res.status, reason: reasonFrom(res.body, res.status) };
  let url = '';
  try { url = JSON.parse(res.body).webSocketDebuggerUrl || ''; }
  catch { return { ok: false, status: res.status, reason: reasonFrom(res.body, res.status) }; }
  let wsPath = null;
  try { wsPath = url ? new URL(url).pathname : null; } catch { wsPath = null; }
  if (!wsPath) return { ok: false, status: res.status, reason: '回包没有 webSocketDebuggerUrl：端口在听，但不是可附加的 CDP 端点' };
  return { ok: true, status: 200, wsPath, reason: null };
}

function dedupeByPort(list) {
  const m = new Map();
  for (const r of list) m.set(`${r.id}:${r.port}`, r);
  return [...m.values()];
}

// 最近一次扫描里「端口在听但拒绝附加」的记录：错误信息要有真原因，别只说「没连上」
let lastRejected = [];
export function rejectedBrowsers() { return dedupeByPort(lastRejected); }

// 返回所有 CDP 真能附加的浏览器
async function detectAll() {
  const usable = [];
  const rejected = [];
  for (const browser of knownBrowsers()) {
    let content;
    try { content = fs.readFileSync(browser.devToolsPath, 'utf8'); }
    catch { continue; }
    const lines = content.trim().split(/\r?\n/).filter(Boolean);
    const port = parseInt(lines[0], 10);
    if (!(port > 0 && port < 65536)) continue;
    if (!(await checkPort(port))) continue;
    const probe = await probeCdp(port);
    if (probe.ok) usable.push({ ...browser, port, wsPath: probe.wsPath || lines[1] || null });
    else rejected.push({ ...browser, port, reason: probe.reason });
  }
  lastRejected = rejected;
  return usable;
}

// 决策入口
// 参数：override —— 调用方解析自命令行 --browser 的值（null 表示未传）
// 返回 { kind, browser?, source?, detected, configured, rejected, override?, portFailure? }
//   kind ∈ 'ok' | 'ambiguous' | 'mismatch' | 'empty'
//   source ∈ 'port' | 'override' | 'preference' | undefined
//   ambiguous  = 没设偏好 + 至少一个浏览器可附加，需问用户
//   mismatch   = override/偏好/显式端口不可用，硬错（portFailure 带探测原因）
//   empty      = 没有任何可附加的浏览器，且未设偏好/override
export async function selectBrowser(override = null) {
  const cfg = readConfig();
  const parsed = parseInt(cfg.WEB_ACCESS_PORT || '', 10);
  const manualPort = Number.isInteger(parsed) && parsed > 0 && parsed < 65536 ? parsed : null;

  const detected = await detectAll();
  const configured = cfg.WEB_ACCESS_BROWSER || null;
  const rejected = dedupeByPort(lastRejected);

  // 0. 显式端口（用户明确指定，优先于一切）：只用它，失败就带着原因硬错，绝不换端口
  if (manualPort !== null) {
    const probe = await probeCdp(manualPort);
    if (probe.ok) {
      return {
        kind: 'ok',
        browser: { id: 'manual', label: `手动指定端口 ${manualPort}`, devToolsPath: null, port: manualPort, wsPath: probe.wsPath },
        source: 'port', detected, configured, rejected, manualPort,
      };
    }
    return { kind: 'mismatch', source: 'port', portFailure: { port: manualPort, reason: probe.reason }, detected, configured, rejected };
  }

  // 1. 命令行 override（最高优先，单次有效）
  if (override) {
    const match = detected.find(b => b.id === override);
    if (match) return { kind: 'ok', browser: match, source: 'override', detected, configured, rejected, override };
    return { kind: 'mismatch', source: 'override', detected, configured, rejected, override };
  }

  // 2. config.env preference（持久）
  if (configured) {
    const match = detected.find(b => b.id === configured);
    if (match) return { kind: 'ok', browser: match, source: 'preference', detected, configured, rejected };
    return { kind: 'mismatch', source: 'preference', detected, configured, rejected };
  }

  // 3. 无偏好 —— 一律询问用户（哪怕 detected 只有一个）
  if (detected.length === 0) return { kind: 'empty', detected, configured, rejected };
  return { kind: 'ambiguous', detected, configured, rejected };
}

// 兜底：扫描常用固定端口
// 适用场景：用户手动 --remote-debugging-port 启动浏览器，此时 DevToolsActivePort
// 不在这里扫不到的 user-data-dir 里。同样要过 CDP 探测，否则会把「在听但拒绝调试」
// 的端口一遍遍交回去。想稳定用某个端口，直接写 config.env 的 WEB_ACCESS_PORT。
export async function findFallbackPort() {
  for (const port of [9222, 9229, 9333]) {
    if (!(await checkPort(port))) continue;
    const probe = await probeCdp(port);
    if (probe.ok) return port;
    lastRejected = lastRejected.concat([{ id: 'unknown', label: `端口 ${port}`, port, reason: probe.reason }]);
  }
  return null;
}

// 代理与插件复用同一份 config.env 读取逻辑：持久配置只有这一处，也不写 process.env
export function readConfigEnv() { return readConfig(); }
