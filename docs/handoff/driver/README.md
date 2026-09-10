# xvfb 实拍 driver 索引

「全绿 ≠ 界面正常」在本项目已四次兑现，最近一次是发布级阻断（见下 `drive-v1.mjs`）。
UI 改动一律要有实拍，剧本存在这里防丢。

## 跑之前

```bash
cd /home/user/Deskminis/deskminis
npm run build                    # app 跑的是 out/ 产物，改了源不重建等于白测
xvfb-run -a node <path>/drive-xx.mjs
```

driver 裸 import `playwright-core`，本目录的 `package.json` 已声明它，
**但 `node_modules` 不入库**——第一次用先在本目录 `npm i`，
或跑的时候把 `NODE_PATH` 指向任何已装 playwright-core 的地方。

> ⚠️ **每个 driver 顶部的 `S` 常量指向的是当时会话的 scratchpad 绝对路径，
> 那个目录是会话级的、下次不存在。跑之前把 `S` 改成你自己的临时目录**——
> 它只用来放截图与 `DESKMINIS_DATA_DIR` 数据根，改一行即可。

FakeProvider 用法见交接文档 §3；工具 inputJSON **必带 `tool_title`**，
缺了会报「缺少必填参数」且权限卡不弹。

## Y 波 换壳遗失的入口成批补回（2026-09-10）

| 文件 | 用途 |
|---|---|
| **`drive-y1.mjs`** | 五场景各自冷启动：`menu` 会话行 ⋮ 菜单（记忆 / 绑定模型——先经 store 建一个 ollama 类 provider 免 key / 重命名含空标题被拒 / 删除二次确认）、`mcp` 种一台连不上的 MCP 验胶囊与面板、`sync` 设备页暂停恢复 + 标题栏点、`skills` 先 `importSkillFolder` 导入种子技能再到助手编辑器勾选、`rail` 三回合（长回复撑出滚动）验右缘三点与跳转。用法 `xvfb-run -a node drive-y1.mjs <menu\|mcp\|sync\|skills\|rail\|all>`。<br>**坑**：⋮ 平时 `opacity:0`，`element.click()` 不需要可见；`.f-btn` 文本匹配要 `trim()` 全等优先再退回 includes（「暂停同步」与「恢复同步」都含「同步」）。 |

## X 波 首发竞态排查（2026-09-10）

| 文件 | 用途 |
|---|---|
| **`drive-x1.mjs`** | 四个场景各自冷启动 + 全新数据根：`startup` 紧跟启动直发（真键盘，延迟 0/150/600ms，页内 2ms 探针记 Enter→running / →落库毫秒数）、`l6` **照抄 drive-l6 的 sendMsg 判定法**（含它那台连不上的 MCP 种子）看会不会误报、`double` 首条消息双击 Enter（真按键 + 同步派发两种）、`noprov` 不种 FakeProvider 的全新用户首发。用法 `xvfb-run -a node drive-x1.mjs <startup\|l6\|double\|noprov\|all> [runs]`，每行一个 JSON，后端真相用数据根里 `sessions/` 目录数交叉验证（不信任前端列表）。<br>**结论**：L6 记的「首条被吞」是假阳性——首条消息要先建会话，Enter→running 有 30–46ms 窗口，drive-l6 的 waitIdle 在窗口里轮询到「没在跑」就 400ms 宽限返回，再加种子 MCP 的 2s 启动超时把首回合拖过它 1.6s 的判定期限。带种子 3/3 误报、不带 3/3 首次即过，消息全部落库。<br>**顺带逮到两处真缺陷**（double 4/4、noprov 1/1），修法见 `docs/specs/2026-09-10-first-send-race-design.md`。 |

## T6 清场（2026-09-10）

| 文件 | 用途 |
|---|---|
| **`drive-t6e.mjs`** | 工具步骤展开区：`file_write` 造文件 → 新会话 `file_edit` 改它 → 展开后应见**差分视图**（路径相对化 + 增删计数），再用 `file_read` 验非 `file_edit` 工具回落到参数区。<br>**两个坑**：① 工作区是每会话的，第二个会话里要先把种子文件铺进它自己的 `sessions/<sid>/workspace/`，否则编辑 ENOENT、截图上留一条刺眼的「1 步失败」；② 这份剧本第一次跑就逮到一个源码守卫看不出来的老账——历史回放的标题一直是裸工具名（`input` 落库是 JSON 字符串，`isRec()` 恒为 false）。**源码文本守卫证明「传下去了」，证明不了「点开看得见」**，这条链必须实拍。 |

