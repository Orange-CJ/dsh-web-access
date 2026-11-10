# Credits

## 上游

CDP 代理脚本复用 [eze-is/web-access](https://github.com/eze-is/web-access)（作者 一泽Eze），MIT 许可。上游仓库根目录没有 LICENSE 文件，许可按 `SKILL.md` frontmatter 与 README 标注的 MIT 认定。

属于上游、不在本仓内的文件：

- `scripts/cdp-proxy.mjs`
- `scripts/browser-discovery.mjs`
- `scripts/check-deps.mjs`
- `scripts/find-url.mjs`
- `references/cdp-api.md`
- `templates/config.env.template`

## 本仓

以下文件为本仓库独立编写：

- `index.js` — DSH 宿主插件本体，注册 5 个工具、站点笔记、截图落盘
- `cordis.patch.yml` — 插件挂载描述
- `package.json`
- `extension/manifest.json` — MV3 扩展清单，写死 `key` 使扩展 ID 恒定
- `extension/sw.js` — service worker：反向 WS 客户端、断线退避重连、三层保活、`chrome.debugger` 命令分发、托管标签 allowlist
- `extension/INSTALL.md`

`extension/` 是为绕开 Chrome 153 的 CDP Origin 门而写的独立通道，不依赖上游任何代码。上游只有 CDP 后备通道在用。
