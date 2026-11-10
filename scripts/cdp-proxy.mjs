#!/usr/bin/env node
// CDP Proxy - 通过 HTTP API 操控用户日常浏览器（Chrome / Edge / Chromium 等）
// 要求：浏览器已开启 remote debugging（chrome://inspect#remote-debugging toggle）
// Node.js 22+（使用原生 WebSocket）

import http from 'node:http';
import crypto from 'node:crypto';
import { URL } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { selectBrowser, findFallbackPort, rejectedBrowsers, readConfigEnv } from './browser-discovery.mjs';

// --- 解析命令行 --browser 参数（本次启动用哪个浏览器）---
function parseBrowserArg() {
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--browser' && argv[i + 1]) return argv[i + 1];
    if (argv[i].startsWith('--browser=')) return argv[i].slice('--browser='.length);
  }
  return null;
}
const BROWSER_OVERRIDE = parseBrowserArg();

const PORT = parseInt(process.env.CDP_PROXY_PORT || '3456');

// 扩展桥的两道门，都在这里定义，且一律 fail-closed：
//   token —— 这个 HTTP API 之前对本机任何人开放，网页用一条简单请求就能开标签/跑 JS；
//   origin —— /agent 只认 config.env 里钉死的那个扩展 ID，其他来源（包括任意网页）一律拒。
// 代价是配置缺失就拒绝服务，而不是"先通起来再说"。这里就是要这个顺序。
const CFG = readConfigEnv();
// token 不进 config.env：那文件被 git 跟踪，写进去等于把密钥公开进版本库。
// 它是每机生成的私密值，默认放同目录 proxy.token（已在 .gitignore 里加 **/proxy.token）。
const SKILL_ROOT = path.resolve(import.meta.dirname, '..');
// 开关独立于密钥存在与否：宿主里的 index.js 要重启到会发 token 的新版、代理也要重启读到新配置，
// 两边都重启才生效（ensureProxy 会复用健康的旧代理，只重启 DSH 不解决问题）。
// 开关与 token 文件路径都留一个环境变量兜底（WEB_ACCESS_TOKEN_ENFORCE / WEB_ACCESS_TOKEN_FILE），
// 只服务回归测试起临时实例用；生产配置仍以 config.env + proxy.token 为准。
// fail-closed：开关为 1 但 token 缺失/为空 → 拒绝启动，绝不静默裸奔。
// 否则「以为开了鉴权、实际没开」比明确没开更危险。
// 开关是 OR 语义：任一处为 1 即启用。不能写成 `env || CFG` 短路 —— 环境里残留一个
// WEB_ACCESS_TOKEN_ENFORCE=0 会静默盖掉 config.env 的 1（fail-open），而且和宿主
// （cfg OR env）的语义相反：宿主认真发 token、代理裸奔。
const TOKEN_ENFORCE =
  String(CFG.WEB_ACCESS_TOKEN_ENFORCE || '').trim() === '1' ||
  String(process.env.WEB_ACCESS_TOKEN_ENFORCE || '').trim() === '1';
const TOKEN_FILE = String(CFG.WEB_ACCESS_TOKEN_FILE || process.env.WEB_ACCESS_TOKEN_FILE || path.join(SKILL_ROOT, 'proxy.token'));
let PROXY_TOKEN = '';
if (TOKEN_ENFORCE) {
  try { PROXY_TOKEN = fs.readFileSync(TOKEN_FILE, 'utf8').trim(); } catch { /* 下面统一硬错 */ }
  if (!PROXY_TOKEN) {
    console.error(`[CDP Proxy] WEB_ACCESS_TOKEN_ENFORCE=1 但 token 文件缺失或为空（${TOKEN_FILE}）—— 拒绝启动。`);
    console.error('[CDP Proxy] 生成方法：随机 48 位 hex 写入该文件；或把开关改回 0。');
    process.exit(1);
  }
}
// 恒定时间比较（loopback 上侧信道不现实，但这是免费的）
function tokenOk(req) {
  if (!TOKEN_ENFORCE) return true;
  const got = Buffer.from(String(req.headers['x-web-access-token'] || ''));
  const want = Buffer.from(PROXY_TOKEN);
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}
const AGENT_ID = String(CFG.WEB_ACCESS_EXTENSION_ID || '').trim();
const EXPECTED_AGENT_ORIGIN = AGENT_ID ? `chrome-extension://${AGENT_ID}` : null;
let ws = null;
let cmdId = 0;
const pending = new Map(); // id -> {resolve, timer}
const sessions = new Map(); // targetId -> sessionId
const managedTabs = new Map(); // targetId -> { lastAccessed: number }
const TAB_IDLE_TIMEOUT = parseInt(process.env.CDP_TAB_IDLE_TIMEOUT || '900000'); // 15 min default
const CLEANUP_INTERVAL = 60000; // sweep every 60s

// --- WebSocket 兼容层 ---
let WS;
if (typeof globalThis.WebSocket !== 'undefined') {
  // Node 22+ 原生 WebSocket（浏览器兼容 API）
  WS = globalThis.WebSocket;
} else {
  // 回退到 ws 模块
  try {
    WS = (await import('ws')).default;
  } catch {
    console.error('[CDP Proxy] 错误：Node.js 版本 < 22 且未安装 ws 模块');
    console.error('  解决方案：升级到 Node.js 22+ 或执行 npm install -g ws');
    process.exit(1);
  }
}

// proxy 启动时连接到的浏览器（用于 /health 暴露给 check-deps 比较）
let connectedBrowser = null; // { id, label, source }

// pin 首次成功连接的浏览器 id。重连时只接受同一 id，避免悄悄降级到别的浏览器。
let pinnedBrowserId = null;

// 最近一次失败的真实原因，供 /health 暴露给上层 —— 让「连不上」能说清为什么连不上
let lastError = null;

// --- 扩展桥（agent）：由 Chrome 扩展经 chrome.debugger 提供 CDP，绕开调试端口与 Origin 白名单 ---
let agent = null;                 // { ws, meta, connectedAt, lastSeenAt }
const pendingAgent = new Map();   // id -> { resolve, reject, timer }
let agentSeq = 0;
let agentReady = false;           // ws 服务端是否起起来了

function agentIsUp() { return !!(agent && agent.ws && agent.ws.readyState === 1); }

