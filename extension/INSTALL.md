# dsh-web-access bridge 扩展（v0.2.0）

让本机代理通过扩展的 `chrome.debugger` 驱动你的浏览器，**不需要调试端口、不需要 `--remote-allow-origins`**。

存在的理由：Chrome 153 起对 CDP 调试端口加了 Origin 门（默认白名单为空，任意 Origin 一律 403），客户端侧绕不过去；`chrome.debugger` 是浏览器内部特权 API，不走那道门。

## 装（一次性）

1. 地址栏打开 `chrome://extensions`
2. 右上角开「开发者模式」
3. 「加载已解压的扩展程序」→ 选本目录
4. 想确认连上了：浏览器直接开 `http://127.0.0.1:3456/health` **只会看到** `{status, tokenEnforced:true}`
   —— 这是 token 强制开启后的正常最小响应面。完整诊断（`agentConnected`/`transport`）要带
   `x-web-access-token` 头读 `proxy.token`，或者直接让插件跑一次 `web_tabs list` 验证端到端。

改过代码后，在第 1 步那个页面点扩展卡片上的刷新图标即可。被 attach 的标签页顶部会出现「正在调试此浏览器」横幅，去不掉；点掉横幅会 detach。

## 这个 ID 是钉死的

`manifest.json` 里写了固定 `key`，所以扩展 ID 恒为 `iaappcdoajokfdnpghgkmngcboceoegd` —— 代理只接受
`chrome-extension://iaappcdoajokfdnpghgkmngcboceoegd` 这一个 origin 的挂接（值在代理侧 `config.env` 的
`WEB_ACCESS_EXTENSION_ID`）。**别改 `key`**：改了 ID 就变，代理会拒绝挂接，两边要一起改。没配 ID 时一律拒绝（fail-closed）。

## 能力边界（当前）

走扩展通道的是 `web_*` 全家：`/health`、`/targets`、`/eval`、`/info`、`/new`、`/navigate`、
`/screenshot`、`/click`、`/scroll`、`/close`、`/back`。

**只覆盖托管标签**：扩展只操作自己 `tab.create` 出来的标签（名单持久化在 `chrome.storage.session`）。
你的既有标签不进 `/targets` 列表，被任何端点点名都会得到 `UNMANAGED_TAB` → HTTP 403。
hex target id 始终走 CDP 后备通道，不误入扩展分支。

截图默认只截视口，与 CDP 通道一致；要整页显式带 `full=1`（后台标签也能截到整页）。
`save=1` 时文件只落代理 `shots/` 目录、服务端随机名；`file=` 参数已移除，带即 400。
两套 target id 并存、按形状自动分流：数字 = `chrome.tabs` 标签 ID（扩展通道），
十六进制 = CDP targetId（CDP 通道），调用方不需要区分。

## 文件

- `manifest.json` —— MV3，权限 `debugger` / `tabs` / `alarms` / `storage`，含固定 `key`
- `sw.js` —— service worker：WS 客户端 + 断线退避重连 + 三层保活（MV3 SW 空闲约 30s 会被杀）
