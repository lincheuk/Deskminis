# L 波设计稿：候选池批次一——输入历史 / @ 文件 / 锚点轨 / md 预览 / 会话级 MCP UI

状态：**定稿即施工**（自己做模式；用户 2026-08-20「做建议立项和候选池」授权）。
候选池全量裁定见 §6——五项本波做，四项留池附理由（不是遗忘是裁定）。

## §1 L1 输入历史上翻

- 行为：composer 输入框**为空**或**正显示某条历史**时，↑ 取上一条本会话用户消息、↓ 取下
  一条（到底清空回落）；一旦手动编辑（内容 ≠ 当前历史条）即退出历史态。斜杠菜单开着时
  ↑↓ 归菜单（既有 onSlashNav 优先级不动）。
- 数据：chat.messages 里 role='user' 的 text part（乐观 local- 消息也算——刚发的最该能召回）。
- 实现：纯模块 lib/composer/history.ts `histStep(entries, current, cursor, dir)` 返回
  { text, cursor }（8 例单测：空表/越界钳制/编辑退出判定）；ChatView onSlashNav 头部让位。

## §2 L2 @ 文件引用

- 行为：光标前 token 形如 `@片段` 时弹文件菜单（slashmenu 同款 UI），模糊匹配工作区文件
  相对路径，选中把 `@片段` 换成相对路径文本。价值 = 快速把文件路径写进指令（agent 读文
  本路径，零协议开销）。
- 数据：复用 files.list（单层懒加载）——**前端受限递归**拉全量：深度 ≤4、总数 ≤500、
  目录名跳过 ['.git','node_modules','out','dist','build','__pycache__','.venv']，
  菜单首开时拉、会话切换失效；上限截断在菜单尾行明示「仅前 500 项」。不加后端搜索
  RPC（真实需求出现再立项，files.list 语义不动）。
- 触发正则：`/(?:^|\s)@([^\s@]*)$/` 打在「光标前文本」上（slash 是整行首 token 语义，
  @ 是光标处 token 语义——调研点名的差异）。匹配：路径子串 + 文件名前缀加权，取前 8。
- 实现：纯模块 lib/composer/at-files.ts（token 解析 + 过滤排序，10 例）+ ChatView 菜单
  （slashmenu 结构照抄，独立状态不共用——两菜单互斥：@ 态不开 slash）。

## §3 L3 消息锚点导航轨

- 行为：`.pane-c` 右缘竖排小点轨（≥3 个回合才显示，welcome 隐藏），每点对应一个回合
  （title = 用户消息首 24 字），点击平滑滚动到该回合；实时回合追加脉动点。不做拖拽刷
  （minimap 是重活，点击导航先覆盖 90% 场景）。
- 实现：turn section 补 `data-turn-id`（renderer-turn 守卫若锚该行则改锚申报）；
  轨为绝对定位 nav（原生 button 点，a11y 成例）；scrollIntoView 仿 permFocusRequestId
  成例（ChatView.vue:317-323）。

## §4 L4 FilesPanel md 预览

- `.md/.markdown` 文件预览走 `parseMarkdown(content) → <MarkdownView :nodes>`（调研：缺口
  极小，零依赖解析器 + XSS 白名单现成）；其余文件 `<pre>` 现状不动；预览头加「源码/渲染」
  段控（.seg 成例，仅 md 文件出现）。解析器不支持的语法自然降级为纯文本段——安全优先。

## §5 L5 会话级 MCP 勾选 UI（后端全通，纯补 UI）

- 调研证实：sessions.mcp_disabled_json + setMcpDisabled RPC + 双保险执行全在
  （README 也早已宣传），renderer **零入口**——纯 UI 缺口。
- 实现：composer 工具行加「MCP」pill（仅活动会话且存在已启用 server 时显示）→ 行内
  面板（wspanel 成例，非浮层）逐 server checkbox「本会话禁用」→ chat.sessions.setMcpDisabled；
  面板文案说明「禁用即时生效于下一回合」。store 补 sessions 的 mcpDisabled 镜像。

## §6 候选池全量裁定（本波不做的四项，理由入册）

| 项 | 裁定 | 理由 |
|---|---|---|
| 图片生成 | **留池** | 需 provider 协议新面（图像模型配置/输出落盘/消息内嵌）——独立设计稿量级，塞批次波必糊 |
| 内置浏览器 | **留池**（占位 tab 文案不变） | 独立里程碑（Playwright/CDP + 安全面），交接文档一直如此标注 |
| 办公技能包 | **留池** | 内容工程非代码工程：无 OfficeCLI 类本地工具时，「教 agent 用 python-pptx/PowerShell」质量不可保证——宁缺毋滥，待用户对产出格式拍板后单开 |
| 忙碌排队草稿 | **留池** | 依赖回合完成接缝的队列语义（K 波 runDoneHooks 是单钩子非队列）；输入历史已缓解「打好的话丢了」痛点 |

## §7 拆步

| 步 | 内容 | 先红 |
|---|---|---|
| **L1** | 输入历史（纯模块 + ChatView 接线） | composer-history 纯测 + renderer-composer 改锚 |
| **L2** | @ 文件（纯模块 + 菜单 + 受限递归拉取） | composer-at-files 纯测 + renderer 守卫 |
| **L3** | 锚点轨 | renderer-anchor-rail |
| **L4** | md 预览段控 | renderer-files-panel 改锚 |
| **L5** | 会话级 MCP pill | renderer-mcp-session |
| **L6** | xvfb 目视全批 + 全量对基线 + 记账 | —（终验步） |

L1-L5 每步独立 commit；小步可合并 commit 时在消息里逐项列明。
