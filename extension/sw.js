// dsh-web-access bridge —— MV3 service worker
//
// 职责边界很小：连上本机代理的 WebSocket，接指令，回结果。它自己不做任何页面注入，
// 也不读写站点数据 —— M1 只到「握手 + 报活」，chrome.debugger 的分发在 M2 再接。
//
// 为什么用扩展而不是调试端口：CDP 端口那道 Origin 门（Chrome 要求
// --remote-allow-origins）是绕不过去的，而 chrome.debugger 是浏览器内部的特权 API，
// 扩展调用它不经过那条门，也就不需要给日常浏览器加启动参数。
//
// MV3 的坑：service worker 空闲约 30 秒会被杀，WebSocket 随之断开。所以三层保活：
// 定时器里调一次轻量扩展 API（任何 API 调用都会重置空闲计时器）+ chrome.alarms 兜底
// 唤醒 + onclose 指数退避重连。最坏情况是冷启动后要等一个 alarm 周期才连上。

const PROXY_WS = 'ws://127.0.0.1:3456/agent';
const KEEPALIVE_MS = 20000;
const ALARM = 'dsh-web-access-keepalive';

let ws = null;
let backoff = 1000;
let reconnectTimer = null;

function log(...args) {
  try { console.log('[web-access bridge]', ...args); } catch { /* 日志不该影响流程 */ }
}

// --- chrome.debugger 分发 ---
// 能力按 kind 逐个开（列/建/导航/求值/截图/关闭/detach），没有通用 sendCommand 透传口：
// 口子越大，代理一旦被冒充，能造成的破坏越大。attach 状态本地记一份，断连时清掉。
const attached = new Set();

// 托管标签（allowlist）：只有本桥创建的标签可被读取/执行/关闭。
// 代理侧虽然登记 managedTabs，但权限边界必须落在「执行者」这里 —— 否则代理一旦被冒充、
// 或被注入的页面诱导宿主发出工具调用，任意数字 tabId 就能对已登录页面 attach+eval。
// 错误前缀 UNMANAGED_TAB 是与代理侧的约定：代理把它映射成 403。
// 用 chrome.storage.session 持久化：service worker 被杀后唤醒可恢复，浏览器退出即清零（标签也没了）。
const MANAGED_KEY = 'managedTabIds';
let managed = new Set();
let managedLoaded = false;
let managedLoading = null;

function loadManaged() {
  if (managedLoaded) return Promise.resolve();
  // 单飞 + 合并而不是覆盖：并发 load 与 tab.create 时，整集覆盖会把刚登记的 ID 踢出白名单
  // （SW 约 30 秒就被杀，冷启动是常态，这个竞态迟早会撞上）
  if (!managedLoading) {
    managedLoading = (async () => {
      try {
        const o = await chrome.storage.session.get(MANAGED_KEY);
        const arr = Array.isArray(o[MANAGED_KEY]) ? o[MANAGED_KEY] : [];
        for (const n of arr.map(Number)) managed.add(n);
        // 只有成功才 mark loaded：storage 一次抖动不该把扩展永久锁成"全 403"
        managedLoaded = true;
      } catch { /* 下次调用会再试 */ }
      finally { managedLoading = null; }
    })();
  }
  return managedLoading;
}

function persistManaged() {
  try { return chrome.storage.session.set({ [MANAGED_KEY]: [...managed] }); }
  catch { return Promise.resolve(); }
}

async function requireManaged(tabId) {
  await loadManaged();
  if (!managed.has(tabId)) {
    throw new Error('UNMANAGED_TAB: 标签 ' + tabId + ' 不是本桥创建的（默认只允许操作托管标签；对既有标签的显式授权能力在 backlog）');
  }
}

function dbg(target, method, params) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand(target, method, params || {}, (r) => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(`${method}: ${err.message}`));
      else resolve(r);
    });
  });
}

