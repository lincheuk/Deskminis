# 第三方声明 · Third-Party Notices

本项目以 **Apache License 2.0** 分发（见 [LICENSE](LICENSE)）。下列材料来自第三方，其许可条款依然适用。

安装包里，本文件与本项目许可一起放在安装目录的 `resources\` 下：
`THIRD-PARTY-NOTICES.md`（本文件）与 `LICENSE.txt`（本项目许可，即仓库根的 LICENSE）。

第 3 节起的「代码改编」表按文末「附：登记格式」登记，由 `deskminis/tests/license-consistency.test.ts` 与源码双向核对。

---

## 1. Appica UI — 令牌槽位结构（MIT）

**用了什么**：`deskminis/src/renderer/src/styles/tokens.css` A 区（raw 值层）的**槽位结构**——
令牌的命名与分层（`--foreground` / `--foreground-subtle` / `--background-muted` 这一族）
承自 Appica UI 的 `styles.css`（MU3「Appica 视觉语言移植」）。之后 E1（Aurora）与 I 波（AionUi 换向）
换的都是取值，槽位结构沿用至今。A 区现在的**取值**已不来自 Appica，见第 2 节。
MU3 当时的参考副本留档于 `docs/specs/2026-08-09-appica-tokens-reference.css`。

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

## 2. AionUi — 令牌取值（Apache-2.0）

**用了什么**：`deskminis/src/renderer/src/styles/tokens.css` A 区的**取值**（I 波 UI 换向，2026-08-20）。
取值据 AionUi v2.1.59 `default-color-scheme.css` 的 Arco / AOU 色系移植换算（hex → oklch），
文本档为过 WCAG AA 压深的自研调整。与 A 区逐行一致的是本仓参考文件
`docs/specs/2026-08-20-aionui-tokens-reference.css`（其文件头记有换算来历）。没有复制 AionUi 的源码。

- 项目：<https://github.com/iOfficeAI/AionUi>
- 版本：v2.1.59
- 许可：Apache-2.0，Copyright 2025 AionUi (aionui.com)；许可全文与本仓 [LICENSE](LICENSE) 相同。
  AionUi 仓库没有 NOTICE 文件，无署名条目可转载。

---

## 3. pi-mono — 代码改编（MIT）

| 本仓位置 | 上游位置 @ 提交 | 借了什么 | 怎么改的 |
|---|---|---|---|
| `deskminis/src/minisd/tools/edit-text.ts` | `packages/coding-agent/src/core/tools/edit-diff.ts:11-25,306-314`、`core/tools/edit.ts:190-197`、`utils/text.ts:2-4` @ 8676a0d | file_edit 的文本处理骨架：剥掉 BOM 后在正文上匹配、写回时补回 BOM；按首个换行判定文件行尾；old/new 先把 `\r\n` 归一为 `\n` 再匹配；拒绝空 old_string | 不再整文件归一为 LF 再整体还原，改为在归一视图里匹配、把命中区间映射回原文偏移只替换这一段，混合行尾文件的其它行不动；只折叠 `\r\n`、不动孤立的 `\r`；去掉模糊匹配与多处批量编辑；另加 UTF-8 往返校验、重叠出现计入唯一性、old_string 开头 U+FEFF 的处理 |

- 项目：<https://github.com/badlogic/pi-mono>
- 许可：MIT

```
MIT License

Copyright (c) 2025 Mario Zechner

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

## 4. ZCode — 代码改编（Apache-2.0）

| 本仓位置 | 上游位置 @ 提交 | 借了什么 | 怎么改的 |
|---|---|---|---|

- 项目：<https://github.com/zai-org/ZCode>
- 许可：Apache-2.0，Copyright 2026 Z.AI Co., Ltd；许可全文与本仓 [LICENSE](LICENSE) 相同。
- ZCode 的 `NOTICE.md` 是产品功能与数据流声明，没有与所借部分相关的署名条目，**未转载**
  （Apache-2.0 §4(d) 只要求转载与衍生作品相关的署名）。

---

## 5. 仅借思路、未复制代码

下列项目只借鉴了设计思路或行为语义，**没有复制代码**。若将来实际复制了代码，
挪进上面对应上游的改编表，并按「附：登记格式」写文件头。

### OpenMinis（GPLv3）— 架构参考

