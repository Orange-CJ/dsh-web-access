# Credits

## 上游

`scripts/` 与 `references/` 部分来自 [eze-is/web-access](https://github.com/eze-is/web-access)（作者 一泽Eze），MIT 许可。上游仓库根目录没有 LICENSE 文件，许可按 `SKILL.md` frontmatter 与 README 标注的 MIT 认定。

本仓不是纯搬运，两个核心文件做了大幅修改。逐文件的行数与字节对照、以及 MIT 全文见 [UPSTREAM-NOTICE.md](UPSTREAM-NOTICE.md)。

## 本仓

以下为本仓库独立编写：

- `index.js` — DSH 宿主插件本体，注册 5 个工具、站点笔记、截图落盘
- `extension/manifest.json` — MV3 扩展清单，写死 `key` 使扩展 ID 恒定
- `extension/sw.js` — service worker：反向 WS 客户端、断线退避重连、三层保活、`chrome.debugger` 命令分发、托管标签 allowlist
- `extension/INSTALL.md`
- `cordis.patch.yml` — 插件挂载描述
- `package.json`
- `config.env.example`
- `UPSTREAM-NOTICE.md`

`extension/` 是为绕开 Chrome 153 的 CDP Origin 门而写的独立通道，不依赖上游任何代码。

`scripts/cdp-proxy.mjs` 与 `scripts/browser-discovery.mjs` 中「扩展桥 + 鉴权 + 分流」相关的增量（合计约 678 行）同样属于本仓改动，具体见 UPSTREAM-NOTICE。
