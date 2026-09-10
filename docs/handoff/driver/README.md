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
  固定 sleep 后直接连发第二条**会被回合竞态吞掉**。发消息类 driver 一律照抄它。
- **`drive-r3.mjs`**——打包产物（asar 态）冒烟，验的是 `dist/` 里的东西不是源码。
