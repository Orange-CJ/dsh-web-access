// dsh-web-access — DSH 宿主插件（常驻，随 profile 加载）
//
// 给 DSH 接上用户自己的浏览器：通过 CDP 直连，天然带登录态。
// CDP Proxy 脚本复用 eze-is/web-access（MIT）；本文件是宿主插件本体，独立编写。
//
// 与临时动态版的区别：这里跑在完整 Node 环境里，
// fetch / child_process / fs / AbortSignal 都有，所以不需要子进程桥接那一层。
//
// 代理进程刻意常驻、不在插件卸载时杀：浏览器授予的远程调试授权绑在代理上，
// 掐掉它下次就得重新授权。要停就手动 taskkill（pid 在 proxy.pid）。

import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';

const execFileAsync = promisify(execFile);

export const name = 'dsh-web-access';
export const inject = ['tools'];

const DEFAULT_ROOT = 'C:\\dsh\\web-access';
const PROXY = 'http://127.0.0.1:3456';

// 刻意不 import @deepseek-ai/dsh-tools 的 defineTool。
// 本包以 link: 装在 profile 之外，Node 解析模块时用真实路径向上找，
// 够不到 profile 的共享依赖池（$DSH_HOME\profiles\node_modules）→
// ERR_MODULE_NOT_FOUND → 整个 harness 一票否决起不来（09-19 真崩过一次）。
// 这里自带等价实现：把简化参数格式编译成 JSON Schema。dsh-ppt 也是这么做的。
function compileParameters(spec) {
  const properties = {};
  const required = [];
  for (const [key, prop] of Object.entries(spec || {})) {
    const field = prop || {};
    if (field.required === true) required.push(key);
    const node = {};
    if (typeof field.type === 'string') node.type = field.type;
    if (typeof field.description === 'string') node.description = field.description;
    if (Array.isArray(field.enum)) node.enum = field.enum;
    if (field.type === 'array' && field.items && typeof field.items === 'object') {
      node.items = { type: 'object', additionalProperties: true };
    }
    properties[key] = node;
  }
  return { type: 'object', properties, ...(required.length > 0 ? { required } : {}) };
}

function defineTool(options) {
  const output = options.output || {};
  // output.schema 是 spec 方言：{type:'json'} 表示「任意 JSON」，官方的
  // valueSchemaSpecToJsonSchema 会把它转成 {}。直接 register 需要合法 JSON Schema
  // （schema.type 只认 object/array/string/number/integer/boolean/null），
  // 所以这里做同样的转换——否则 register 抛 unsupported JSON schema，且错误被静默吞掉。
  const schema = output.schema && output.schema.type === 'json' ? {} : output.schema;
  return {
    ...options,
    parameters: compileParameters(options.parameters),
    output: { ...output, schema },
  };
}

const textOut = (_args, value) => [{ type: 'text', text: JSON.stringify(value) }];