async function ensureAttached(tabId) {
  if (attached.has(tabId)) return;
  await new Promise((resolve, reject) => {
    chrome.debugger.attach({ tabId }, '1.3', () => {
      const err = chrome.runtime.lastError;
      // "Another debugger is already attached" 也算可用：代理可能重启过
      if (err && !/already attached/i.test(err.message)) reject(new Error(err.message));
      else resolve();
    });
  });
  await dbg({ tabId }, 'Runtime.enable');
  await dbg({ tabId }, 'Page.enable');
  attached.add(tabId);
}

async function run(cmd) {
  const tabId = Number(cmd.tabId);
  switch (cmd.kind) {
    case 'tabs.list': {
      await loadManaged();
      const tabs = await chrome.tabs.query({});
      return {
        tabs: tabs
          .filter((t) => Number.isInteger(t.id) && managed.has(t.id))
          .map((t) => ({ targetId: String(t.id), type: 'page', title: t.title || '', url: t.url || '', active: !!t.active, windowId: t.windowId })),
      };
    }
    case 'tab.eval': {
      if (!Number.isInteger(tabId)) throw new Error('缺少或非法的 tabId');
      if (typeof cmd.expression !== 'string' || !cmd.expression) throw new Error('缺少 expression');
      await requireManaged(tabId);
      await ensureAttached(tabId);
      const r = await dbg({ tabId }, 'Runtime.evaluate', {
        expression: cmd.expression, returnByValue: true, awaitPromise: true,
      });
      if (r && r.exceptionDetails) {
        // text 常常只剩 "Uncaught"，真消息在 exception.description 里（带异常名与首行）
        const d = r.exceptionDetails;
        throw new Error(`页面脚本异常：${d.exception?.description || d.text || 'Exception'}`);
      }
      return { value: r && r.result ? r.result.value : undefined };
    }
    case 'tab.create': {
      // 后台新建空白页。与 CDP 路径同一个讲究：先空白页再导航，否则慢页面会被
      // about:blank 的 readyState=complete 抢先误判成"已加载完"。
      const tab = await chrome.tabs.create({ url: 'about:blank', active: false });
      if (!Number.isInteger(tab.id)) throw new Error('chrome.tabs.create 没返回标签 ID');
      await loadManaged(); // 先载入再登记：否则随后的 persist 会用不含新 ID 的旧快照覆盖存储
      managed.add(tab.id);
      await persistManaged();
      return { targetId: String(tab.id), tabId: tab.id };
    }
    case 'tab.navigate': {
      if (!Number.isInteger(tabId)) throw new Error('缺少或非法的 tabId');
      if (typeof cmd.url !== 'string' || !cmd.url) throw new Error('缺少 url');
      await requireManaged(tabId);
      await chrome.tabs.update(tabId, { url: cmd.url });
      return { navigated: tabId, url: cmd.url };
    }
    case 'tab.screenshot': {
      if (!Number.isInteger(tabId)) throw new Error('缺少或非法的 tabId');
      await requireManaged(tabId);
      await ensureAttached(tabId);
      const format = cmd.format === 'jpeg' ? 'jpeg' : 'png';
      const r = await dbg({ tabId }, 'Page.captureScreenshot', {
        format,
        ...(format === 'jpeg' ? { quality: Number(cmd.quality) || 80 } : {}),
        // 默认只截视口，与 CDP 通道保持一致：同一个 web_shot 换个通道不该换取景范围。
        // 整页要显式 full=1（后台标签确实能截到整页，探测已验证）。
        captureBeyondViewport: cmd.full === true,
      });
      if (!r || !r.data) throw new Error('captureScreenshot 没有返回数据');
      return { data: r.data, format, width: r.width, height: r.height };
    }
    case 'tab.close': {
      if (!Number.isInteger(tabId)) throw new Error('缺少或非法的 tabId');
      await requireManaged(tabId);
      await chrome.tabs.remove(tabId);
      attached.delete(tabId);
      managed.delete(tabId);
      await persistManaged();
      return { success: true, closed: tabId };
    }
    case 'tab.detach': {
      if (!Number.isInteger(tabId)) throw new Error('缺少或非法的 tabId');
      await requireManaged(tabId);
      await new Promise((resolve) => { chrome.debugger.detach({ tabId }, () => resolve()); });
      attached.delete(tabId);
      return { detached: tabId };
    }
    default:
      throw new Error(`未实现的能力：${cmd.kind}`);
  }
}