// 点击 / 滚动 / 后退在 CDP 路径上本来就是 JS 层面实现。两条通道共用同一段表达式，
// 否则同一句 web_page op=click 换个通道会有不同行为。
function clickJs(selector) {
  const sel = JSON.stringify(selector);
  return `(() => {
    const el = document.querySelector(${sel});
    if (!el) return { error: '未找到元素: ' + ${sel} };
    el.scrollIntoView({ block: 'center' });
    el.click();
    return { clicked: true, tag: el.tagName, text: (el.textContent || '').slice(0, 100) };
  })()`;
}
function scrollJs(direction, y) {
  const n = Math.abs(parseInt(y || '3000', 10));
  if (direction === 'top') return 'window.scrollTo(0, 0); "scrolled to top"';
  if (direction === 'bottom') return 'window.scrollTo(0, document.body.scrollHeight); "scrolled to bottom"';
  if (direction === 'up') return `window.scrollBy(0, -${n}); "scrolled up ${n}px"`;
  return `window.scrollBy(0, ${n}); "scrolled down ${n}px"`;
}
const BACK_JS = 'history.back()';

// 轮询就绪态。关键是不能只看 readyState：刚 tabs.update 之后，页面往往还是那个
// about:blank，它的 readyState 本来就是 complete —— 不要求"已经离开空白页"就会在
// 导航真正开始之前误判成加载完成（CDP 路径用 requireNonBlank 防的是同一件事）。
async function agentWaitReady(tabId, timeoutMs, { requireNonBlank = false, acceptInteractive = false } = {}) {
  const until = Date.now() + timeoutMs;
  let last = 'unknown';
  const expr = 'JSON.stringify({ready: document.readyState, url: location.href})';
  while (Date.now() < until) {
    try {
      const r = await agentRequest('command', { kind: 'tab.eval', tabId, expression: expr }, 5000);
      const v = typeof r.result?.value === 'string' ? JSON.parse(r.result.value) : null;
      if (v) {
        last = v.ready || 'unknown';
        const leftBlank = !requireNonBlank || (v.url && v.url !== 'about:blank');
        const readyOk = last === 'complete' || (acceptInteractive && last === 'interactive');
        if (leftBlank && readyOk) return { ready: last, url: v.url };
      }
    } catch { /* 导航中原页面上下文可能暂时不可用 */ }
    await new Promise((r) => setTimeout(r, 400));
  }
  return { ready: last, url: null };
}

function agentRequest(type, extra, timeoutMs) {
  return new Promise((resolve, reject) => {
    if (!agentIsUp()) return reject(new Error('扩展未连接（chrome://extensions 里确认 dsh-web-access bridge 已加载且未报错）'));
    const id = ++agentSeq;
    const timer = setTimeout(() => {
      pendingAgent.delete(id);
      reject(new Error(`扩展响应超时：${type}`));
    }, timeoutMs || 10000);
    pendingAgent.set(id, { resolve, reject, timer });
    try { agent.ws.send(JSON.stringify({ id, type, ...(extra || {}) })); }
    catch (e) { clearTimeout(timer); pendingAgent.delete(id); reject(e); }
  });
}

function settleAgent(msg) {
  if (!msg || !msg.id || !pendingAgent.has(msg.id)) return false;
  const { resolve, reject, timer } = pendingAgent.get(msg.id);
  clearTimeout(timer);
  pendingAgent.delete(msg.id);
  if (msg.ok === false) reject(new Error(msg.error || '扩展返回失败'));
  else resolve(msg);
  return true;
}

// 同一时刻只认一个扩展。晚到的第二个多半是在冒充扩展挂进来喂假数据，直接拒。
function onAgentSocket(ws, origin) {
  const mine = { ws, meta: null, connectedAt: Date.now(), lastSeenAt: Date.now() };
  // 每个回调都先确认"我仍是当前那个 agent"。接管失联连接时，旧 socket 的 message/close
  // 会迟到触发；无条件写 agent 会把刚挂上的新扩展抹成"已断开"（审查发现的竞态）。
  const isMine = () => agent === mine;
  agent = mine;
  console.log(`[CDP Proxy] 扩展桥已连接（origin=${origin}）`);
  ws.on('message', (data) => {
    if (!isMine()) return;
    let msg = null;
    try { msg = JSON.parse(String(data)); } catch { return; }
    if (!msg || typeof msg !== 'object') return;
    // 只有心跳与 pong 算"还活着"。任意消息都续命的话，一个占着位置的冒充者可以永远
    // 不让真扩展接管（它只要不停发垃圾就行）。且以合法 hello 为前提：没握过手的裸连接不配占位。
    if ((msg.type === 'heartbeat' || msg.type === 'pong') && mine.meta) mine.lastSeenAt = Date.now();
    if (msg.type === 'hello') {
      mine.meta = { version: msg.version || null, chrome: msg.chrome || null, extensionId: msg.extensionId || null };
      return;
    }
    settleAgent(msg);
  });
  ws.on('close', () => { if (!isMine()) return; agent = null; console.log('[CDP Proxy] 扩展桥断开'); });
  ws.on('error', (e) => { if (!isMine()) return; console.error('[CDP Proxy] 扩展桥错误:', e.message); });
}

// 扩展桥需要 WebSocket 服务端能力，原生 WebSocket 只有客户端 —— 所以这里必须要 ws 模块。
// 装不上就如实降级：CDP 通道照常工作，只是用不了扩展这条链。
async function initAgentServer() {
  let mod = null;
  try { mod = await import('ws'); }
  catch {
    console.error('[CDP Proxy] 未安装 ws 模块，扩展桥不可用（CDP 通道不受影响）。修复：cd C:\\dsh\\web-access && npm install ws');
    return;
  }
  const wss = new mod.WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    let pathname = '';
    try { pathname = new URL(req.url, `http://localhost:${PORT}`).pathname; } catch { socket.destroy(); return; }
    if (pathname !== '/agent') { socket.destroy(); return; }
    const origin = String(req.headers.origin || '');
    let deny = null;
    if (!EXPECTED_AGENT_ORIGIN) deny = 'config.env 未配置 WEB_ACCESS_EXTENSION_ID，拒绝任何扩展挂接（fail-closed）';
    else if (origin !== EXPECTED_AGENT_ORIGIN) deny = `来源 ${origin || '(无 Origin 头)'} 不是钉定的 ${EXPECTED_AGENT_ORIGIN}`;
    // 已经有活的扩展在连时，握手期就拒，不要"先接受再关闭"——后者会让对方看到一次
    // 成功的 open，行为上像是挂上了。唯一例外是旧连接已经失联：重载扩展时旧 service
    // worker 的 socket 可能晚一点才断，不能因此把新扩展永久挡在门外。
    const AGENT_STALE_MS = parseInt(process.env.CDP_AGENT_STALE_MS || '45000', 10); // keepalive 20s，两拍没动静算死
    const stale = agent && Date.now() - agent.lastSeenAt > AGENT_STALE_MS;
    if (!deny && agentIsUp() && !stale) deny = `已有扩展在连（${(agent.meta && agent.meta.extensionId) || '未知'}），不接第二个挂接；若刚重载过扩展，等旧连接失联（≤${AGENT_STALE_MS / 1000}s）或重启代理`;
    else if (agent && stale) {
      // 先摘掉记录再关旧 socket：旧 socket 的 close 回调会因为 isMine() 判假而变成空操作
      console.log('[CDP Proxy] 旧扩展连接已失联，接受新的挂接');
      const dead = agent;
      agent = null;
      try { dead.ws.close(); } catch { /* ignore */ }
    }
    if (deny) {
      console.error('[CDP Proxy] 拒绝挂接：' + deny);
      try { socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); } catch { /* ignore */ }
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => onAgentSocket(ws, origin));
  });
  agentReady = true;
  console.log(`[CDP Proxy] 扩展桥已就绪，只接受 ${EXPECTED_AGENT_ORIGIN}`);
}