export function apply(ctx, config = {}) {
  const ROOT = String(config.root || DEFAULT_ROOT);
  const SITES = path.join(ROOT, 'sites');
  const SHOTS = path.join(ROOT, 'shots');
  const PID_FILE = path.join(ROOT, 'proxy.pid');
  const LOG_FILE = path.join(ROOT, 'proxy.log');
  const PROXY_SCRIPT = path.join(ROOT, 'scripts', 'cdp-proxy.mjs');

  // 代理的 HTTP API 现在要求共享 token（它原本对本机任意进程、乃至任意网页的写请求
  // 敞开）。配置只有一份：C:\dsh\web-access\config.env，由代理与本插件共同读取。
  function readProxyToken() {
    // 私密值放每机生成的 proxy.token（已 gitignore），不写进被跟踪的 config.env；
    // 开关 WEB_ACCESS_TOKEN_ENFORCE 决定代理那边是否真的校验它。代理是 fail-closed 的：
    // 开关为 1 而 token 缺失时代理直接拒启动，这里读不到也应如实返回空（届时 web_* 全部 401，比静默裸奔好）。
    try {
      const cfg = fs.readFileSync(path.join(ROOT, 'config.env'), 'utf8');
      const on = /^WEB_ACCESS_TOKEN_ENFORCE=(.+)$/m.exec(cfg);
      const enforce = (on && on[1].trim() === '1') || String(process.env.WEB_ACCESS_TOKEN_ENFORCE || '').trim() === '1';
      if (!enforce) return '';
      const tf = /^WEB_ACCESS_TOKEN_FILE=(.+)$/m.exec(cfg);
      const file = (tf && tf[1].trim()) || process.env.WEB_ACCESS_TOKEN_FILE || path.join(ROOT, 'proxy.token');
      return fs.readFileSync(file, 'utf8').trim();
    } catch {
      return '';
    }
  }
  // token 每次 call 现读（见下）：轮换 token 或拨开关后宿主不必重启就能跟上。
  // 旧版在 apply 时读一次，时序错位会一路 401 到下次重启。
  const FIND_URL_SCRIPT = path.join(ROOT, 'scripts', 'find-url.mjs');

  let lastTabId = null;
  const mineTabs = new Set();

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const warn = (message) => {
    try {
      ctx.logger?.warn?.(message);
    } catch {
      /* 日志不该影响主流程 */
    }
  };

  // ---------------------------------------------------------------- HTTP

  async function call(pathname, opts = {}) {
    try {
      const headers = {};
      const token = readProxyToken();
      if (token) headers['x-web-access-token'] = token;
      const res = await fetch(PROXY + pathname, {
        method: opts.method || 'GET',
        headers,
        body: opts.body === undefined || opts.body === null ? undefined : String(opts.body),
        signal: AbortSignal.timeout(opts.timeout || 40000),
      });
      const text = await res.text();
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {
        /* 非 JSON（截图等） */
      }
      return { ok: true, status: res.status, json, text: text.slice(0, 3000) };
    } catch (error) {
      return { ok: false, error: (error && error.message) || String(error) };
    }
  }

  async function health() {
    const res = await call('/health', { timeout: 3000 });
    return res.ok && res.json && res.json.status === 'ok' ? res.json : null;
  }

  // 两条通道任一可用就算「连上浏览器」：CDP 调试端口，或扩展桥（chrome.debugger）。
  const usable = (h) => Boolean(h && (h.connected || h.agentConnected));

  // ------------------------------------------------------- 代理生命周期

  function readPid() {
    try {
      const n = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
      return Number.isInteger(n) && n > 0 ? n : null;
    } catch {
      return null;
    }
  }

  function spawnProxy() {
    const old = readPid();
    if (old) {
      try {
        process.kill(old);
      } catch {
        /* 早就没了 */
      }
    }
    const fd = fs.openSync(LOG_FILE, 'a');
    try {
      const child = spawn(process.execPath, [PROXY_SCRIPT], {
        cwd: ROOT,
        stdio: ['ignore', fd, fd],
        detached: true,
        windowsHide: true,
      });
      child.unref();
      fs.writeFileSync(PID_FILE, String(child.pid), 'utf8');
      return child.pid;
    } finally {
      fs.closeSync(fd);
    }
  }

  const BROWSER_HINT =
    '两种修法：(1) 在浏览器地址栏打开 chrome://inspect/#remote-debugging（Edge 用 edge://），' +
    '勾选 "Allow remote debugging for this browser instance"，必要时重启浏览器；' +
    '(2) 若勾选后仍连不上，多半是 Chrome 拒绝了调试来源（它要求启动时带 --remote-allow-origins）——' +
    '可用独立 profile 起一个调试实例：chrome --user-data-dir=<独立目录> ' +
    '--remote-debugging-port=9229 --remote-allow-origins=*，' +
    '并在 ' + path.join(ROOT, 'config.env') + ' 里写 WEB_ACCESS_PORT=9229。';

  // 代理 /health 里的诊断信息优先于通用提示：Chrome 给的拒绝原因只在这几个字段里
  function diagnose(h) {
    if (!h) return '';
    const parts = [];
    if (h.lastError) parts.push('代理最后一次失败原因：' + h.lastError);
    if (Array.isArray(h.rejected)) {
      for (const r of h.rejected) parts.push(`${r.label}(端口 ${r.port})：${r.reason}`);
    }
    return parts.length ? ' ' + parts.join('；') + '。' : '';
  }

  async function ensureProxy() {
    const h = await health();
    if (h) {
      // 最小形状 /health 说明：代理开了 token 强制，而宿主这边没读到可用 token —— 真因是 401，不是连不上浏览器
      if (h.tokenEnforced === true && h.agentConnected === undefined) {
        return {
          ok: false,
          error: '代理已启用 token 鉴权，但宿主未读到 proxy.token（请求都会被 401 拒绝）。检查 config.env 的 WEB_ACCESS_TOKEN_ENFORCE 与 proxy.token 文件是否配套。',
        };
      }
      if (usable(h)) return { ok: true, health: h };
      return { ok: false, error: 'CDP 代理在运行，但连不上浏览器。' + diagnose(h) + BROWSER_HINT };
    }
    try {
      spawnProxy();
    } catch (error) {
      return { ok: false, error: '代理启动失败：' + ((error && error.message) || String(error)) };
    }
    for (let i = 0; i < 10; i++) {
      await sleep(1200);
      const p = await health();
      if (p && usable(p)) return { ok: true, health: p };
      if (p && !usable(p)) return { ok: false, error: 'CDP 代理已就绪，但两条通道都不可用。' + diagnose(p) + BROWSER_HINT };
    }
    return { ok: false, error: 'CDP 代理启动后无响应，日志：' + LOG_FILE };
  }

  async function pollReady(tabId, timeoutMs = 20000) {
    let elapsed = 0;
    let info = null;
    while (elapsed < timeoutMs) {
      const res = await call('/info?target=' + encodeURIComponent(tabId));
      if (res.ok && res.json) {
        info = res.json;
        if (info.ready === 'complete') return info;
      }
      await sleep(700);
      elapsed += 700;
    }
    return info;
  }

  // ---------------------------------------------------------- 站点笔记

  function resolveSite(domain) {
    const host = String(domain || '')
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, '')
      .split('/')[0]
      .split('?')[0]
      .split('#')[0]
      .split(':')[0];
    if (!/^[a-z0-9.-]+$/.test(host) || host.includes('..') || host.length > 200) return null;
    return { host, file: path.join(SITES, host + '.md') };
  }

  function readNote(domain) {
    const site = resolveSite(domain);
    if (!site) return { has: false };
    try {
      return { host: site.host, file: site.file, has: true, content: fs.readFileSync(site.file, 'utf8').slice(0, 4000) };
    } catch {
      return { host: site.host, has: false };
    }
  }

  function writeNote(domain, content) {
    const site = resolveSite(domain);
    if (!site) return { ok: false, error: '域名不合法' };
    if (!content) return { ok: false, error: '内容为空' };
    try {
      fs.mkdirSync(SITES, { recursive: true });
      let existing = '';
      try {
        existing = fs.readFileSync(site.file, 'utf8');
      } catch {
        /* 首次写入 */
      }
      const header = existing ? '' : '---\ndomain: ' + site.host + '\n---\n';
      const stamp = new Date().toISOString().slice(0, 10);
      fs.writeFileSync(site.file, existing + header + '\n## ' + stamp + '\n' + content + '\n', 'utf8');
      return { ok: true, host: site.host, file: site.file };
    } catch (error) {
      return { ok: false, error: (error && error.message) || String(error) };
    }
  }

  function hostOf(url) {
    try {
      return new URL(String(url)).hostname;
    } catch {
      return '';
    }
  }

  // ------------------------------------------------------------- 工具

  ctx.tools.register(
    defineTool({
      name: 'web_open',
      description:
        'Open a URL in a new background tab of the user own browser (carries their login state) and wait until the page reports ready. ' +
        'Returns the tabId used by the other web_* tools, plus any stored site note for that domain. Never touches the user existing tabs. ' +
        '中文：在用户自己的浏览器里新开一个后台标签并等页面就绪，返回 tabId（其它 web_* 工具用它）与该域名的站点笔记；绝不碰用户原有标签。',
      parameters: {
        url: { type: 'string', required: true, description: 'Full URL including any query parameters. 完整 URL，含查询参数。' },
      },
      output: { schema: { type: 'json' }, render: textOut },
      async execute(args) {
        const url = String((args && args.url) || '').trim();
        if (!url) return { error: 'url is required' };
        const gate = await ensureProxy();
        if (!gate.ok) return { error: gate.error };
        const created = await call('/new', { method: 'POST', body: url });
        const tabId = created.json && created.json.targetId;
        if (!tabId) return { error: '开页失败：' + (created.error || created.text || 'unknown') };
        mineTabs.add(tabId);
        lastTabId = tabId;
        const info = await pollReady(tabId);
        const host = hostOf(url);
        const note = host ? readNote(host) : { has: false };
        return {
          tabId,
          data: {
            title: (info && info.title) || '',
            url: (info && info.url) || url,
            ready: (info && info.ready) || 'unknown',
          },
          note: note.has ? note.content : '',
        };
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'web_page',
      description:
        'Read and drive the current page of one tab. op=info returns title/url/ready; op=eval runs JavaScript and returns the value ' +
        '(write (() => { return x })() for multi-statement code); op=click clicks a CSS selector; op=scroll scrolls (use direction, or y for a pixel delta). ' +
        '中文：读/驱动某个标签的当前页面——info 取标题网址就绪态，eval 执行 JS 取值，click 点 CSS 选择器，scroll 滚动。不传 tabId 就用最近一次 web_open 开的标签。',
      parameters: {
        tabId: { type: 'string', description: 'Tab id from web_open; omit to use the most recently opened tab.' },
        op: { type: 'string', enum: ['info', 'eval', 'click', 'scroll'], required: true, description: 'Which page operation to run.' },
        code: { type: 'string', description: 'JavaScript for op=eval.' },
        selector: { type: 'string', description: 'CSS selector for op=click.' },
        direction: { type: 'string', enum: ['down', 'up', 'top', 'bottom'], description: 'Scroll direction.' },
        y: { type: 'number', description: 'Pixel delta for op=scroll.' },
      },
      output: { schema: { type: 'json' }, render: textOut },
      async execute(args) {
        const a = args || {};
        const tabId = String(a.tabId || lastTabId || '');
        if (!tabId) return { error: '还没有标签：先调 web_open，或显式传 tabId' };
        const gate = await ensureProxy();
        if (!gate.ok) return { error: gate.error };
        const q = '?target=' + encodeURIComponent(tabId);
        if (a.op === 'info') {
          const res = await call('/info' + q);
          return { tabId, data: res.json || { error: 'info failed' } };
        }
        if (a.op === 'eval') {
          if (!a.code) return { error: 'op=eval 需要 code' };
          const res = await call('/eval' + q, { method: 'POST', body: String(a.code) });
          if (res.json) return { tabId, data: res.json };
          return { error: 'eval 失败：' + (res.error || res.text || 'unknown') };
        }
        if (a.op === 'click') {
          if (!a.selector) return { error: 'op=click 需要 selector' };
          const res = await call('/click' + q, { method: 'POST', body: String(a.selector) });
          if (res.json) return { tabId, data: res.json };
          return { error: 'click 失败：' + (res.error || res.text || 'unknown') };
        }
        if (a.op === 'scroll') {
          const y = a.y === undefined ? 1200 : Number(a.y);
          const dir = a.direction || (y < 0 ? 'up' : 'down');
          const res = await call('/scroll' + q + '&y=' + Math.abs(y) + '&direction=' + encodeURIComponent(dir));
          if (res.json) return { tabId, data: res.json };
          return { error: 'scroll 失败：' + (res.error || res.text || 'unknown') };
        }
        return { error: '未知 op：' + String(a.op) };
      },
    }),
  );

  const EXTRACT = {
    text: 'document.body ? document.body.innerText : document.documentElement.innerText',
    links:
      '(() => { const out = []; document.querySelectorAll("a[href]").forEach(a => out.push({ text: (a.innerText || "").trim().slice(0, 120), href: a.href })); return out.slice(0, 300); })()',
    html: 'document.documentElement.outerHTML',
  };

  ctx.tools.register(
    defineTool({
      name: 'web_content',
      description:
        'Extract content from the current page of one tab. mode=text returns visible text; mode=links returns every anchor with its absolute href; ' +
        'mode=html returns the full HTML source; mode=json runs the JavaScript given in execCode and returns the value (use it for structured scraping). ' +
        '中文：从某个标签的当前页抽内容——text 可见正文，links 全部链接，html 源码，json 用 execCode 跑 JS 取结构化数据。',
      parameters: {
        tabId: { type: 'string', description: 'Tab id from web_open; omit to use the most recently opened tab.' },
        mode: { type: 'string', enum: ['text', 'links', 'html', 'json'], required: true, description: 'Extraction mode.' },
        execCode: { type: 'string', description: 'JavaScript expression for mode=json.' },
        maxChars: { type: 'number', description: 'Truncate returned text to this many characters (default 20000).' },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => {
          const inner = value && value.data && value.data.value;
          if (typeof inner === 'string') return [{ type: 'text', text: inner }];
          return [{ type: 'text', text: JSON.stringify(value) }];
        },
      },
      async execute(args) {
        const a = args || {};
        const tabId = String(a.tabId || lastTabId || '');
        if (!tabId) return { error: '还没有标签：先调 web_open，或显式传 tabId' };
        const gate = await ensureProxy();
        if (!gate.ok) return { error: gate.error };
        let expr;
        if (a.mode === 'json') {
          if (!a.execCode) return { error: 'mode=json 需要 execCode' };
          expr = String(a.execCode);
        } else {
          expr = EXTRACT[a.mode];
          if (!expr) return { error: '未知 mode：' + String(a.mode) };
        }
        const res = await call('/eval?target=' + encodeURIComponent(tabId), { method: 'POST', body: expr });
        if (!res.json) return { error: '抽取失败：' + (res.error || res.text || 'unknown') };
        let value = res.json.value;
        if (typeof value === 'string') {
          const cap = a.maxChars === undefined ? 20000 : Number(a.maxChars);
          if (value.length > cap) value = value.slice(0, cap) + '\n...[truncated ' + (value.length - cap) + ' chars]';
        }
        return { tabId, data: { mode: a.mode, value } };
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'web_shot',
      description:
        'Capture a screenshot of the current page of one tab and save it as a PNG/JPEG file, returning the path so the image can be read back. ' +
        'Also useful for capturing the current frame of a video. ' +
        '中文：给某个标签的当前页截图存成文件并返回路径（可再读图）；也适合抓视频当前帧。',
      parameters: {
        tabId: { type: 'string', description: 'Tab id from web_open; omit to use the most recently opened tab.' },
        path: { type: 'string', description: 'Optional output name; the write target is restricted to the proxy shots/ directory (absolute paths outside it are rejected). 仅可落在代理 shots/ 内，任意路径已移除。' },
        format: { type: 'string', enum: ['png', 'jpeg'], description: 'Image format, default png.' },
      },
      output: { schema: { type: 'json' }, render: textOut },
      async execute(args) {
        const a = args || {};
        const tabId = String(a.tabId || lastTabId || '');
        if (!tabId) return { error: '还没有标签：先调 web_open，或显式传 tabId' };
        const gate = await ensureProxy();
        if (!gate.ok) return { error: gate.error };
        let file = a.path ? String(a.path) : '';
        // 截图不再由代理写到调用方指定的路径：未鉴权（或被诱导的工具调用）时那是本用户
        // 权限下的任意文件覆盖/删除面。代理只认 save=1 → shots/ 下服务端生成文件名；
        // 用户要自定义名字时由宿主在 shots/ 内复制。旧版这里的 unlinkSync（对任意路径先删）一并移除。
        const q =
          '/screenshot?target=' +
          encodeURIComponent(tabId) +
          '&save=1' +
          (a.format ? '&format=' + encodeURIComponent(String(a.format)) : '');
        const res = await call(q, { timeout: 45000 });
        const j = res.json || {};
        if (!j.path) return { error: '截图未落盘：' + (res.error || j.error || res.text || 'unknown') };
        // 拷贝源也要界内：j.path 来自代理响应，端口被抢注的假代理能让宿主把任意可读文件复制进 shots
        const sroot = path.resolve(SHOTS);
        const src = path.resolve(String(j.path));
        if (src !== sroot && !src.startsWith(sroot + path.sep)) {
          return { error: '代理返回的落盘路径不在 shots 目录内，拒绝使用：' + j.path };
        }
        let outPath = src;
        if (file) {
          const cand = path.isAbsolute(file) ? path.resolve(file) : path.join(sroot, path.basename(file));
          if (/\.\./.test(file) || !(cand === sroot || cand.startsWith(sroot + path.sep))) {
            return { error: 'path 只能落在代理 shots 目录内（' + sroot.replace(/\\/g, '/') + '）；出于安全已不再接受任意路径，返回结果里的 path 可直接读图' };
          }
          try {
            fs.copyFileSync(j.path, cand);
            outPath = cand;
          } catch (e) {
            return { error: '复制失败: ' + e.message };
          }
        }
        let bytes = null;
        try {
          bytes = fs.statSync(outPath).size;
        } catch {
          /* 没落盘 */
        }
        if (bytes === null) return { error: '截图未落盘：' + (res.error || j.error || res.text || 'unknown') };
        return { tabId, data: { path: outPath.replace(/\\/g, '/'), bytes } };
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'web_tabs',
      description:
        'Manage browser tabs and site notes. op=list lists every open tab; op=close closes one tab; op=close_all_mine closes only the tabs this plugin opened; ' +
        'op=note appends a dated note for a domain; op=sites lists domains that already have notes; ' +
        'op=find_url searches the local Chrome/Edge bookmarks and history (for internal systems or pages the user saw before). ' +
        '中文：管标签与站点笔记——list 列全部标签，close 关一个，close_all_mine 只关插件自己开的，note 按日期追加该域名笔记，sites 列出已有笔记的域名，find_url 查本地书签/历史。',
      parameters: {
        op: {
          type: 'string',
          enum: ['list', 'close', 'close_all_mine', 'note', 'sites', 'find_url'],
          required: true,
          description: 'Which management operation to run.',
        },
        tabId: { type: 'string', description: 'Tab id for op=close.' },
        domain: { type: 'string', description: 'Domain for op=note, e.g. xiaohongshu.com.' },
        content: { type: 'string', description: 'Note text for op=note.' },
        query: { type: 'string', description: 'Space-separated keywords for op=find_url.' },
      },
      output: { schema: { type: 'json' }, render: textOut },
      async execute(args) {
        const a = args || {};
        const gate = await ensureProxy();
        if (!gate.ok) return { error: gate.error };

        if (a.op === 'list') {
          const res = await call('/targets');
          const raw = Array.isArray(res.json) ? res.json : [];
          // 通道切换（CDP 十六进制 targetId ↔ 扩展数字标签 ID）会让集合里留下一堆对不上号的
          // 旧 ID：列表里 mine 全是 false、mineCount 却虚高，close_all_mine 还会挨个报错。
          // 所以每次列表顺手把已经不存在的 ID 剔掉。
          const seen = new Set(raw.map((p) => p.targetId));
          for (const id of [...mineTabs]) if (!seen.has(id)) mineTabs.delete(id);
          return {
            data: {
              tabs: raw.map((p) => ({
                tabId: p.targetId,
                title: String(p.title || '').slice(0, 100),
                url: String(p.url || '').slice(0, 200),
                mine: mineTabs.has(p.targetId),
              })),
              mineCount: mineTabs.size,
            },
          };
        }

        if (a.op === 'close') {
          if (!a.tabId) return { error: 'op=close 需要 tabId' };
          const res = await call('/close?target=' + encodeURIComponent(a.tabId));
          // 关不掉就别装作关掉了：报错原样返回，ID 留在集合里，状态才和现实一致。
          // 非 JSON 响应体（旧代理把 CDP error 吐成 "null"）与 success:false 同样算失败。
          if (!res.ok || !res.json || res.json.error || res.json.success === false) {
            return { error: (res.json && res.json.error) || res.error || ('关闭失败 HTTP ' + res.status), tabId: a.tabId };
          }
          mineTabs.delete(a.tabId);
          if (lastTabId === a.tabId) lastTabId = null;
          return { data: { closed: a.tabId, result: res.json || null } };
        }

        if (a.op === 'close_all_mine') {
          const ids = [...mineTabs];
          const results = [];
          for (const id of ids) {
            const res = await call('/close?target=' + encodeURIComponent(id));
            const okClose = res.ok && !!res.json && !res.json.error && res.json.success !== false;
            results.push({ tabId: id, ok: okClose, error: okClose ? undefined : ((res.json && res.json.error) || 'HTTP ' + res.status) });
            // 只把真关掉的从集合里摘走，失败的留着，下次还能重试
            if (okClose) mineTabs.delete(id);
          }
          const closedCount = results.filter((r) => r.ok).length;
          if (lastTabId && !mineTabs.has(lastTabId)) lastTabId = null;
          return { data: { closedCount, leftCount: mineTabs.size, results } };
        }

        if (a.op === 'note') {
          const written = writeNote(a.domain, a.content);
          if (!written.ok) return { error: '写笔记失败：' + written.error };
          return { data: { path: written.file, domain: written.host } };
        }

        if (a.op === 'sites') {
          let domains = [];
          try {
            domains = fs
              .readdirSync(SITES)
              .filter((f) => f.endsWith('.md'))
              .map((f) => f.replace(/\.md$/, ''));
          } catch {
            /* 目录还没建 */
          }
          return { data: { domains } };
        }

        if (a.op === 'find_url') {
          const keywords = String(a.query || '').trim().split(/\s+/).filter(Boolean);
          if (!keywords.length) return { error: 'op=find_url 需要 query' };
          try {
            const { stdout } = await execFileAsync(process.execPath, [FIND_URL_SCRIPT, ...keywords], {
              cwd: ROOT,
              timeout: 30000,
              maxBuffer: 8 * 1024 * 1024,
              windowsHide: true,
            });
            return { data: { query: keywords.join(' '), raw: String(stdout || '').slice(0, 12000) } };
          } catch (error) {
            const detail = (error && (error.stdout || error.message)) || String(error);
            return { error: 'find_url 失败：' + String(detail).slice(0, 400) };
          }
        }

        return { error: '未知 op：' + String(a.op) };
      },
    }),
  );

  // 启动可见性：确认 apply 真的被调用过（排查加载问题时看这行）
  console.log('[dsh-web-access] apply 完成：5 个工具已注册');

  // 预热：启动后 2 秒拉一次代理，失败只记日志（首次调用会自己重试）。
  setTimeout(() => {
    ensureProxy().catch((error) => warn('[dsh-web-access] warmup: ' + ((error && error.message) || String(error))));
  }, 2000);

  ctx.on('dispose', () => {
    // 刻意不动代理进程：授权绑在它身上，常驻才是对的。
    // 要停：taskkill /PID $(Get-Content proxy.pid) /F
  });
}