// 用户在横幅上点了「取消」或关掉标签：本地状态要跟着清，否则会一直以为还连着
chrome.debugger.onDetach.addListener((source) => {
  if (source && Number.isInteger(source.tabId)) attached.delete(source.tabId);
});
chrome.tabs.onRemoved.addListener((id) => {
  attached.delete(id);
  if (managed.delete(id)) persistManaged();
});

function chromeVersion() {
  try { return (navigator.userAgent.match(/Chrome\/([\d.]+)/) || [])[1] || null; }
  catch { return null; }
}

function send(obj) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  try { ws.send(JSON.stringify(obj)); return true; }
  catch (e) { log('发送失败', e && e.message); return false; }
}

function schedule(delay) {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, delay);
}

function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  try { ws = new WebSocket(PROXY_WS); }
  catch (e) { log('构造 WebSocket 失败', e && e.message); schedule(backoff); return; }

  ws.onopen = () => {
    backoff = 1000;
    log('已连接代理');
    send({
      type: 'hello',
      role: 'dsh-web-access-bridge',
      version: chrome.runtime.getManifest().version,
      chrome: chromeVersion(),
      extensionId: chrome.runtime.id,
      sentAt: Date.now(),
    });
  };
  ws.onmessage = (ev) => {
    let msg = null;
    try { msg = JSON.parse(String(ev.data)); } catch { return; }
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'ping') { send({ type: 'pong', id: msg.id ?? null, at: Date.now(), echo: msg.at ?? null }); return; }
    if (msg.type === 'status') {
      chrome.tabs.query({}, (tabs) => {
        send({
          type: 'status',
          id: msg.id ?? null,
          at: Date.now(),
          tabCount: Array.isArray(tabs) ? tabs.length : 0,
          activeWindowId: chrome.windows.WINDOW_ID_NONE,
        });
      });
      return;
    }
    if (msg.type === 'command') {
      run(msg).then((result) => {
        send({ type: 'result', id: msg.id, ok: true, result });
      }).catch((e) => {
        log('命令失败', msg.kind, e && e.message);
        send({ type: 'result', id: msg.id, ok: false, error: String((e && e.message) || e) });
      });
    }
  };
  ws.onclose = () => { ws = null; schedule(backoff); backoff = Math.min(backoff * 2, 15000); };
  ws.onerror = () => { try { if (ws) ws.close(); } catch { /* 已断开 */ } };
}

function keepAliveTick() {
  // 轻量 API 调用即可重置空闲计时器
  try { chrome.runtime.getPlatformInfo(() => { void chrome.runtime.lastError; }); } catch { /* ignore */ }
  connect();
  // 心跳同时给代理刷新"最后一次听到你"的时间。缺了它，一个活着但空闲的扩展会在 45 秒后
  // 被判定失联、允许被第二个连接接管 —— 那等于把单扩展守卫变成"闲置即让位"。
  send({ type: 'heartbeat', at: Date.now() });
}

chrome.alarms.create(ALARM, { periodInMinutes: KEEPALIVE_MS / 60000 });
chrome.alarms.onAlarm.addListener((a) => { if (a.name === ALARM) keepAliveTick(); });
chrome.runtime.onInstalled.addListener(() => { log('已安装/更新，准备连接代理'); connect(); });
chrome.runtime.onStartup.addListener(() => connect());
setInterval(keepAliveTick, KEEPALIVE_MS);
connect();