// 端口在听但 Chrome 拒绝附加时，把真原因带进报错；没有记录就什么都不加
function rejectDetail(rejected) {
  const list = rejected && rejected.length ? rejected : rejectedBrowsers();
  if (!list || list.length === 0) return '';
  return list.map(r => `检测到 ${r.label}（端口 ${r.port}）在听但被拒绝：${r.reason}`).join('；') +
    '。这种情况光勾远程调试开关解决不了：要么让那个浏览器带 --remote-allow-origins 重启，' +
    '要么用独立 profile 起一个调试实例并在 config.env 写 WEB_ACCESS_PORT。';
}

// --- 自动发现浏览器调试端口 ---
// 决策完全委派给 browser-discovery.selectBrowser；此处只做日志和返回结构包装。
async function discoverChromePort() {
  const result = await selectBrowser(BROWSER_OVERRIDE);
  if (result.kind === 'ok') {
    if (pinnedBrowserId && pinnedBrowserId !== result.browser.id) {
      throw new Error(
        `本次连接的浏览器已经是 ${pinnedBrowserId}，不会自动切到 ${result.browser.id}。` +
        `如果想换成 ${result.browser.id}，请先在终端运行 pkill -f cdp-proxy.mjs 重置。`
      );
    }
    pinnedBrowserId = result.browser.id;
    connectedBrowser = { id: result.browser.id, label: result.browser.label, source: result.source };
    const tag = result.source === 'override' ? '[--browser 指定]' : '[config.env 偏好]';
    console.log(`[CDP Proxy] 选用 ${result.browser.label} (端口 ${result.browser.port}${result.browser.wsPath ? '，带 wsPath' : ''}) ${tag}`);
    return { port: result.browser.port, wsPath: result.browser.wsPath };
  }
  // mismatch：显式端口 / 偏好 / override 不可用 —— 硬错，绝不降级
  if (result.kind === 'mismatch') {
    if (result.source === 'port') {
      throw new Error(
        `config.env 的 WEB_ACCESS_PORT=${result.portFailure.port} 连不上：${result.portFailure.reason}。` +
        `Agent 处理顺序：(1) 确认那个端口上确实有带 --remote-allow-origins 启动的浏览器；` +
        `(2) 若用户其实想让插件自己发现，删掉 WEB_ACCESS_PORT 再试。`
      );
    }
    const expected = result.override || result.configured;
    const src = result.source === 'override' ? '本次指定' : '默认偏好';
    throw new Error(
      `${src}的浏览器是 "${expected}"，但没连上。${rejectDetail(result.rejected)}Agent 处理顺序：` +
      `(1) 先用系统命令打开 ${expected}（按平台选择，如 macOS 的 open -a），稍等后重试请求；` +
      `(2) 若仍失败，说明远程调试开关没启用 —— 告知用户在地址栏访问 ${expected}://inspect/#remote-debugging 勾选 "Allow remote debugging for this browser instance"。`
    );
  }
  // 已 pin 过浏览器（如首次连上 edge 后 edge 退出）：拒绝任何 fallback
  if (pinnedBrowserId) {
    throw new Error(
      `本次连接的浏览器是 ${pinnedBrowserId}，但现在没连上。Agent 处理顺序：` +
      `(1) 先用系统命令打开 ${pinnedBrowserId}（按平台选择），稍等后重试请求；` +
      `(2) 若仍失败，告知用户在地址栏访问 ${pinnedBrowserId}://inspect/#remote-debugging 重新勾选允许。` +
      `若想换成其他浏览器，请先在终端运行 pkill -f cdp-proxy.mjs 重置。`
    );
  }
  // 仅在「从未成功连接 + 无偏好/override」时允许固定端口兜底（手动 --remote-debugging-port 启动场景）
  const fallbackPort = await findFallbackPort();
  if (fallbackPort !== null) {
    connectedBrowser = { id: 'unknown', label: '未知（通过手动调试端口连接）', source: 'fallback' };
    console.log(`[CDP Proxy] 通过手动调试端口连接: ${fallbackPort}`);
    return { port: fallbackPort, wsPath: null };
  }
  return null;
}

function getWebSocketUrl(port, wsPath) {
  if (wsPath) return `ws://127.0.0.1:${port}${wsPath}`;
  return `ws://127.0.0.1:${port}/devtools/browser`;
}

// --- WebSocket 连接管理 ---
let chromePort = null;
let chromeWsPath = null;

let connectingPromise = null;
async function connect() {
  if (ws && (ws.readyState === WS.OPEN || ws.readyState === 1)) return;
  if (connectingPromise) return connectingPromise;  // 复用进行中的连接

  if (!chromePort) {
    const discovered = await discoverChromePort();
    if (!discovered) {
      throw new Error(
        '没发现可附加的浏览器调试端口。' + rejectDetail() + '\n' +
        '两条出路：\n' +
        '  (1) 在浏览器地址栏访问 chrome://inspect/#remote-debugging（Edge 用 edge://），' +
        '勾选 "Allow remote debugging for this browser instance"；\n' +
        '  (2) 用独立 profile 起一个调试实例，例如：\n' +
        '      chrome --user-data-dir=<独立目录> --remote-debugging-port=9229 --remote-allow-origins=*\n' +
        '      然后在 config.env 写 WEB_ACCESS_PORT=9229（固定端口兜底只扫 9222/9229/9333）。'
      );
    }
    chromePort = discovered.port;
    chromeWsPath = discovered.wsPath;
  }

  const wsUrl = getWebSocketUrl(chromePort, chromeWsPath);
  if (!wsUrl) throw new Error('无法获取 Chrome WebSocket URL');

  return connectingPromise = new Promise((resolve, reject) => {
    ws = new WS(wsUrl);

    const onOpen = () => {
      cleanup();
      connectingPromise = null;
      lastError = null;
      console.log(`[CDP Proxy] 已连接浏览器 (端口 ${chromePort})`);
      resolve();
    };
    const onError = (e) => {
      cleanup();
      connectingPromise = null;
      ws = null;
      chromePort = null;
      chromeWsPath = null;
      const msg = e.message || e.error?.message || '连接失败';
      console.error('[CDP Proxy] 连接错误:', msg, '（端口缓存已清除，下次将重新发现）');
      lastError = msg;
      reject(new Error(msg));
    };
    const onClose = () => {
      console.log('[CDP Proxy] 连接断开');
      ws = null;
      chromePort = null; // 重置端口缓存，下次连接重新发现
      chromeWsPath = null;
      sessions.clear();
      managedTabs.clear();
    };
    const onMessage = (evt) => {
      const data = typeof evt === 'string' ? evt : (evt.data || evt);
      const msg = JSON.parse(typeof data === 'string' ? data : data.toString());

      if (msg.method === 'Target.attachedToTarget') {
        const { sessionId, targetInfo } = msg.params;
        sessions.set(targetInfo.targetId, sessionId);
      }
      // 拦截页面对 Chrome 调试端口的探测请求（反风控）
      if (msg.method === 'Fetch.requestPaused') {
        const { requestId, sessionId: sid } = msg.params;
        sendCDP('Fetch.failRequest', { requestId, errorReason: 'ConnectionRefused' }, sid).catch(() => {});
      }
      if (msg.id && pending.has(msg.id)) {
        const { resolve, timer } = pending.get(msg.id);
        clearTimeout(timer);
        pending.delete(msg.id);
        resolve(msg);
      }
    };

    function cleanup() {
      ws.removeEventListener?.('open', onOpen);
      ws.removeEventListener?.('error', onError);
    }

    // 兼容 Node 原生 WebSocket 和 ws 模块的事件 API
    if (ws.on) {
      ws.on('open', onOpen);
      ws.on('error', onError);
      ws.on('close', onClose);
      ws.on('message', onMessage);
    } else {
      ws.addEventListener('open', onOpen);
      ws.addEventListener('error', onError);
      ws.addEventListener('close', onClose);
      ws.addEventListener('message', onMessage);
    }
  });
}

