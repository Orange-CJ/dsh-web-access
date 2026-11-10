# dsh-web-access

让 DSH 直接操作你自己的浏览器 —— 开页、读页、点按钮、滚动、截图、取内容，登录态天然带着。

## 为什么需要它

DSH 自带的 web 工具抓不到需要登录的页面，也没有多标签管理和站点记忆。这个插件通过 Chrome DevTools Protocol（CDP）直连本机的浏览器，把「你已经登录的那个浏览器」变成 Agent 的手和眼。

## 五个工具

| 工具 | 作用 | 关键参数 |
|---|---|---|
| `web_open` | 后台开新标签并等加载完成，返回 tabId；顺带带回该域名的站点笔记 | `url` |
| `web_page` | 读/驱动当前页 | `op`（info / eval / click / scroll） |
| `web_content` | 抽内容 | `mode`（text / links / html / json） |
| `web_shot` | 截图存文件，返回路径供读图 | `tabId`、`path`、`format` |
| `web_tabs` | 标签与站点笔记 | `op`（list / close / close_all_mine / note / sites / find_url） |

行为约定：

- 不传 `tabId` 时，使用最近一次 `web_open` 打开的标签。
- 只关自己开的标签（`close_all_mine`），用户原有的标签不会被碰。
- 按域名记站点笔记，下次打开同站自动带回。

## 安装

```bash
dsh plugin --profile <profile> add <本仓绝对路径>
```

装完重启 DSH 才会加载。

## 前置：两件事

### 1. bridge 扩展（必需）

Chrome 153 起，CDP 调试端口对客户端加了 Origin 门：端口在听，但普通 `GET /json/version` 回 404 且无正文，带 Origin 的 WebSocket 升级一律 403（`Rejected an incoming WebSocket connection from the … origin`）。默认白名单为空，只有给浏览器加 `--remote-allow-origins` 才放行 —— 给日常使用的 profile 开这个口子是安全退步。

所以插件走 **扩展 + `chrome.debugger`**：扩展在浏览器内部调特权 API，不经过那道门，再反向连到本机代理。

装（一次性）：

1. 地址栏打开 `chrome://extensions`
2. 右上角开「开发者模式」
3. 「加载已解压的扩展程序」→ 选本仓 `extension/` 目录
4. 验证端到端：让插件跑一次 `web_tabs list`

扩展 ID 由 `manifest.json` 里写死的 `key` 推出，恒为 `iaappcdoajokfdnpghgkmngcboceoegd`。代理只接受这一个 origin 的挂接，没配就拒绝一切连接（fail-closed）。**别改 `key`** —— 改了 ID 就变，两边要一起改。

扩展只操作自己 `tab.create` 出来的标签，你已登录的既有标签不在 `/targets` 里，被点名一律 `UNMANAGED_TAB` → 403。详见 [extension/INSTALL.md](extension/INSTALL.md)。

### 2. CDP 代理（随仓提供）

插件本体只负责注册工具，真正和浏览器通信的是 `scripts/cdp-proxy.mjs`（监听 `127.0.0.1:3456`）。

这部分 fork 自 [eze-is/web-access](https://github.com/eze-is/web-access)（MIT），并做了大幅修改 —— 扩展桥、origin 钉死、token 鉴权、托管标签分流都在这一层：

| 文件 | 上游 | 本仓 |
|---|---|---|
| `scripts/cdp-proxy.mjs` | 682 行 | 1137 行 |
| `scripts/browser-discovery.mjs` | 138 行 | 292 行 |

`check-deps.mjs`、`find-url.mjs`、`references/cdp-api.md` 保持上游原样。逐文件对照与 MIT 全文见 [UPSTREAM-NOTICE.md](UPSTREAM-NOTICE.md)。

## 配置

插件配置项 `root` 指向本仓根目录 —— 脚本、站点笔记、截图都在它下面。

首跑先复制一份配置：

```bash
cp config.env.example config.env
```

`config.env` 关键四项：

```ini
WEB_ACCESS_PORT=9229
WEB_ACCESS_EXTENSION_ID=iaappcdoajokfdnpghgkmngcboceoegd
WEB_ACCESS_TOKEN_ENFORCE=1
WEB_ACCESS_BROWSER=chrome
```

控制面 token 不写进 `config.env`（它会被 git 跟踪），放 `proxy.token`，`.gitignore` 已排除。

装了扩展就不需要开调试端口。只有要走 CDP 后备通道（hex target id）才需要浏览器侧放行，二选一：

1. 打开 `chrome://inspect/#remote-debugging`，勾选 "Allow remote debugging for this browser instance"；
2. 或者用独立 profile 起调试实例：
   ```bash
   chrome --user-data-dir=<独立目录> --remote-debugging-port=9229 --remote-allow-origins=*
   ```
   并在 `config.env` 里写 `WEB_ACCESS_PORT`。Chrome 会拒绝未列入 `--remote-allow-origins` 的调试来源，只勾开关不够。

## Desktop 适配

同一份 `index.js` 同时跑 web profile 和 DSH Desktop（Electron Node 模式）。Desktop 下的两处差别已经在代码里处理：

- 起 CDP 代理子进程时注入 `ELECTRON_RUN_AS_NODE=1`。Desktop 把 Host 跑在 Electron 的 Node 模式里，`process.execPath` 指向 Electron，直接 spawn 会再开一个图形窗口。
- 杀旧代理之前，先用 `Get-CimInstance Win32_Process` 核对目标 pid 的命令行里是否真的包含 `cdp-proxy.mjs`。pid 会被系统复用，不核对就可能误杀无关进程。

普通 Node 环境下这两段分支都不改变行为。

## 已知限制

- `root` 指向本仓根目录。`.gitignore` 已排除 `config.env`、`proxy.token`、`sites/`、`shots/`、`node_modules/` —— 这些是运行产物或本机配置，不要提交。
- 代理进程刻意常驻：浏览器授予的远程调试授权绑在它身上，掐掉下次要重新授权。停止需手动 `taskkill`，pid 写在 `proxy.pid`。
- CDP 代理默认对本机进程开放，生产环境应启用 `WEB_ACCESS_TOKEN_ENFORCE=1`。

## License

MIT
