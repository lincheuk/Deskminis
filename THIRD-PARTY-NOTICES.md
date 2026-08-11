# 第三方声明 · Third-Party Notices

本项目以 **Apache License 2.0** 分发（见 [LICENSE](LICENSE)）。下列材料来自第三方，其许可条款依然适用。

---

## 1. Appica UI — 视觉令牌取值（MIT）

**用了什么**：`deskminis/src/renderer/src/styles/tokens.css` 的「A 区」是 Appica UI
`styles.css` 中调色板与半径取值的**逐字照抄**（MU3「Appica 视觉语言移植」）。
参考副本留档于 `docs/specs/2026-08-09-appica-tokens-reference.css`。

- 来源：<https://unpkg.com/@appica/ui-react@1.0.0/styles.css>
- 项目：<https://github.com/appica-dev/appica-ui>
- 版本：`@appica/ui-react@1.0.0`

```
MIT License

Copyright (c) 2026 Appica UI

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
```

---

## 2. OpenMinis — 架构参考，**未复用任何代码**（GPLv3）

**用了什么：只有想法，没有代码。**

DeskMinis 的产品理念与若干架构决策（Agent 循环、SKILL.md 技能生态、
传输无关的同步分层、会话/记忆的数据形态）来自对 OpenMinis 的研读，
研读结论落在 `docs/research/` 的九份报告里。

**没有复用其源码**，也不可能复用：OpenMinis 是 iOS Swift/SwiftUI + Android Kotlin/Compose，
DeskMinis 是 Electron + TypeScript，两者无一行共享代码。
本仓库 `.gitignore` 排除了 `OpenMinis/`（只读参考克隆），
该目录**从未进入版本控制，也不随本项目分发**。

- 项目：<https://github.com/openminis/openminis>
- 许可：GPL-3.0（仅约束其自身代码的衍生作品；著作权保护表达而非思想）

> 若将来确有从 OpenMinis 复制代码的需要，本项目须相应改为 GPLv3——
> 这条约束记录在 `PROJECT_NOTES.md`，改动前须重新评估。

---

## 3. 运行时依赖

生产依赖及其许可可随时生成：

```bash
cd deskminis && npx license-checker --production --summary
```

主要依赖：Electron（MIT）、better-sqlite3（MIT）、Vue（MIT）、
electron-updater（MIT）、@napi-rs/keyring（MIT）、ws（MIT）、xterm（MIT）。
各自许可文本随 npm 包分发，并由 electron-builder 打进安装包
（`LICENSE.electron.txt` / `LICENSES.chromium.html`）。
