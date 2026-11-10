# 上游代码与许可

本仓 `scripts/` 和 `references/` 部分来自 [eze-is/web-access](https://github.com/eze-is/web-access)（作者：一泽Eze），MIT 许可。

上游仓库根目录没有 LICENSE 文件，许可按仓库 `SKILL.md` frontmatter 与 `README.md` 的标注认定为 MIT。

## 各文件状态

本仓不是上游的纯搬运，其中两个文件做了大幅修改，正是本插件的核心增量：

| 文件 | 上游 | 本仓 | 说明 |
|---|---|---|---|
| `scripts/cdp-proxy.mjs` | 682 行 / 26,127 B | 1137 行 / 52,961 B | **已修改**：新增 500 行，删改 45 行 |
| `scripts/browser-discovery.mjs` | 138 行 / 6,199 B | 292 行 / 14,925 B | **已修改**：新增 178 行，删改 24 行 |
| `scripts/check-deps.mjs` | 8,384 B | 8,384 B | 原样 |
| `scripts/find-url.mjs` | 11,412 B | 11,412 B | 原样 |
| `scripts/test-agent-bridge.mjs` | 14 项断言 | 26 项断言 | **已修改**：本轮新增 12 项 |
| `references/cdp-api.md` | 4,925 B | 4,925 B | 原样 |

修改部分做了什么，见各文件头部注释与 [README](README.md#前置两件事)。

## MIT License

Copyright (c) 一泽Eze

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