DeskMinis 的产品理念与若干架构决策（Agent 循环、SKILL.md 技能生态、
传输无关的同步分层、会话/记忆的数据形态）来自对 OpenMinis 的研读。
研读结论在 `docs/research/` 的 `readers-0…4.md` 与 `followups-0…2.md`（共 8 份）；
同目录另有 OpenCode 研读 5 份与插件市场调研 1 份，与 OpenMinis 无关。

**没有复用其源码**，也不可能复用：OpenMinis 是 iOS Swift/SwiftUI + Android Kotlin/Compose，
DeskMinis 是 Electron + TypeScript，两者无一行共享代码。
本仓库 `.gitignore` 排除了 `OpenMinis/`（只读参考克隆），
该目录**从未进入版本控制，也不随本项目分发**。

- 项目：<https://github.com/openminis/openminis>
- 许可：GPL-3.0（仅约束其自身代码的衍生作品；著作权保护表达而非思想）

> 若将来确有从 OpenMinis 复制代码的需要，本项目须相应改为 GPLv3——
> 这条约束记录在 `PROJECT_NOTES.md`，改动前须重新评估。

### AionUi（Apache-2.0）— 单实例锁与开发态数据隔离

止血波的单实例锁（W1b-3）与「未打包时数据根另用 `DeskMinis-dev`」（W1a-9）按 AionUi 桌面端的思路设计。
项目与许可见第 2 节。

### deepseek-harness（MIT）— 窗口导航守卫与停止会话的语义

止血波的窗口导航与新窗口守卫（W2b-6）、「删除前先停止会话里仍在跑的工作」（W1b-4）参考了
deepseek-harness 桌面端的做法。

- 项目：<https://github.com/deepseek-ai/deepseek-harness>
- 许可：MIT，Copyright (c) 2026 DeepSeek

---

## 6. 运行时依赖

安装包里的第三方代码在三处：

