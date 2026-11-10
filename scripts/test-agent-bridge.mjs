// 扩展桥回归测试：不依赖真浏览器，自己起一个代理实例、扮演扩展客户端，验证挂接规则与分流。
// 跑法：node scripts/test-agent-bridge.mjs
// 关键用例是 T6：接管失联连接时，旧 socket 迟到的 close 不得把新 agent 抹掉（审查发现的竞态）。
// 自 config.env 拨上 WEB_ACCESS_TOKEN_ENFORCE=1 后，本套件全程在鉴权打开状态下跑（见 AUTH）。

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import WebSocket from 'ws';

// 端口预探测（2026-09-22 实测教训）：本机软件会抢固定端口（QQNT 抢过 4001），
// 子进程 EADDRINUSE 会被 cdp-proxy 的 uncaughtException 吞掉 → 僵尸无监听，
// 测试请求打到别人端口被 RST，套件在 156 行崩。被占则顺延找空闲端口。
async function freePort(from) {
  for (let p = from; p < from + 50; p++) {
    const usable = await new Promise((resolve) => {
      const probe = net.createServer();
      probe.once('error', () => resolve(false));
      probe.once('listening', () => probe.close(() => resolve(true)));
      probe.listen(p, '127.0.0.1');
    });
    if (usable) return p;
  }
  throw new Error(`no free port in ${from}..${from + 49}`);
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = await freePort(3999);
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN_PORT = await freePort(4001);
const DEAD_PORT = TOKEN_PORT + 1;
const TOKEN_BASE = `http://127.0.0.1:${TOKEN_PORT}`;
const TOKEN_VAL = 'regression-test-token-0123456789';
const PINNED = 'chrome-extension://iaappcdoajokfdnpghgkmngcboceoegd';
const STALE_MS = 2500;

const results = [];
const ok = (name, pass, detail) => { results.push({ name, pass, detail }); console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`); };

// 截图落盘指到临时目录：harness 沙箱不让测试子进程写 C:\dsh 树，save=1 的行为照样全验。
const shotsTmp = path.join(os.tmpdir(), 'dsh-wa-bridge-shots');
// config.env 已拨 WEB_ACCESS_TOKEN_ENFORCE=1（OR 语义，测试 env 关不掉）：
// 主功能实例也起在鉴权打开状态，token 指到临时文件（绝不读真 proxy.token），所有功能请求带 header。
const tokenFile = path.join(os.tmpdir(), 'dsh-wa-bridge-test.token');
fs.writeFileSync(tokenFile, TOKEN_VAL);
const AUTH = { 'x-web-access-token': TOKEN_VAL };
const child = spawn(process.execPath, [path.join(ROOT, 'scripts', 'cdp-proxy.mjs')], {
  cwd: ROOT,
  env: { ...process.env, CDP_PROXY_PORT: String(PORT), CDP_AGENT_STALE_MS: String(STALE_MS), WEB_ACCESS_SHOTS_DIR: shotsTmp, WEB_ACCESS_TOKEN_FILE: tokenFile },
  stdio: ['ignore', 'ignore', 'inherit'],
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function health() { return (await fetch(`${BASE}/health`, { headers: AUTH })).json(); }
for (let i = 0; i < 40; i++) { try { if ((await health()).status === 'ok') break; } catch { await sleep(300); } }

function agent(origin, version) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/agent`, origin ? { headers: { Origin: origin } } : {});
    const api = { ws, version, sent: [], open: false, rejected: null };
    ws.on('unexpected-response', (_req, res) => { api.rejected = res.statusCode; resolve(api); });
    ws.on('error', (e) => { api.rejected = api.rejected || e.code || e.message; resolve(api); });
    ws.on('open', () => {
      api.open = true;
      ws.send(JSON.stringify({ type: 'hello', role: 'dsh-web-access-bridge', version, chrome: 'test', extensionId: 'x' }));
      ws.on('message', (d) => {
        const m = JSON.parse(String(d));
        api.sent.push(m.type);
        if (m.type === 'ping') ws.send(JSON.stringify({ type: 'pong', id: m.id, at: Date.now() }));
        if (m.type === 'command') {
          // 模拟扩展侧托管名单：非登记的 tabId 一律报 UNMANAGED_TAB（代理应映射为 403）
          const NEEDS = ['tab.eval', 'tab.close', 'tab.navigate', 'tab.screenshot', 'tab.detach'];
          if (NEEDS.includes(m.kind) && m.tabId === 999) {
            ws.send(JSON.stringify({ type: 'result', id: m.id, ok: false, error: 'UNMANAGED_TAB:999' }));
            return;
          }
          const result = m.kind === 'tabs.list'
            ? { tabs: [{ targetId: '123', type: 'page', title: 'T', url: 'https://example.test/' }] }
            : m.kind === 'tab.close'
              ? { success: true, closed: m.tabId }
              : m.kind === 'tab.eval'
              ? { value: `from-agent:${version}` }
              : m.kind === 'tab.screenshot'
              ? { data: Buffer.from('fake-png-bytes').toString('base64'), format: 'png' }
              : {};
          ws.send(JSON.stringify({ type: 'result', id: m.id, ok: true, result }));
        }
      });
      resolve(api);
    });
  });
}