function sendCDP(method, params = {}, sessionId = null) {
  return new Promise((resolve, reject) => {
    if (!ws || (ws.readyState !== WS.OPEN && ws.readyState !== 1)) {
      return reject(new Error('WebSocket 未连接'));
    }
    const id = ++cmdId;
    const msg = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('CDP 命令超时: ' + method));
    }, 30000);
    pending.set(id, { resolve, timer });
    ws.send(JSON.stringify(msg));
  });
}

// 已启用端口拦截的 session 集合（避免重复启用）
const portGuardedSessions = new Set();

async function ensureSession(targetId) {
  if (sessions.has(targetId)) return sessions.get(targetId);
  const resp = await sendCDP('Target.attachToTarget', { targetId, flatten: true });
  if (resp.result?.sessionId) {
    const sid = resp.result.sessionId;
    sessions.set(targetId, sid);
    // 启用调试端口探测拦截
    await enablePortGuard(sid);
    return sid;
  }
  throw new Error('attach 失败: ' + JSON.stringify(resp.error));
}

// 拦截页面对 Chrome 调试端口的探测（反风控）
// 只拦截 127.0.0.1:{chromePort} 的请求，不影响其他任何本地服务
async function enablePortGuard(sessionId) {
  if (!chromePort || portGuardedSessions.has(sessionId)) return;
  try {
    await sendCDP('Fetch.enable', {
      patterns: [
        { urlPattern: `http://127.0.0.1:${chromePort}/*`, requestStage: 'Request' },
        { urlPattern: `http://localhost:${chromePort}/*`, requestStage: 'Request' },
      ]
    }, sessionId);
    portGuardedSessions.add(sessionId);
  } catch { /* Fetch 域启用失败不影响主流程 */ }
}

// --- 闲置 Tab 自动清理 ---
function touchTab(targetId) {
  const entry = managedTabs.get(targetId);
  if (entry) entry.lastAccessed = Date.now();
}

// 数字 ID 是扩展通道托管标签，十六进制是 CDP target —— 各走各的通道关。
// 返回 'closed'（可销账）或 'retry'（通道暂不可用，留着下轮再试）。
// 旧版对所有键一律发 CDP closeTarget：数字 ID 必然失败、catch 吞掉后还无条件删账，
// 等于「日志说关了、实际没关」——正是这轮要抓的静默失效。
async function closeManagedTab(targetId) {
  const id = String(targetId);
  if (/^\d+$/.test(id)) {
    if (!agentIsUp()) return 'retry';
    try { await agentRequest('command', { kind: 'tab.close', tabId: Number(id) }, 10000); return 'closed'; }
    catch (e) {
      // 扩展说「不是我的托管标签」多半是用户已手动关闭 → 代理侧账也该销
      if (/^UNMANAGED_TAB/.test((e && e.message) || '')) return 'closed';
      return 'retry';
    }
  }
  if (!ws || (ws.readyState !== WS.OPEN && ws.readyState !== 1)) return 'retry';
  try { await sendCDP('Target.closeTarget', { targetId: id }); return 'closed'; }
  catch (e) {
    if (/No such target/i.test((e && e.message) || '')) return 'closed';
    return 'retry';
  }
}

async function cleanupIdleTabs() {
  const now = Date.now();
  for (const [targetId, info] of managedTabs) {
    if (now - info.lastAccessed < TAB_IDLE_TIMEOUT) continue;
    if (await closeManagedTab(targetId) !== 'closed') continue;
    sessions.delete(targetId);
    managedTabs.delete(targetId);
    console.log(`[CDP Proxy] Auto-closed idle tab: ${targetId}`);
  }
}

async function closeAllManagedTabs() {
  const targets = [...managedTabs.keys()];
  // 并行关：串行 await 每个 10s 超时，标签一多退出就要按分钟计
  const outcomes = await Promise.all(targets.map((t) => closeManagedTab(t)));
  let n = 0;
  for (const targetId of targets) {
    sessions.delete(targetId);
    managedTabs.delete(targetId);
  }
  n = outcomes.filter((o) => o === 'closed').length;
  if (targets.length) console.log(`[CDP Proxy] Shutdown: closed ${n}/${targets.length} managed tab(s)`);
}

// --- 等待页面加载 ---
async function waitForLoad(
  sessionId,
  timeoutMs = 15000,
  { requireNonBlank = false, acceptInteractive = false } = {},
) {
  // 启用 Page 域
  await sendCDP('Page.enable', {}, sessionId);

  return new Promise((resolve) => {
    let resolved = false;
    const done = (result) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      clearInterval(checkInterval);
      resolve(result);
    };

    const timer = setTimeout(() => done('timeout'), timeoutMs);
    const checkInterval = setInterval(async () => {
      try {
        const resp = await sendCDP('Runtime.evaluate', {
          expression: 'JSON.stringify({ ready: document.readyState, url: location.href })',
          returnByValue: true,
        }, sessionId);
        const value = resp.result?.result?.value;
        const state = typeof value === 'string' ? JSON.parse(value) : null;
        const ready = state?.ready === 'complete' || (acceptInteractive && state?.ready === 'interactive');
        if (ready && (!requireNonBlank || state.url !== 'about:blank')) {
          done('complete');
        }
      } catch { /* 忽略 */ }
    }, 500);
  });
}