- `dependencies` 及其间接依赖连同各自的许可文件，打进 `resources\app.asar` 的 `node_modules\`
  （原生模块解包在 `app.asar.unpacked\`）；包内没有许可文件的两类见本节末。
- 渲染端由 vite 打成单文件，打包时不保留许可注释。其中 Vue 与 Pinia 属于 devDependencies，
  不在 asar 里，版权行录于下表，许可全文与第 1 节所录的 MIT 全文相同。
- Electron 运行时：Electron 与 Chromium 的许可在安装目录根的 `LICENSE.electron.txt`、`LICENSES.chromium.html`。

下表是直接依赖、打进渲染包的包与 Electron 本身，均为 MIT：

| 包 | 许可 | 随包形态 |
|---|---|---|
| `electron` | MIT | 应用运行时 |
| `better-sqlite3` | MIT | app.asar（原生模块解包） |
| `@napi-rs/keyring` | MIT | app.asar（原生模块解包） |
| `electron-updater` | MIT | app.asar |
| `ws` | MIT | app.asar |
| `undici` | MIT | app.asar |
| `yauzl` | MIT | app.asar |
| `@noble/ciphers`、`@noble/curves`、`@noble/hashes` | MIT | app.asar |
| `@xterm/xterm`、`@xterm/addon-fit` | MIT | app.asar，并打进渲染包 |
| `vue` | MIT | 打进渲染包；Copyright (c) 2018-present, Yuxi (Evan) You |
| `pinia` | MIT | 打进渲染包；Copyright (c) 2019-present Eduardo San Martin Morote |

间接依赖大多也是 MIT；许可不同的是下表 14 个包（`semver` 随包两份），许可全文都在 app.asar 里各包的目录下。
`rc` 与 `expand-template` 是含 MIT 的多选一许可，本项目选 MIT。

| 包 | 许可 | 经由（最短一条） |
|---|---|---|
| `detect-libc` | Apache-2.0 | better-sqlite3 → prebuild-install |
| `tunnel-agent` | Apache-2.0 | better-sqlite3 → prebuild-install |
| `ieee754` | BSD-3-Clause | better-sqlite3 → prebuild-install → tar-fs → tar-stream → bl → buffer |
| `argparse` | Python-2.0 | electron-updater → js-yaml |
| `sax` | BlueOak-1.0.0 | electron-updater → builder-util-runtime |
| `chownr` | ISC | better-sqlite3 → prebuild-install → tar-fs |
| `graceful-fs` | ISC | electron-updater → fs-extra |
| `inherits` | ISC | better-sqlite3 → prebuild-install → tar-fs → tar-stream |
| `ini` | ISC | better-sqlite3 → prebuild-install → rc |
| `once` | ISC | better-sqlite3 → prebuild-install → pump |
| `semver` | ISC | better-sqlite3 → prebuild-install → node-abi；electron-updater 另带一份 |
| `wrappy` | ISC | better-sqlite3 → prebuild-install → pump → once |
| `rc` | (BSD-2-Clause OR MIT OR Apache-2.0) | better-sqlite3 → prebuild-install |
| `expand-template` | (MIT OR WTFPL) | better-sqlite3 → prebuild-install |

包内没有许可文件的随包包有两类，都是 MIT，许可全文与第 1 节所录的 MIT 全文相同：

- `lazy-val`（electron-updater 带入）：包里没有版权行，package.json 记的作者是 Vladimir Krivosheev。
- `@napi-rs/keyring` 的平台二进制包（Windows 安装包里是 `@napi-rs/keyring-win32-x64-msvc`，只有 `.node`、
  README 与 package.json）：与主包同一项目、同一许可，版权行见主包的 LICENSE：Copyright (c) 2020 N-API for Rust。

以上由 `deskminis/tests/license-consistency.test.ts` 与 `package-lock.json` 逐包对账：
许可不是 MIT 的随包包都要进上表、表上的许可要与锁一致、包内没有许可文件的要在这里点名。

完整的生产依赖树及其许可可随时生成：

```bash
cd deskminis && npx license-checker --production --summary
```

---

## 7. 随包字体

### Noto Sans SC（思源黑体简体中文）

- 文件：`deskminis/src/renderer/src/assets/fonts/NotoSansSC-{Regular,Medium}.woff2`
- 著作权：Copyright 2014-2021 Adobe (http://www.adobe.com/)，经 Google Fonts 分发
- 项目：<https://fonts.google.com/noto/specimen/Noto+Sans+SC>
- 许可：**SIL Open Font License 1.1**（<https://scripts.sil.org/OFL>）

OFL 1.1 允许自由使用、修改与**随软件捆绑分发**，条件是：
① 保留版权与许可声明（即本节）；② 不单独售卖字体本身；
③ 若修改字体，改后的版本不得继续使用保留名称 "Noto"。
本项目原样打包、未做任何修改（仅由 TTF 转为 woff2 容器格式，字形数据未变）。

随包理由记录在 `deskminis/src/renderer/src/styles/theme.css` 的 @font-face 注释里：
Windows 自带中文仅微软雅黑一档，随包才能保证任何机器上界面一致。

---

## 附：登记格式（借用即登记）

凡复制或改编第三方源码，两处同时登记；`deskminis/tests/license-consistency.test.ts` 双向核对，
只登了一边就会变红。

1. **源文件头**写改编声明，放在文件开头（前 40 行内）。第一行照「改编自 <上游名>（<URL>）」的格式写，
   上游名与下面对应节标题里的名字一字不差，URL 与该节的项目链接相同；紧跟上游、许可、本文件已修改三行：

   ```
   /* 部分改编自 pi-mono（https://github.com/badlogic/pi-mono）
    *   上游：packages/ai/src/utils/overflow.ts @ 8676a0d
    *   许可：MIT，Copyright (c) 2025 Mario Zechner（全文见仓库根 THIRD-PARTY-NOTICES.md）
    *   本文件已修改：<一句话说改了什么> */
   ```

   Apache-2.0 的上游照同样格式写，许可行写「Apache-2.0，<版权行>」；
   「本文件已修改」一行就是 Apache-2.0 §4(b) 要求的显著修改声明。
   源码里「改编自」三个字只用于这种声明，别处换个说法——写成别的格式会被当成漏登记。

2. **对应上游节的表里追加一行**：本仓位置（反引号包住、相对仓库根，可带 `:行号`）|
   上游位置 @ 提交 | 借了什么 | 怎么改的。

已有的上游往既有表里追加行，不另开节。新的上游新开一节，标题写「## N. <项目> — 代码改编（<许可>）」，
下接同样表头的表，表后写项目链接与许可：MIT 照录全文（含版权行），Apache-2.0 写版权行并注明全文同本仓 LICENSE。
只借思路、没复制代码的，写进第 5 节，不进改编表。改编表为空，即本仓还没借过这个上游的代码。
