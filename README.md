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

## 前置：CDP 代理

插件本体只负责注册工具。真正和浏览器通信的是 CDP 代理（`scripts/cdp-proxy.mjs`，监听 `127.0.0.1:3456`），这部分复用 [eze-is/web-access](https://github.com/eze-is/web-access)（MIT），**不在本仓内**，需要自行准备并放到 `root` 目录下：

- `scripts/cdp-proxy.mjs`
- `scripts/browser-discovery.mjs`
- `scripts/check-deps.mjs`
- `scripts/find-url.mjs`
- `templates/config.env.template`

归属与许可见 [CREDITS.md](CREDITS.md)。

## 配置

插件配置项 `root`：CDP 脚本、站点笔记与截图的根目录，默认 `C:\dsh\web-access`。

浏览器侧二选一：

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

- 默认根目录是 Windows 路径，其他平台需要显式配置 `root`。
- 代理进程刻意常驻：浏览器授予的远程调试授权绑在它身上，掐掉下次要重新授权。停止需手动 `taskkill`，pid 写在 `proxy.pid`。
- CDP 代理默认对本机进程开放，生产环境应启用 `WEB_ACCESS_TOKEN_ENFORCE=1`。

## License

MIT