// T1-T3 origin 门
for (const [label, origin] of [['错误 origin', 'http://evil.example'], ['无 origin', null], ['别的扩展 ID', 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa']]) {
  const a = await agent(origin, 'x');
  ok(`T1-3 ${label} 被拒`, a.rejected === 403, `结果=${a.rejected}`);
}

// T4 钉定 origin 挂上
const A = await agent(PINNED, 'A');
let h = await health();
ok('T4 钉定 origin 挂接成功', A.open && h.agentConnected && h.transport === 'extension', `transport=${h.transport} version=${h.agent && h.agent.version}`);

// T5 新鲜连接时第二个被拒
const dup = await agent(PINNED, 'dup');
ok('T5 已有活 agent 时第二个握手期被拒', dup.rejected === 403, `结果=${dup.rejected}`);

// T6 竞态：A 只发垃圾消息（不心跳），B 应能接管，且 A 迟到的 close 不能抹掉 B
const junk = setInterval(() => { try { A.ws.send(JSON.stringify({ type: 'noise', pad: 'x'.repeat(50) })); } catch { /* 已关 */ } }, 400);
await sleep(STALE_MS + 900);
const B = await agent(PINNED, 'B');
ok('T6a 垃圾消息不能续命（B 得以接管）', B.open, `B.open=${B.open} rejected=${B.rejected}`);
await sleep(1200); // 等 A 的 close 事件迟到触发
h = await health();
ok('T6b 旧 socket 迟到的 close 未抹掉新 agent', h.agentConnected && h.agent && h.agent.version === 'B', `agentConnected=${h.agentConnected} version=${h.agent && h.agent.version}`);
clearInterval(junk);
try { A.ws.terminate(); } catch { /* ignore */ }

// T8 数字 target 走扩展通道
const info = await fetch(`${BASE}/info?target=123`, { headers: AUTH });
const infoText = await info.text();
ok('T8 数字 target 由扩展应答', infoText.includes('from-agent:B'), infoText.slice(0, 60));

// T9 不变量：扩展通道活着时，任何端点都不许返回 501、也不许悄悄掉进下面的 CDP 分支
// （数字 target 在 CDP 侧不存在，回落只会产出与真因无关的报错）
const probes = [
  ['GET', '/targets'],
  ['GET', '/info?target=123'],
  ['POST', '/eval?target=123'],
  ['GET', '/close?target=123'],
  ['POST', '/click?target=123'],
  ['GET', '/scroll?target=123&direction=down'],
  ['GET', '/back?target=123'],
];
const fellThrough = [];
for (const [m, p] of probes) {
  const r = await fetch(BASE + p, m === 'POST' ? { method: 'POST', body: p.includes('eval') ? "document.title" : 'h1', headers: AUTH } : { headers: AUTH });
  const txt = await r.text();
  if (r.status === 501 || /WebSocket 未连接|连不上浏览器|CDP 命令超时/.test(txt)) fellThrough.push(`${m} ${p} -> ${r.status} ${txt.slice(0, 40)}`);
}
ok('T9 没有端点回落到 CDP 或返回 501', fellThrough.length === 0, fellThrough.join(' ; ') || '7 条全部由扩展应答');

// T11-T14 关闭 / 点击 / 滚动 / 后退都必须由扩展应答，不能再报 501 或掉进 CDP
const cl = await fetch(`${BASE}/close?target=123`, { method: 'GET', headers: AUTH });
const clj = await cl.json().catch(() => ({}));
ok('T11 /close 走扩展且报告成功', cl.status === 200 && clj.success === true, `${cl.status} ${JSON.stringify(clj).slice(0, 60)}`);
const ck = await fetch(`${BASE}/click?target=123`, { method: 'POST', body: 'h1', headers: AUTH });
const ckj = await ck.json().catch(() => ({}));
ok('T12 /click 由扩展应答（无 501）', ck.status === 200 && String(ckj.value || '').includes('from-agent:B'), `${ck.status} ${JSON.stringify(ckj).slice(0, 60)}`);
const sc = await fetch(`${BASE}/scroll?target=123&direction=down&y=800`, { headers: AUTH });
ok('T13 /scroll 由扩展应答', sc.status === 200, String(sc.status));
const bk = await fetch(`${BASE}/back?target=123`, { headers: AUTH });
const bkj = await bk.json().catch(() => ({}));
ok('T14 /back 由扩展应答', bk.status === 200 && bkj.ok === true, `${bk.status} ${JSON.stringify(bkj).slice(0, 40)}`);

// T10 /targets 走扩展
const tl = await (await fetch(`${BASE}/targets`, { headers: AUTH })).json();
ok('T10 /targets 走扩展通道', Array.isArray(tl) && tl[0] && tl[0].targetId === '123', JSON.stringify(tl).slice(0, 60));

// ---- token 门：独立第二个实例（WEB_ACCESS_TOKEN_ENFORCE=1）----
const tchild = spawn(process.execPath, [path.join(ROOT, 'scripts', 'cdp-proxy.mjs')], {
  cwd: ROOT,
  env: { ...process.env, CDP_PROXY_PORT: String(TOKEN_PORT), WEB_ACCESS_TOKEN_ENFORCE: '1', WEB_ACCESS_TOKEN_FILE: tokenFile },
  stdio: ['ignore', 'ignore', 'ignore'],
});
let tReady = false;
for (let i = 0; i < 40; i++) {
  try { if ((await (await fetch(TOKEN_BASE + '/health')).json()).status === 'ok') { tReady = true; break; } } catch { await sleep(300); }
}
const hNoAuth = await (await fetch(TOKEN_BASE + '/health')).json();
ok('T15 ENFORCE=1 时 /health 只回最小字段（无 token）', tReady && hNoAuth.tokenEnforced === true && hNoAuth.chromePort === undefined && hNoAuth.lastError === undefined && hNoAuth.agent === undefined, JSON.stringify(hNoAuth).slice(0, 80));
const r401 = await fetch(TOKEN_BASE + '/targets');
ok('T16 非 /health 无 token 一律 401', r401.status === 401, String(r401.status));
const r401b = await fetch(TOKEN_BASE + '/targets', { headers: { 'x-web-access-token': 'wrong-token' } });
ok('T16b 错 token 也 401', r401b.status === 401, String(r401b.status));
const rAuth = await fetch(TOKEN_BASE + '/health', { headers: { 'x-web-access-token': TOKEN_VAL } });
const hAuth = await rAuth.json();
ok('T17 对 token 的 /health 才回完整诊断', rAuth.status === 200 && hAuth.tokenEnforced === true && 'chromePort' in hAuth, JSON.stringify(hAuth).slice(0, 80));
try { tchild.kill(); } catch { /* ignore */ }

// T18 ENFORCE=1 且 token 文件缺失 → 拒绝启动（fail-closed，不许静默裸奔）
const deadChild = spawn(process.execPath, [path.join(ROOT, 'scripts', 'cdp-proxy.mjs')], {
  cwd: ROOT,
  env: { ...process.env, CDP_PROXY_PORT: String(DEAD_PORT), WEB_ACCESS_TOKEN_ENFORCE: '1', WEB_ACCESS_TOKEN_FILE: tokenFile + '.nonexistent' },
  stdio: ['ignore', 'ignore', 'ignore'],
});
const exitCode18 = await new Promise((resolve) => {
  const to = setTimeout(() => resolve('alive'), 3000);
  deadChild.on('exit', (c) => { clearTimeout(to); resolve(c); });
});
ok('T18 token 缺失时拒绝启动（硬退出非 0）', exitCode18 !== 'alive' && typeof exitCode18 === 'number' && exitCode18 !== 0, `exit=${exitCode18}`);

// T19 /screenshot?file= 任意路径已移除
const sf = await fetch(BASE + '/screenshot?target=123&file=C:\\evil\\x.png', { headers: AUTH });
ok('T19 /screenshot?file= 被 400 拒绝', sf.status === 400, String(sf.status));

// T20 未托管标签 → 403（假扩展按约定报 UNMANAGED_TAB，代理负责映射）
const un = await fetch(BASE + '/scroll?target=999&direction=down', { headers: AUTH });
ok('T20 UNMANAGED_TAB 映射为 403', un.status === 403, String(un.status));

// T21 save=1 落 shots/、文件名服务端生成
const sv = await (await fetch(BASE + '/screenshot?target=123&save=1', { headers: AUTH })).json();
ok('T21 save=1 返回服务端生成文件名且落在 shots 目录内', typeof sv.path === 'string' && sv.path.replace(/\\/g, '/').startsWith(shotsTmp.replace(/\\/g, '/')) && /^shot-\d+-\d+\.png$/.test(sv.saved || '') && sv.bytes > 0, JSON.stringify(sv).slice(0, 100));
try { fs.unlinkSync(sv.path); } catch { /* ignore */ }

// T22 GET /eval 被拒（曾被 q.expr 兼容，一条 <img src> 就能触发）
const evGet = await fetch(BASE + '/eval?target=123&expr=1', { headers: AUTH });
ok('T22 GET /eval 返回 405', evGet.status === 405, String(evGet.status));

// T23 超大 body 有上限（readBody 护栏，2MB）。必须用不接管的独立连接（Connection: close）：
// 服务端在请求体读到一半时就回 413 了，残留的上传字节会让 keep-alive 复用者吃到 RST（T25 曾被误伤）。
const big = await fetch(BASE + '/eval?target=123', { method: 'POST', body: 'x'.repeat(3 * 1024 * 1024), headers: { Connection: 'close', 'x-web-access-token': TOKEN_VAL } });
ok('T23 超大请求体返回 413', big.status === 413, String(big.status));

// T24 hex target 的 /navigate 必须落回 CDP（旧版把 tabId:null 发进扩展，20s 轮询狂发命令）
const navHex = await fetch(BASE + '/navigate?target=ffffffffffffffffffffffffffffffff', { method: 'POST', body: 'https://example.invalid/', headers: AUTH });
const navTxt = await navHex.text();
ok('T24 hex /navigate 不进扩展通道', navHex.status !== 200 && !navTxt.includes('from-agent'), `${navHex.status} ${navTxt.slice(0, 60)}`);

// T25 '0x10' 经 Number 强转是整数 16 —— 分流必须按字符串形状，不按 Number() 语义
const hexish = await fetch(BASE + '/info?target=0x10', { headers: AUTH });
const hexTxt = await hexish.text();
ok('T25 非纯数字 target 不误入扩展分支', !hexTxt.includes('from-agent'), `${hexish.status} ${hexTxt.slice(0, 60)}`);

try { B.ws.terminate(); } catch { /* ignore */ }
child.kill();
try { fs.unlinkSync(tokenFile); } catch { /* ignore */ }
const failed = results.filter((r) => !r.pass);
console.log(`\n合计 ${results.length} 项，失败 ${failed.length} 项`);
process.exit(failed.length ? 1 : 0);