## 本批（T / U / V 波，2026-08-21）

| 文件 | 用途 |
|---|---|
| **`drive-v1.mjs`** | **唯一走权限门的剧本**。两条路径：`shell` 模式跑 gated 命令（`npm install …`）、`write` 模式往工作区外写文件（带差分预览）。<br>**触发要点**：只读命令（`Get-ChildItem` 等）默认 `bypass` **不弹卡**——第一版剧本就栽在这，白跑两轮。必须用 gated 类命令。<br>**为什么最重要**：换壳时权限卡被整个漏掉，1890 例全绿 + typecheck 0 + 之前所有实拍都没发现，因为没有一个剧本走过权限门。 |
| `drive-u2.mjs` | Office 三格式内容预览。文件由 agent 自己用 `office_write` 产出，再由预览区 `office.read` 读回——**一条链两头都验**（U4 的 e2e 与 U2 的渲染一次跑完）。 |
| `drive-u2b.mjs` | Office 边界：legacy `.doc` 走「明说不支持」、坏掉的 `.docx` 走「解析失败 + 出路」。两条都不能是空白或英文堆栈。 |
| `drive-v45.mjs` | 终端抽屉（连接提示行）+ 任务面板（上下文水位）+ 改动清单认出 `office_write` 产出物。 |
| `drive-v7.mjs` | 扩展市场：搜索 / 源 chips / 详情 / MCP 空态。容器里两个源都不可达，正好验「连不上市场」这条诚实文案。 |
| `drive-v9.mjs` | 文本选区注释全链路：**真鼠标拖选** → 浮条 → 注释 → CSS Highlight 着色 → 点高亮开气泡 → 存笔记 → 再拖选走引用。 |
| `drive-t.mjs` | T 波换壳后的欢迎页 / 会话页明暗四张。 |
| `drive-t4.mjs` | 三栏工作台：对话列 + 产出物预览 + 工作区面板；含分栏对照态与改动 tab。 |
| `drive-t5.mjs` | 五个舞台视图逐个走：设置七节 + 助手 + 定时 + 设备（含配对码）+ 搜索。<br>**注意**：导航按钮文本带计数（「助手3」），匹配要用 `startsWith` 不能全等——栽过一次。 |
| `drive-typo-ab.mjs` | 排版 A/B 试验台：同一界面注入不同 token 覆写逐档截图。**不靠印象调排版**用的。 |
| `drive-ui-audit.mjs` | UI 审计：批量取关键区块的计算样式与几何，输出 JSON 供比对。 |

## 更早批次

`drive-e2e-use` / `drive-e3-content` / `drive-e3b` / `drive-g3-market` / `drive-g3-usage` /
`drive-h2-anno` / `drive-i5` / `drive-i6` / `drive-j3` / `drive-k3` / `drive-l6` /
`drive-mcp-ui` / `drive-r3` / `drive-theme` / `drive-use2`

其中两个仍值得照抄：

- **`drive-l6.mjs`**——`sendMsg` 带落库校验与重试。turnEnd 广播先于后端清 inFlight，
  固定 sleep 后直接连发第二条**会被回合竞态吞掉**。落库校验的思路值得抄，**但它的 `waitIdle`
  不能抄**：首条消息 Enter→running 有几十毫秒窗口，`keyboard.press` 一返回就轮询会看成「没在跑」
  直接放行——L6 记的「首发竞态」就是这么误报出来的（X 波 drive-x1 `l6` 场景 3/3 复现）。
  发消息类 driver 照抄 drive-x1 的 `waitTurn`：**先等 running 起来，再等它落下**。存档件本身不改，
  改了就复现不了那个假阳性。
- **`drive-r3.mjs`**——打包产物（asar 态）冒烟，验的是 `dist/` 里的东西不是源码。