// --- 读取 POST body ---
// 体积上限：控制面单次调用（选择器/表达式/URL）本来不需要大 body，不设上限等于
// 允许本机任意进程用无限 POST body 拖住代理。上限内不 destroy 连接，让调用方收到 413。
const MAX_BODY_BYTES = 2 * 1024 * 1024;
// base64 字符数上限（约对应解码后 64MB），整页截图防极端页面撑爆内存
const SHOT_B64_MAX = 96 * 1024 * 1024;
async function readBody(req) {
  // 按 chunk 累加真实字节数：字符串 body.length 是 UTF-16 字符数，中文表达式能撑到 2–4 倍字节
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buf.length;
    if (bytes > MAX_BODY_BYTES) {
      throw new Error('BODY_TOO_LARGE: 请求体超过 ' + MAX_BODY_BYTES + ' 字节上限');
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString('utf8');
}

// 截图落盘固定在代理自己的 shots/ 下，文件名服务端生成（时间戳+随机数），永不吃调用方的 file 参数。
// WEB_ACCESS_SHOTS_DIR 只为回归测试准备（harness 沙箱不让测试子进程写 C:\dsh 树），生产不设。
const SHOTS_DIR = process.env.WEB_ACCESS_SHOTS_DIR || path.join(SKILL_ROOT, 'shots');
function saveShot(buf, ext) {
  const dir = SHOTS_DIR;
  fs.mkdirSync(dir, { recursive: true });
  const name = 'shot-' + Date.now() + '-' + Math.floor(Math.random() * 100000) + '.' + ext;
  const file = path.join(dir, name);
  fs.writeFileSync(file, buf);
  return { file, name };
}

// --- HTTP API ---
const server = http.createServer(async (req, res) => {
  const parsed = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = parsed.pathname;
  const q = Object.fromEntries(parsed.searchParams);

  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  try {
    // /health 不需要连接浏览器
    if (pathname === '/health') {
      // 开了 token 后 /health 是唯一免鉴权可见的端点：未授权只报「控制面有无鉴权」，
      // chromePort / agent 元信息 / lastError 这些诊断细节要带对 token 才给。
      if (TOKEN_ENFORCE && !tokenOk(req)) {
        res.end(JSON.stringify({ status: 'ok', tokenEnforced: true }));
        return;
      }
      const connected = ws && (ws.readyState === WS.OPEN || ws.readyState === 1);
      res.end(JSON.stringify({
        status: 'ok',
        connected,
        browser: connectedBrowser,
        sessions: sessions.size,
        managedTabs: managedTabs.size,
        chromePort,
        lastError,
        rejected: rejectedBrowsers(),
        agentReady,
        agentConnected: agentIsUp(),
        tokenEnforced: TOKEN_ENFORCE,
        agent: agent && agent.meta ? { ...agent.meta, connectedAt: agent.connectedAt, lastSeenAt: agent.lastSeenAt } : null,
        transport: agentIsUp() ? 'extension' : (chromePort ? 'cdp' : 'none'),
      }));
      return;
    }

    // /health 之外一律要 token。这个 API 原本对本机任意进程敞开，网页用一条
    // "简单请求" 也能打进来（CORS 只挡读响应、不挡写），等于谁都能开标签、跑 JS。
    if (TOKEN_ENFORCE && !tokenOk(req)) {
      res.statusCode = 401;
      res.end(JSON.stringify({ error: '缺少或错误的 x-web-access-token' }));
      return;
    }

    // /eval 只接受 POST body：GET + query 表达式能被本机任意网页一条 <img src> 就触发
    // （GET 简单请求无 CORS 预检），响应读不读得到无所谓，副作用已经发生。
    // 宿主 web_page 的 eval 一直是 POST，此收紧不影响既有调用方。
    if (pathname === '/eval' && req.method !== 'POST') {
      res.statusCode = 405;
      res.end(JSON.stringify({ error: '/eval 仅接受 POST body 表达式' }));
      return;
    }

    // file 参数已移除：旧版把任意路径直接喂给 fs.writeFileSync，未鉴权时是本用户权限下的任意文件覆盖面。
    // 检查放在所有分流之前 —— 带它的请求在任何通道上都不该有副作用。
    if (pathname === '/screenshot' && q.file) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: 'file 参数已移除：截图或经响应体直接返回图片字节，或 save=1 落盘到代理 shots/ 下的服务端生成文件名' }));
      return;
    }

    // 闲置计时只给过了鉴权的请求续命：未授权方不得有刷新 lastAccessed、
    // 让托管标签永远躲过清理这种状态副作用。
    if (q.target) touchTab(q.target);

    // GET /agent/ping —— 扩展桥链路自检，不碰页面：确认挂接、往返、分发都通
    if (pathname === '/agent/ping') {
      const t0 = Date.now();
      const pong = await agentRequest('ping', { at: t0 }, 5000);
      res.end(JSON.stringify({ ok: true, rttMs: Date.now() - t0, agent: agent && agent.meta, pong }));
      return;
    }

    // --- M2：列标签 / 求值 / 取页面信息优先走扩展通道 ---
    // 放在 await connect() 之前是有意的：这三条不碰调试端口，所以你正常双击打开的
    // Chrome（没开远程调试）也能用。返回值形状与 CDP 路径保持一致，上层工具无感。
    //
    // 两套 target id 命名空间并存：扩展通道用 chrome.tabs 的数字 ID，CDP 用十六进制
    // targetId（/new 返回的就是它）。所以这里按形状分流 —— 数字走扩展，非数字落回
    // CDP 原路径，两边都能用，不要求调用方知道自己拿的是哪种 ID。
    // 严格 `^[0-9]+$`：Number() 强转会把 '0x10'（→16）、'1e3'（→1000）、' '（→0）都当成合法
    // 整数送进扩展通道，撞上不相关的真实标签；形状判定必须比语义转换保守。
    const agentTarget = /^\d{1,10}$/.test(String(q.target ?? '')) ? Number(q.target) : null;
    // 扩展通道：关闭 / 点击 / 滚动 / 后退。点击与滚动复用 CDP 路径同一套 JS（见 clickJs /
    // scrollJs），所以两条通道行为一致；只有 /close 需要扩展侧的 tab.close 能力。
    if (agentIsUp() && agentTarget !== null && (pathname === '/close' || pathname === '/click' || pathname === '/scroll' || pathname === '/back')) {
      try {
        if (pathname === '/close') {
          const r = await agentRequest('command', { kind: 'tab.close', tabId: agentTarget }, 10000);
          managedTabs.delete(String(agentTarget));
          res.end(JSON.stringify({ success: !!(r.result && r.result.success), closed: agentTarget }));
          return;
        }
        let expression;
        if (pathname === '/click') {
          const selector = (await readBody(req)).trim();
          if (!selector) { res.statusCode = 400; res.end(JSON.stringify({ error: 'POST body 需要 CSS 选择器' })); return; }
          expression = clickJs(selector);
        } else if (pathname === '/scroll') {
          expression = scrollJs(q.direction || 'down', q.y);
        } else {
          expression = BACK_JS;
        }
        const r = await agentRequest('command', { kind: 'tab.eval', tabId: agentTarget, expression }, 30000);
        const value = r.result ? r.result.value : undefined;
        if (pathname === '/scroll') await new Promise((res2) => setTimeout(res2, 800)); // 等懒加载
        res.end(JSON.stringify(pathname === '/back' ? { ok: true } : { value }));
      } catch (e) {
        // 扩展报「非托管标签」是权限判定，不是执行失败 —— 用 403 区分开。
        // 前缀匹配（扩展抛的 Error 以此串开头），页面脚本报错里恰好含这个词不会被误映射。
        const em = String((e && e.message) || '');
        res.statusCode = em.startsWith('UNMANAGED_TAB') ? 403 : em.startsWith('BODY_TOO_LARGE') ? 413 : 400;
        res.end(JSON.stringify({ error: `扩展通道执行失败：${e.message}`, endpoint: pathname }));
      }
      return;
    }

    if (agentIsUp() && (pathname === '/targets' || pathname === '/new'
      || ((pathname === '/navigate' || pathname === '/eval' || pathname === '/info' || pathname === '/screenshot') && agentTarget !== null))) {
      if (pathname === '/targets') {
        const r = await agentRequest('command', { kind: 'tabs.list' }, 10000);
        res.end(JSON.stringify((r.result && r.result.tabs) || [], null, 2));
        return;
      }

      // POST /new —— 扩展通道：后台建空白标签 → 导航 → 轮询就绪（复用 tab.eval，不再要 CDP）
      if (pathname === '/new') {
        if (req.method !== 'POST') { res.statusCode = 400; res.end(JSON.stringify({ error: '/new 需要 POST 传 URL' })); return; }
        const body = (await readBody(req)).trim();
        const targetUrl = body || 'about:blank';
        const created = await agentRequest('command', { kind: 'tab.create' }, 15000);
        const newId = created.result && created.result.targetId;
        if (!newId) { res.statusCode = 500; res.end(JSON.stringify({ error: '扩展没返回新标签 ID' })); return; }
        managedTabs.set(newId, { lastAccessed: Date.now() });
        let ready = 'unknown';
        if (targetUrl !== 'about:blank') {
          await agentRequest('command', { kind: 'tab.navigate', tabId: Number(newId), url: targetUrl }, 20000);
          const waited = await agentWaitReady(Number(newId), 20000, { requireNonBlank: true, acceptInteractive: true });
          ready = waited.ready;
        }
        const info = await agentRequest('command', {
          kind: 'tab.eval', tabId: Number(newId),
          expression: 'JSON.stringify({title: document.title, url: location.href})',
        }, 10000).catch(() => null);
        const parsed = info && info.result && typeof info.result.value === 'string' ? JSON.parse(info.result.value) : {};
        res.end(JSON.stringify({ targetId: newId, title: parsed.title || '', url: parsed.url || targetUrl, ready }));
        return;
      }

      // POST /navigate?target=<数字标签ID> —— 扩展通道：tabs.update + 等离开旧页面
      if (pathname === '/navigate') {
        if (req.method !== 'POST') { res.statusCode = 400; res.end(JSON.stringify({ error: '/navigate 需要 POST 传 URL' })); return; }
        const url = (await readBody(req)).trim() || q.url || '';
        if (!url) { res.statusCode = 400; res.end(JSON.stringify({ error: '缺少 url' })); return; }
        const before = await agentRequest('command', { kind: 'tab.eval', tabId: agentTarget, expression: 'location.href' }, 8000).catch(() => null);
        const from = before && before.result ? String(before.result.value) : '';
        await agentRequest('command', { kind: 'tab.navigate', tabId: agentTarget, url }, 20000);
        // 等到 URL 真的变了再看 readyState，否则会拿旧页面的 complete 误判成新页面已加载
        let ready = 'unknown';
        const until = Date.now() + 20000;
        let nulls = 0;
        while (Date.now() < until) {
          const w = await agentWaitReady(agentTarget, 1000, { requireNonBlank: false });
          if (w.url && w.url !== from) { ready = w.ready; break; }
          // 连续读不到页面状态说明 tab 异常（不存在/未托管/attach 失败），别把轮询打成命令风暴
          if (!w.url && ++nulls >= 5) break;
          await new Promise((r) => setTimeout(r, 300));
        }
        res.end(JSON.stringify({ navigated: agentTarget, url, ready }));
        return;
      }

      // GET /screenshot?target=<数字标签ID>&save=1&format=&full=1
      if (pathname === '/screenshot') {
        const full = q.full === '1' || q.full === 'true';
        const shot = await agentRequest('command', { kind: 'tab.screenshot', tabId: agentTarget, format: q.format, full }, 30000);
        if (!shot.result || typeof shot.result.data !== 'string' || shot.result.data.length > SHOT_B64_MAX) {
          res.statusCode = 413;
          res.end(JSON.stringify({ error: '截图数据缺失或超过上限' }));
          return;
        }
        const buf = Buffer.from(shot.result.data, 'base64');
        if (q.save === '1' || q.save === 'true') {
          const ext = (shot.result.format || q.format || 'png') === 'jpeg' ? 'jpg' : 'png';
          const s = saveShot(buf, ext);
          res.end(JSON.stringify({ saved: s.name, path: s.file.replace(/\\/g, '/'), bytes: buf.length, via: 'extension' }));
          return;
        }
        res.setHeader('Content-Type', 'image/' + (shot.result.format === 'jpeg' ? 'jpeg' : 'png'));
        res.end(buf);
        return;
      }
      const tabId = Number(q.target);
      if (!Number.isInteger(tabId)) { res.statusCode = 400; res.end(JSON.stringify({ error: '扩展通道需要数字标签 ID', got: q.target ?? null })); return; }
      let expression;
      if (pathname === '/eval') {
        const body = await readBody(req);
        expression = body.trim() || 'document.title'; // 不再读 q.expr：表达式只走 POST body，缩小触发面
      } else {
        expression = 'JSON.stringify({title: document.title, url: location.href, ready: document.readyState})';
      }
      try {
        const r = await agentRequest('command', { kind: 'tab.eval', tabId, expression }, 30000);
        const v = r.result ? r.result.value : undefined;
        res.end(pathname === '/eval' ? JSON.stringify({ value: v }) : (typeof v === 'string' ? v : JSON.stringify(v ?? {})));
      } catch (e) {
        const em = String((e && e.message) || '');
        res.statusCode = em.startsWith('UNMANAGED_TAB') ? 403 : em.startsWith('BODY_TOO_LARGE') ? 413 : 400;
        res.end(JSON.stringify({ error: `扩展通道执行失败：${e.message}` }));
      }
      return;
    }

    await connect();

    // GET /targets - 列出所有页面
    if (pathname === '/targets') {
      const resp = await sendCDP('Target.getTargets');
      const pages = resp.result.targetInfos.filter(t => t.type === 'page');
      res.end(JSON.stringify(pages, null, 2));
    }

    // POST /new (body=URL) - 创建新后台 tab
    else if (pathname === '/new') {
      if (req.method !== 'POST') {
        res.statusCode = 400;
        res.end(JSON.stringify({
          error: 'v2.5.3 起 /new 改为 POST 传 URL（避免目标 URL 含 query 时被错误切分）',
          migration: 'references/migration-2.5.3.md',
          example: "curl -X POST --data-raw 'https://example.com' http://localhost:3456/new",
        }));
        return;
      }
      const body = (await readBody(req)).trim();
      const targetUrl = body || 'about:blank';
      // 先创建空白页并完成 attach，再显式导航。Target.createTarget({ url }) 会先暴露
      // readyState=complete 的 about:blank，导致慢页面在真正开始加载前被误判为完成。
      const resp = await sendCDP('Target.createTarget', { url: 'about:blank', background: true });
      const targetId = resp.result.targetId;
      managedTabs.set(targetId, { lastAccessed: Date.now() });

      // 等待页面加载
      if (targetUrl !== 'about:blank') {
        try {
          const sid = await ensureSession(targetId);
          await sendCDP('Page.navigate', { url: targetUrl }, sid);
          await waitForLoad(sid, 15000, { requireNonBlank: true, acceptInteractive: true });
        } catch { /* 非致命，继续 */ }
      }

      res.end(JSON.stringify({ targetId }));
    }

    // GET /close?target=xxx - 关闭 tab
    else if (pathname === '/close') {
      const resp = await sendCDP('Target.closeTarget', { targetId: q.target });
      sessions.delete(q.target);
      managedTabs.delete(q.target);
      res.end(JSON.stringify(resp.result));
    }

    // POST /navigate?target=xxx (body=URL) - 导航（自动等待加载）
    else if (pathname === '/navigate') {
      if (req.method !== 'POST') {
        res.statusCode = 400;
        res.end(JSON.stringify({
          error: 'v2.5.3 起 /navigate 改为 POST 传 URL（避免目标 URL 含 query 时被错误切分）',
          migration: 'references/migration-2.5.3.md',
          example: "curl -X POST --data-raw 'https://example.com' 'http://localhost:3456/navigate?target=ID'",
        }));
        return;
      }
      const targetUrl = (await readBody(req)).trim();
      const sid = await ensureSession(q.target);
      const resp = await sendCDP('Page.navigate', { url: targetUrl }, sid);

      // 等待页面加载完成
      await waitForLoad(sid);

      res.end(JSON.stringify(resp.result));
    }

    // GET /back?target=xxx - 后退
    else if (pathname === '/back') {
      const sid = await ensureSession(q.target);
      await sendCDP('Runtime.evaluate', { expression: 'history.back()' }, sid);
      await waitForLoad(sid);
      res.end(JSON.stringify({ ok: true }));
    }

    // POST /eval?target=xxx - 执行 JS
    else if (pathname === '/eval') {
      const sid = await ensureSession(q.target);
      const body = await readBody(req);
      const expr = body.trim() || 'document.title'; // 与扩展通道同口径：表达式只走 POST body，不读 q.expr
      const resp = await sendCDP('Runtime.evaluate', {
        expression: expr,
        returnByValue: true,
        awaitPromise: true,
      }, sid);
      if (resp.result?.result?.value !== undefined) {
        res.end(JSON.stringify({ value: resp.result.result.value }));
      } else if (resp.result?.exceptionDetails) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: resp.result.exceptionDetails.text }));
      } else {
        res.end(JSON.stringify(resp.result));
      }
    }

    // POST /click?target=xxx - 点击（body 为 CSS 选择器）
    // POST /click?target=xxx — JS 层面点击（简单快速，覆盖大多数场景）
    else if (pathname === '/click') {
      const sid = await ensureSession(q.target);
      const selector = await readBody(req);
      if (!selector) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: 'POST body 需要 CSS 选择器' }));
        return;
      }
      const js = clickJs(selector);
      const resp = await sendCDP('Runtime.evaluate', {
        expression: js,
        returnByValue: true,
        awaitPromise: true,
      }, sid);
      if (resp.result?.result?.value) {
        const val = resp.result.result.value;
        if (val.error) {
          res.statusCode = 400;
          res.end(JSON.stringify(val));
        } else {
          res.end(JSON.stringify(val));
        }
      } else {
        res.end(JSON.stringify(resp.result));
      }
    }

    // POST /clickAt?target=xxx — CDP 浏览器级真实鼠标点击（算用户手势，能触发文件对话框、绕过反自动化检测）
    else if (pathname === '/clickAt') {
      const sid = await ensureSession(q.target);
      const selector = await readBody(req);
      if (!selector) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: 'POST body 需要 CSS 选择器' }));
        return;
      }
      const selectorJson = JSON.stringify(selector);
      const js = `(() => {
        const el = document.querySelector(${selectorJson});
        if (!el) return { error: '未找到元素: ' + ${selectorJson} };
        el.scrollIntoView({ block: 'center' });
        const rect = el.getBoundingClientRect();
        return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, tag: el.tagName, text: (el.textContent || '').slice(0, 100) };
      })()`;
      const coordResp = await sendCDP('Runtime.evaluate', {
        expression: js,
        returnByValue: true,
        awaitPromise: true,
      }, sid);
      const coord = coordResp.result?.result?.value;
      if (!coord || coord.error) {
        res.statusCode = 400;
        res.end(JSON.stringify(coord || coordResp.result));
        return;
      }
      await sendCDP('Input.dispatchMouseEvent', {
        type: 'mousePressed', x: coord.x, y: coord.y, button: 'left', clickCount: 1
      }, sid);
      await sendCDP('Input.dispatchMouseEvent', {
        type: 'mouseReleased', x: coord.x, y: coord.y, button: 'left', clickCount: 1
      }, sid);
      res.end(JSON.stringify({ clicked: true, x: coord.x, y: coord.y, tag: coord.tag, text: coord.text }));
    }

    // POST /setFiles?target=xxx — 给 file input 设置本地文件（绕过文件对话框）
    // body: JSON { "selector": "input[type=file]", "files": ["/path/to/file1.png", "/path/to/file2.png"] }
    else if (pathname === '/setFiles') {
      const sid = await ensureSession(q.target);
      const body = JSON.parse(await readBody(req));
      if (!body.selector || !body.files) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: '需要 selector 和 files 字段' }));
        return;
      }
      // 获取 DOM 节点
      await sendCDP('DOM.enable', {}, sid);
      const doc = await sendCDP('DOM.getDocument', {}, sid);
      const node = await sendCDP('DOM.querySelector', {
        nodeId: doc.result.root.nodeId,
        selector: body.selector
      }, sid);
      if (!node.result?.nodeId) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: '未找到元素: ' + body.selector }));
        return;
      }
      // 设置文件
      await sendCDP('DOM.setFileInputFiles', {
        nodeId: node.result.nodeId,
        files: body.files
      }, sid);
      res.end(JSON.stringify({ success: true, files: body.files.length }));
    }

    // GET /scroll?target=xxx&y=3000 - 滚动
    else if (pathname === '/scroll') {
      const sid = await ensureSession(q.target);
      const js = scrollJs(q.direction || 'down', q.y);
      const resp = await sendCDP('Runtime.evaluate', {
        expression: js,
        returnByValue: true,
      }, sid);
      // 等待懒加载触发
      await new Promise(r => setTimeout(r, 800));
      res.end(JSON.stringify({ value: resp.result?.result?.value }));
    }

    // GET /screenshot?target=xxx&save=1 - 截图
    else if (pathname === '/screenshot') {
      const sid = await ensureSession(q.target);
      const format = q.format || 'png';
      const resp = await sendCDP('Page.captureScreenshot', {
        format,
        quality: format === 'jpeg' ? 80 : undefined,
        // 与扩展通道同一个参数：默认视口，full=1 才截整页
        captureBeyondViewport: q.full === '1' || q.full === 'true',
      }, sid);
      const b64 = resp && resp.result ? resp.result.data : null;
      if (typeof b64 !== 'string' || b64.length > SHOT_B64_MAX) {
        res.statusCode = 413;
        res.end(JSON.stringify({ error: '截图数据缺失或超过上限' }));
        return;
      }
      if (q.save === '1' || q.save === 'true') {
        const buf = Buffer.from(b64, 'base64');
        const s = saveShot(buf, format === 'jpeg' ? 'jpg' : 'png');
        res.end(JSON.stringify({ saved: s.name, path: s.file.replace(/\\/g, '/'), bytes: buf.length, via: 'cdp' }));
      } else {
        res.setHeader('Content-Type', 'image/' + format);
        res.end(Buffer.from(b64, 'base64'));
      }
    }

    // GET /info?target=xxx - 获取页面信息
    else if (pathname === '/info') {
      const sid = await ensureSession(q.target);
      const resp = await sendCDP('Runtime.evaluate', {
        expression: 'JSON.stringify({title: document.title, url: location.href, ready: document.readyState})',
        returnByValue: true,
      }, sid);
      res.end(resp.result?.result?.value || '{}');
    }

    else {
      res.statusCode = 404;
      res.end(JSON.stringify({
        error: '未知端点',
        endpoints: {
          '/health': 'GET - 健康检查',
          '/targets': 'GET - 列出所有页面 tab',
          '/new': 'POST body=URL - 创建新后台 tab（自动等待加载）',
          '/close?target=': 'GET - 关闭 tab',
          '/navigate?target=': 'POST body=URL - 导航（自动等待加载）',
          '/back?target=': 'GET - 后退',
          '/info?target=': 'GET - 页面标题/URL/状态',
          '/eval?target=': 'POST body=JS表达式 - 执行 JS',
          '/click?target=': 'POST body=CSS选择器 - 点击元素',
          '/scroll?target=&y=&direction=': 'GET - 滚动页面',
          '/screenshot?target=&save=1': 'GET - 截图（save=1 落代理 shots/；否则响应体回图片字节）',
        },
      }));
    }
  } catch (e) {
    const msg = String((e && e.message) || '');
    if (msg.startsWith('BODY_TOO_LARGE')) {
      // 请求体没读完就抛了：这条连接上还有半截上传。若让客户端 keep-alive 复用，
      // 残流会变成下一条请求眼前的 RST（回归里 T25 就是这么被误伤的）。
      res.setHeader('Connection', 'close');
      res.statusCode = 413;
      res.end(JSON.stringify({ error: msg }));
      setTimeout(() => req.destroy(), 50).unref?.();
      return;
    }
    res.statusCode = msg.startsWith('UNMANAGED_TAB') ? 403 : 500;
    res.end(JSON.stringify({ error: e.message }));
  }
});

// 检查端口是否被占用
function checkPortAvailable(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.once('listening', () => { s.close(); resolve(true); });
    s.listen(port, '127.0.0.1');
  });
}

async function main() {
  // 检查是否已有 proxy 在运行
  const available = await checkPortAvailable(PORT);
  if (!available) {
    // 验证已有实例是否健康
    try {
      const ok = await new Promise((resolve) => {
        http.get(`http://127.0.0.1:${PORT}/health`, { timeout: 2000 }, (res) => {
          let d = '';
          res.on('data', c => d += c);
          res.on('end', () => resolve(d.includes('"ok"')));
        }).on('error', () => resolve(false));
      });
      if (ok) {
        console.log(`[CDP Proxy] 已有实例运行在端口 ${PORT}，退出`);
        process.exit(0);
      }
    } catch { /* 端口占用但非 proxy，继续报错 */ }
    console.error(`[CDP Proxy] 端口 ${PORT} 已被占用`);
    process.exit(1);
  }

  if (!TOKEN_ENFORCE) {
    console.error('[CDP Proxy] 警告：HTTP API 未启用 token 鉴权（WEB_ACCESS_TOKEN_ENFORCE 不为 1）—— 本机任意进程含网页写请求仍可驱动浏览器。');
  }
  await initAgentServer();

  server.listen(PORT, '127.0.0.1', () => {
    console.log(`[CDP Proxy] 运行在 http://localhost:${PORT}`);
    // 启动时尝试连接 Chrome（非阻塞）
    connect().catch(e => { lastError = e.message; console.error('[CDP Proxy] 初始连接失败:', e.message, '（将在首次请求时重试）'); });
  });

  // 定时清理闲置 tab
  const cleanupTimer = setInterval(cleanupIdleTabs, CLEANUP_INTERVAL);
  cleanupTimer.unref();

  const shutdown = async (sig) => {
    console.log(`[CDP Proxy] ${sig}, cleaning up...`);
    clearInterval(cleanupTimer);
    await closeAllManagedTabs();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

// 防止未捕获异常导致进程崩溃
process.on('uncaughtException', (e) => {
  console.error('[CDP Proxy] 未捕获异常:', e.message);
});
process.on('unhandledRejection', (e) => {
  console.error('[CDP Proxy] 未处理拒绝:', e?.message || e);
});

main();
