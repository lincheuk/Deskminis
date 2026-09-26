# DSH 桌面端界面与交互研读笔记（按产品形态看）

日期 2026-09-26。只读研读，没有运行任何一方的代码，也没有联网。

- **DSH**：/home/user/refs/deepseek-harness，HEAD 46a7f68b0，0.1.7-rc.1，MIT。下文写作 `dsh:`。
- **DeskMinis**：/home/user/Deskminis/deskminis/src，HEAD 35aab54。下文写作 `dm:`；渲染端写作 `dm:r/`，等于 `dm:renderer/src/`。
- **对照路线**：deskminis-docs/…/2026-09-24-resurvey/roadmap.md，含 2026-09-25 拍板的 O1–O7 与 F1。
- **避免重复**：9/24 的 dsh.md 已写过的条目，这里只在有新发现或需要更正时再提。
- **标注约定**：「推断」表示没有逐行核实，是按命名或文档作的判断。「照抄改写」指 MIT 代码移植到 Vue，须在 THIRD-PARTY-NOTICES 新增 DSH 一节（现有 §3 专属 pi-mono）。

---

## 0. 形态总览

### DSH 从第一次启动到进入主界面

1. 单实例锁，然后拉起 Host：`dsh:apps/desktop/src/main.ts:1116`、`:380-432`。
2. 主窗口先建好但不显示，Host 就绪后读欢迎态：`main.ts:997-1009`。
   - 判据是 `needsWelcome = !loggedIn && !hasApiKey`，见 `welcome-api.ts:58-60`。
3. 需要欢迎时，开一个独立的 600×700 欢迎窗（Windows 用 acrylic 材质）：`welcome-window.ts:16-48`。
   - 入口页有两个按钮：「登录」（DeepSeek 账号，浏览器 PKCE）和「添加 API Key」。
   - Key 页有三个按钮：「保存并继续 / 稍后配置 / 返回登录」。见 `src/client/WelcomePage.tsx:158-205`。
4. 「稍后配置」不写任何完成标记，下次启动还会检查：`welcome-api.ts:34-38`，`apps/desktop/README.zh.md:117`。
5. 进入主窗后，Web 端引导协调器按顺序一次只挂一步：`ui-settings-general` README「引导步骤」。
   - 第一步是版本化的「内测声明」弹窗。版本号是 `2026-08-13.1`，见 `ui-settings-models/src/onboarding-copy.ts:11`。
   - 第二步是 DeepSeek Key 弹窗。桌面端由 preload 标记抑制，因为欢迎窗已经问过。
6. 空安装时自动建「默认工作区」目录和一个空白会话。选中后输入框可编辑，但不自动发送。见 `ui-workspace` README 第 50–56 行一带。

### DSH 主窗布局

- **三栏**：左栏是工作区分组的会话树；中栏是会话（头部、正文、输入卡）；右栏是每会话一个停靠面，可放多类 tab。
- **几何纯函数**：`packages/client/ui-layout/src/client/columns.ts:10-59`。
- **Windows 顶栏**：40px（`windows-layout.ts:4`）。顶栏里有「应用 / 编辑」小菜单条，见 `preload-menu.ts`。

### 与 DeskMinis 的一句话对照

DeskMinis 没有独立欢迎窗，也没有账号；首启靠欢迎页的 ModelBar 空态引导去设置页。三栏形态已经相同（NavRail | Stage | WorkspacePanel）。右栏按 O5 收成「文件 / 改动」两个 tab。

---

## 1. 首次启动、登录与模型 / Key 引导

### 1.1 首启只问一件事：选服务商，然后贴 Key【最值得借；路线未排】

**DSH 怎么做**

- 欢迎窗 Key 页只有一个密码框，没有 base URL、模型 id、协议这些术语：`WelcomePage.tsx:166-175`。
  - 文案是「添加一个 API Key 开始使用 / 配置 DeepSeek 官方模型，即可开始使用」：`apps/desktop/src/locale.ts:181-182`。
- 模型设置页在「首启姿态」下，把官方 provider 直接渲染成展开的设置卡，而不是一行列表项；用户关掉之前一直如此：`ui-settings-models/src/client/ModelsSection.tsx:1-22`。
- 「添加提供商」卡用分段开关切两种方式：`ModelsSection.tsx:9-17`，README「新增与删除提供商」。
  - **第三方模型提供商**：从已装目录里选，只需填 Key。
  - **自定义模型 API**：Provider ID、端点、协议、至少一个模型。
- 端点占位符随协议变：OpenAI 类显示 `…/v1`，Anthropic 显示域名。
- 「获取可用模型」先用表单里的端点探测，弹出可搜索的勾选框，点「添加所选」才写入；支持全选或取消全选：`ModelListEditor.tsx:406-458`，`locales.ts:196-206`。
- 容量字段接受 `256K`、`1M` 这样的写法：`locales.ts:191-194`。

**DeskMinis 现状**

- 首启只有 ModelBar 空态一个按钮「先添加一个模型，才能开始对话」，点了跳到设置：`dm:r/ui/ModelBar.vue:62-65`。
- 设置页表单要填五个字段：名称、类型（Anthropic / OpenAI 兼容 / Gemini / Ollama）、base URL、模型 id、API Key。见 `dm:r/ui/settings/SecModels.vue:16-22`、`:142-189`。
- 没有任何国内厂商预设（DeepSeek、通义、Kimi、GLM、火山方舟、硅基流动、OpenRouter 等）。
- 「取列表」的结果只进一个 `<datalist>`，用户得自己点输入框去选：`SecModels.vue:170-176`。

**建议**：路线里任何子波都没有这一项（W4a 是内容，W4c 是引擎），是 cowork 定位下最大的上手门槛。

- 在 W4c 增加一个 UI 子项：一张「厂商预设表」，包含 名称、kind、baseUrl、默认模型、去哪拿 Key 的链接。这张表同时喂给 `detectCompat(baseUrl)`，一表两用。
- SecModels 的新增卡改成两段：「选服务商→只填 Key」和「自定义」。
- 欢迎页 ModelBar 空态直接内嵌「选服务商 + 贴 Key」的小卡，不再跳设置页。
- 获取模型的结果改成可搜索的勾选弹窗。
- 若想更早上线，可以随 W4a 发的 0.3.1 先出只有预填表的轻量版。
- 借法：只借思路。DSH 的实现绑在 pi-ai 目录和 Cordis settings 上，代码不适用。

### 1.2 Key 粘贴校验【照抄改写，S】

**DSH 怎么做**

- 客户端判定规则：可打印 ASCII `[\x21-\x7E]`；拒绝 `NAME=value` 形式的环境变量行（要求名字全大写，并排除 base64 的 `==` 结尾）；拒绝首尾成对的引号或反引号。见 `ui-settings-models/src/client/apiKey.ts:12-57`，欢迎窗里的同款在 `WelcomePage.tsx:73-82`。
- 主进程 IPC 再校验一次：`welcome-window.ts:79`。
- 空字段表示「保留原 Key」，不算错；只有空白字符算错（`apiKey.ts:44-54`）。
- 两种错误共用一句提示，理由是用户下一步的动作一样（`apiKey.ts:25-31`）。文案见 `locale.ts:187-188`：「请仅输入 API 密钥，不要包含引号、空格或环境变量赋值。」

**DeskMinis 现状**：SecModels 的 apiKey 字段不做任何格式校验（`SecModels.vue:180`）。从文档复制来的 `export DEEPSEEK_API_KEY=sk-…` 或带引号的值会原样存下，之后请求 401，报错与粘贴错误对不上。

**建议**：与 1.1 同波（W4c UI 子项），`apiKey.ts` 约 20 行可以直接改写成纯函数，先写测。

### 1.3 「稍后配置」不写完成标记，引导由状态推导【DeskMinis 已符合，守住即可】

- **DSH**：`needsWelcome` 是纯推导（`welcome-api.ts:58-60`）；账号登出且没有 Key 时回到欢迎窗（`main.ts:408-413`）。
- **DeskMinis**：ModelBar 空态也由 `chat.providers.length` 推导（`ModelBar.vue:42`、`:63`），没有 onboarded 标记。
- **建议**：以后做 1.1 的首启卡时守住这一点，不引入「已完成引导」标志；可以加一条源码守卫。

### 1.4 独立欢迎窗、账号登录、内测声明、强制更新【不学】

**DSH 怎么做**

- 独立 BrowserWindow 做欢迎（`welcome-window.ts`、`main.ts:947-996`），自带一套 IPC 注册与注销，还要处理与主窗互相显隐的竞态。
- DeepSeek 账号走 PKCE 加临时回环回调，带内嵌的平台用量和充值页（`main.ts:625-638`、`platform-view.ts`）。
- 版本化「内测声明」模态必须点「继续」（`WelcomeNotice.tsx:34-76`）。
- 测试版的强制更新策略要求先经飞书登录（`mandatory-update-policy.ts`、`locale.ts:228-257`）。

**不学的理由**

- DeskMinis 是 BYOK、数据只在本机，没有账号体系。
- 强制更新与「用户掌控更新」冲突。
- 独立欢迎窗多出一套窗口生命周期和 IPC 面，而 DeskMinis 在 Stage 内做一张首启卡就够了。
- 只借流程顺序：先模型、后其他，一次只出一步。

---

## 2. 主窗布局与几何

### 2.1 三栏几何纯函数【照抄改写 → W9b 可拖分栏】

**DSH 怎么做**：`columns.ts:10-59`

- 中栏最小 400px。
- 右栏先缩到 300px，再放不下就整条让出；中栏只有在右栏已让出之后才允许继续压缩。
- 左栏 264–420px，默认 280px；收起后留 56px 的图标轨。
- 视口小于 1024px 时左栏自动收起；打开右栏也会收起用户手动展开的左栏（`ui-layout` README）。
- 右栏首次打开占视口 45%，之后记住用户的像素宽度，上限 70%。

**DeskMinis 现状**

- 宽度是写死的 token：rail 220 / 52，aside 244，chatcol 372，stage 760（`dm:r/styles/theme.css:139-143`）。
- 预览打开时 NavRail 自动变成 compact（`dm:r/ui/NavRail.vue:14-16`）。
- 窗口最小宽度 900px（`dm:main/index.ts:232`）。

**建议**：W9b 做可拖分栏时，把 `computeColumns` 作为纯函数先写测，数值与 AionUi 的 `useResizableSplit` 对一下再定。借其中「右栏先缩后让，保中栏 400px」这条优先级。

### 2.2 输入卡控件行测量后降级【照抄改写 → W5b】

**DSH 怎么做**：`ui-conversation/src/client/skeleton/control-row-layout.ts:10-40`，约 30 行。

- 用 ResizeObserver 和 MutationObserver 量控件行；放不下时给行加 `data-model-compact`，模型位只留图标；连图标都放不下才允许换行。
- 字体加载完成后重新量一次。

**DeskMinis 现状**

- Composer 底行依次是：＋、@、MCP 胶囊、模型胶囊（最宽 190px）、权限胶囊、发送键（`dm:r/ui/Composer.vue:359-383`、`:430-449`）。
- 没有换行，也没有降级。
- 分栏态对话列只有 372px。W5b 还要把占用环塞进这一行，溢出几乎是必然。

**建议**：放进 W5b 占用环那一个提交，一起加「控件行测量→模型胶囊只留图标」。约 30 行，零依赖。

### 2.3 右栏停靠面：dockkit 分栏、浮窗、每会话布局存 localStorage【不学（大部分）】

**DSH 怎么做**：`ui-sidebar-right` README「状态 / 引导页」。

- 最多左右两格，还支持浮窗和撤销历史。
- 每会话的布局 JSON 存在 `dsh.sidebar-right.v1.<sessionId>`，切回会话时恢复。

**DeskMinis 现状**：切换会话时清空预览 tab（`dm:r/ui/AppShell.vue:67`）。

**建议**

- 不学分栏和浮窗（O5 已把右栏收成两 tab）。
- 「按会话记住打开的预览」可以只借思路，用一个内存 Map 就够，放 W9b。优先级低。

---

## 3. 会话列表、状态、搜索与归档

### 3.1 会话行状态由纯函数派生【照抄改写 → W7b 等待态 reducer 的显示层】

**DSH 怎么做**：`ui-workspace/src/client/rows/Rows.tsx:330-376`、`:604-612`

- 优先级从高到低：
  1. **待处理交互**（橙点）：审批、计划审阅、提问。
  2. **运行中**：转圈点，包括子代理在跑。
  3. **已完成未查看**：绿点，打开会话即清。
  4. **空闲**：无点。
- 有待处理交互时，行尾的更新时间换成紧凑短字「待审批 / 计划待审 / 待回答」（`Rows.tsx:633-639`，文案见 `ui-workspace/src/client/locales.ts:96-102`）。
- 所有状态都用视觉隐藏的文字交给读屏，点本身是 `aria-hidden`（`Rows.tsx:383-390`，`ui-primitives/src/StateDot.tsx:33-65`）。
- 归档行把状态放进悬停卡，行内不显示。

**DeskMinis 现状**

- 等待审批时，NavRail 行尾显示一个盾牌图标（`dm:r/ui/NavRail.vue:151`）。
- 运行中和已完成未读没有任何标识。
- 对话流顶部有「另有 N 个会话在等你批准」提示条（`dm:r/ui/StageChat.vue:187-193`）。

**建议**：W7b 的等待态 reducer 已排进路线。显示层照 `sessionStatuses` 改写：三态点加上「行尾短字替换时间」，再给读屏隐藏文字。ask_user（W7b）上线后，「待回答」同一个位置直接复用。

### 3.2 新建会话复用空白会话，空白会话不进列表【只借思路 → W8a】

**DSH 怎么做**

- `reuseOrCreateBlank`：先找该工作区里未归档的空白会话复用，找不到才新建（`ui-workspace/src/client/navigation.ts:178-196`）。
- 同一工作区在建的请求会合并（`:170-176` 的 connecting Map），所以双击「新建」只会得到一个会话。
- 空白会话只有当前选中的那一个显示在列表里（`tree.ts:238-250`），并且在首条提示词之前不显示时间和行动作（`Rows.tsx:629-640`）。

**DeskMinis 现状**

- 每点一次「新建会话」就走一次 `chat.sessions.create`（`dm:r/stores/chat.ts:472`）。
- 列表列出全部会话，包括没有消息的（`dm:minisd/store/chat-store.ts:88-91`）。
- 所以连点几次会堆出好几条「新会话」。

**建议**：W8a 已经要改「inChat 只看 activeId、空会话显示助手空态」，顺带做两件事：一是「新建」复用现有空会话，二是 NavRail 隐藏非当前的空会话。后端只需在 list 里带一个 `messageCount` 或 `blank` 位，或在渲染端按 `updatedAt === createdAt` 推断，后者须核实。

### 3.3 归档优先，删除退居二线；撤销 toast【只借思路 → W8c】

**DSH 怎么做**

- 会话行菜单只有「重命名 / 分叉 / 置顶 / 归档」，没有删除（`ui-workspace/src/client/locales.ts:45`、`:51-55`）。
- 空闲会话归档不弹确认，直接提交，然后出 toast：「会话已归档，可［撤销］或［筛选已归档会话］」（`locales.ts:59-60`、`:76-78`）。
- 会话里还有在跑的工作时，弹「停止并归档此会话？」，按族列出要停的回合、子代理、后台任务、定时提醒（`locales.ts:61-75`）。
- 视图选项可切「显示已归档 / 仅显示已归档」；已归档的行置灰，不能打开（`locales.ts:24-25`、`:58`）。
- toast 的宿主比发起面板活得久（RowActionToast）。依据是 UI/UX 技能：`dsh:.agents/skills/dsh-client-ui-ux/SKILL.md:29-30`。

**DeskMinis 现状**

- 行内菜单是：记忆开关、模型下拉、重命名、删除会话；删除前确认「确认删除？此操作不可撤销」（`NavRail.vue:155-200`）。
- 没有全局 toast 宿主，只有 StageMarket 自己的局部 toast（`dm:r/ui/StageMarket.vue:207-209`）。

**建议**：W8c 的「删除墓碑与归档优先」按这个形态出设计稿：

- 行菜单把「删除」换成「归档」，并配撤销 toast。
- 永久删除移到「已归档」筛选视图里，保留二次确认；同步需要墓碑。
- 先做一个全局 toast 宿主（挂在 AppShell 上）。

### 3.4 会话搜索：标题即时匹配，正文 250ms 防抖，每次新查询取消上一次【只借思路 → W8c】

**DSH 怎么做**：`ui-workspace/src/client/rows/WorkspaceBrowser.tsx:50-54`、`:1035-1070`

- 标题和工作区名做子串匹配，结果立即出。
- 250ms 防抖后向 Host 发正文搜索，结果带摘要片段并排序。
- 每次新查询 abort 上一次；正文搜索失败时静默，只保留元数据结果。
- 最多 20 条；查询长度上限 500 个 UTF-16 码元。
- 搜索框收在区头按钮里，点开后展开。

**DeskMinis 现状**

- StageSearch 只搜标题（`dm:r/ui/StageSearch.vue:20-24`），并如实说明「消息正文还没有索引」（`:37`）。
- 它是一个独立的全屏视图，不在左栏。

**建议**：W8c 做 LIKE 正文搜索时采用「标题即时 + 正文防抖取消 + 片段」的两段式。已有的全屏搜索视图可以保留，避免改动 NavRail 布局。

### 3.5 置顶：DeskMinis 有列、有分组，却没有写入入口【小缺口 → W8c】

**DSH 怎么做**：置顶、取消置顶在行菜单和行内动作里都有（`ui-workspace/src/client/session-actions/PinSession.tsx`）。

**DeskMinis 现状**

- `sessions.pinned_at` 列存在（`dm:minisd/store/db.ts:12`），NavRail 分组也会画「已置顶」（`dm:r/lib/nav/group.ts:33-53`）。
- 但 minisd 的 RPC 表里没有设置置顶的方法（`dm:minisd/index.ts:616-772` 一带只有 list、create、applyAssistant、delete、rename、setModelBinding、setMemoryEnabled、setMcpDisabled）。
- 推断：只有同步对端写进来的置顶会显示；本机无法置顶。

**建议**：W8c 顺带补一个 `chat.sessions.setPinned` 和行菜单项，S 级。

### 3.6 标题双击重命名、长标题悬停滚动、悬停卡【低优先】

- **DSH**：`Rows.tsx:619-624`，README「管理会话」。
- **建议**：列入 W9c 的打磨候选，不必专门排期。

---

## 4. 输入框（Composer）

### 4.1 输入法组字与回车：三道闸【照抄改写 → W7b（路线已列 229，补全其余）】

**DSH 怎么做**：`ui-conversation/src/client/input/editor/keymap.ts:48-53`、`:70-83`、`:135-155`

- **组字判断**：`isComposing || keyCode === 229`，再加上 compositionend 之后 10ms 的保护窗。Safari 的收尾 keydown 会晚到，这 10ms 就是为它留的。
- **Shift+Enter 永远换行**：在组字判断之前就放行。
- **组字中的 Enter**：交给输入法选词，既不发送也不换行。
- **按住回车**（`event.repeat`）不连发。
- **Ctrl/⌘+Enter**：走另一种投递方式（排队或插话）。
- 组字期间隐藏占位符和命令提示（`keymap.ts:9-15`，README「Shell 与标准 props」）。

**DeskMinis 现状**

- `@keydown.enter.exact.prevent="onEnter"`，没有任何组字判断（`dm:r/ui/Composer.vue:351`）。
- 渲染端全局 grep `isComposing|229|composition` 零命中。

**建议**：W7b 验收里已经写了「微软拼音、搜狗回车上屏不误发」。把 isComposing、10ms 窗、repeat、Shift+Enter 四条写成一个纯函数 `lib/composer/enter-guard.ts`，先写测。ask_user 的问题卡（W7b）复用同一个函数。

### 4.2 单一常驻 Composer：空态与会话态不重挂载【只借思路 → W8a】

**DSH 怎么做**

- 输入框挂在 ConversationRoot 上，空白态和会话态共用，切换时不重挂 textarea（`ui-conversation/src/client/skeleton/EmptyHero.tsx:1-2`、`:159`）。
- README：「常驻 composer 在无 Session 与有 Session 之间保持挂载」。

**DeskMinis 现状**

- 欢迎页和会话页各有一个 Composer 实例（`dm:r/ui/StageWelcome.vue:57`、`dm:r/ui/StageChat.vue:271`），靠 AppShell 的 `inChat` 二选一（`AppShell.vue:54`、`:96-106`）。
- 为了不丢字，store 里有 draft 和 relayDraft 两套交接，都在 setup 时 takeDraft / takeRelay（`Composer.vue:272-303`）。
- 首条消息发出时实例被替换，焦点、光标、组字状态都会丢。

**建议**：W8a 重构 inChat 时，把 Composer 提到 Stage 层常驻：欢迎态只换上方的 hero 和助手空态，底部输入卡不动。draft 和 relay 两套交接随之简化，现有守卫要同步改指向。

### 4.3 工作区 chip 放进输入卡【只借位置 → W8a】

**DSH 怎么做**

- 空白会话的输入卡上有一枚工作区 chip（文件夹图标、名字、下拉箭头），首条消息发出前都能切换（`EmptyHero.tsx:27-62`）。
- 还没有会话时，整张输入卡就是「选择工作区」按钮（`InputBar.tsx:150`、`:376-378`）。

**DeskMinis 现状**：绑定入口只在右栏「文件」tab 的顶部（`dm:r/ui/WorkspacePanel.vue:114-140`）。O6 已定：要把右栏默认收起，必须先把这个入口挪出来。

**建议**

- W8a 把工作区 chip 放到输入卡的附件行，只在空会话或首条消息之前显示；之后移到会话头或右栏。这正好满足 O6 的前置条件。
- 不学「无会话时整卡变成选择工作区按钮」：cowork 的默认会话沙箱已经够用，不要逼用户先选文件夹。

### 4.4 「＋」与「/」打开同一个菜单，分「添加 / 指令」两段【只借思路；路线未排】

**DSH 怎么做**：README `ui-commands`「使用本包」一节，`InputBar.tsx:418-432`。

- 分两段：「添加」有文件、目标、计划、反馈；「指令」有压缩、权限、模型、下载日志。
- 每一行都有图标、中文标题和说明；中文标题与命令名不同时，把命令名当别名显示。
- 模糊匹配按子序列，前缀优先。
- 带附件提交时，只有声明了接收附件的命令能过，否则弹 toast，草稿不动。

**DeskMinis 现状**

- ＋ 只能选图片（`Composer.vue:360-363`）；@ 按钮只是往框里补一个 @（`:364-366`）。
- 斜杠菜单只列技能（`:61-69`）。
- 9/24 的 dsh.md 已建议加「命令」分组，但路线里没有排期。

**建议**：cowork 用户不会敲斜杠。可以放进 W9c（输入区打磨），或并到 W7a 的 queue 改动里：＋ 菜单列出「添加图片 / 引用文件 / 选择技能 / 切换模型 / 权限」，与 / 共用同一张纯数据命令表。

### 4.5 占位符讲清可用手势，并随状态变化【照抄文案思路 → W7a】

**DSH 怎么做**：`ui-conversation/src/client/locales.ts:16-27`

- 默认：「发消息或创建任务, / 调用指令, @ 文件或对话」。
- 排队时：「Cmd/Ctrl+Enter 插话发送全部排队消息」。
- 会话不可用、父会话离线、计划模式各有专用文案。
- 运行中的发送键标签跟着回车设置变：「排队发送 / 插话发送」（`:26-27`）。

**DeskMinis 现状**：占位符只有「让 {助手} 做点什么…」，不告诉用户 / 与 @ 能做什么（`Composer.vue:55-58`）。

**建议**：W7a 做 queue 和 steer 时，占位符与发送键 aria-label 跟运行态变：「回车排队，Ctrl+Enter 插话」。平时的占位符补上「/ 技能 · @ 文件」。

### 4.6 「@」可下钻文件夹、可 @ 会话【只借思路，未排期】

**DSH 怎么做**：`ui-reference` README

- 先列文件，再列会话；某一组加载失败，另一组照样可用。
- 文件夹行可以就地下钻，不关菜单。

**DeskMinis 现状**：一次拉平最多 500 项，超出只提示截断（`Composer.vue:336`，`dm:r/lib/composer/at-files.ts`）。办公目录文件很多时基本不可用。

**建议**：先做文件夹下钻（纯渲染端，按目录懒加载），放 W9c 候选。@会话需要后端取另一会话的上下文，暂不做。

### 4.7 语音输入【不学】

**DSH 怎么做**：实验包 `client-ui-voice-input`。麦克风按钮放在模型位和发送键之间，展开后是带音量波形的录音条，有取消和停止，转写结果进草稿。背后是 `speech-to-text-sensevoice`，用 sherpa-onnx 原生包，模型要从 HF 或镜像下载。

**不学的理由**：违反零依赖（原生 ONNX 加模型下载）。Windows 自带的 Win+H 语音听写在 Electron 的 textarea 里本来就能用。可以在帮助或占位符里提一句，不自建。

---

## 5. 工具步骤与权限确认

### 5.1 审批面板：答复失败要恢复按钮【照抄改写 → W7b（PermCard 停靠时顺手修）】

**DSH 怎么做**：`ui-approval/src/client/ApprovalPanel.tsx:20-55`

- 点击后立刻 `answered = true`：按钮禁用，状态点变成转圈，`aria-busy`。
- RPC 失败时 `setAnswered(false)`，按钮恢复，可以重试。
- 正文是可聚焦的滚动区（`tabIndex=0`，`role=group`，`aria-label="审批详情"`）。
- 详情由工具自己的视图渲染（`conversation.approval.detail` 槽），与对话流里的工具卡同形。
- 只有「允许一次 / 拒绝」两个按钮，没有超时：`user-approval/src` 下 grep timeout 零命中。

**DeskMinis 现状**

- `respondPerm` 先把卡从 `pendingPerms` 里删掉，再发 RPC，没有 catch（`dm:r/stores/chat.ts:611-614`）。
- PermCard 直接 `@click="chat.respondPerm(...)"`，同样不接异常（`dm:r/ui/PermCard.vue:84-87`）。
- 结果是 RPC 一旦失败，卡已经不见了，引擎那边还在等，90 秒后自动拒绝。这属于「点了没反应」式的静默失效，触发窗口虽窄，但确实存在。

**建议**：W7b 把 PermCard 停靠到输入区时一起改：点击后置 pending（禁用加转圈），RPC 成功后再移除，失败就恢复按钮并在卡内说明原因；加一条红测。DeskMinis PermCard 自己的规矩全部保留：逐字完整、差分预览、桥类目双段告知、倒计时。

### 5.2 工具行：按工具出卡片模型，路径可点开预览【只借思路 → W7c】

**DSH 怎么做**：`ui-tool` README「内置视图 / 卡片」。

- 按工具名分派视图：shell、read、write/edit、grep/glob、web、todo、question。每种视图由一个纯 card model 校验参数和结果；格式不对就回落成通用压平文本。
- 路径先按会话 cwd 相对化，再把 home 写成 `~`；路径摘要可以点开右栏预览。
- terminal 卡：显示命令，输出超过 16 行时保留首尾、中间折叠，显示「展开 N 行」；有退出码胶囊和复制按钮（`ui-primitives/src/TerminalBlock.tsx:11`、`:64-65`、`:216`）。
- 非零退出码即使工具本身返回成功，也当作失败显示（`toolviews/bash-sample.tsx`）。
- diff 卡折叠前保留 9 行。
- 运行、失败、停止状态除颜色外都有隐藏文字（`bash-sample.tsx:27-35`）。

**DeskMinis 现状**

- StepGroup 的每一步只有一个点和一个标题，展开后是 JSON 参数加最多 2000 字的输出（`dm:r/ui/StepGroup.vue:50-70`）。
- 只有 file_edit 会渲染差分（`:32-34`）。
- 路径不能点；点只靠颜色区分，没有读屏文字（`:51`、`:90-94`）。

**建议**：W7c 已定「整组折叠加组头摘要」（O7）和「输出进度流」（F1）。

- 在展开区按工具出小卡：shell 用命令加首尾输出（行数照 16 行的规则），file 和 office 类显示可点的路径（打开 PreviewPane）。
- 给每个状态点加视觉隐藏文字。

### 5.3 组头文案：按类别用动词短语【只借思路 → W7c】

**DSH 怎么做**：`ui-chat/src/client/locale.ts:8-52`

- 每类有三种时态：「正在…」「准备…」「已…」，例如 正在读取文件、准备写入文件、已搜索网页。
- 拼接规则：「{first}并{second}」，逗号用「，」，共用前缀「已」只写一次，超出时加「{title}等」。
- 类别偏编码：「正在搜索代码」「运行了代码」。

**DeskMinis 现状**：组头只有「正在执行… / 已执行 N 步」（`StepGroup.vue:42-45`）。

**建议**：O7 定的是「写了 N 个文件 / 跑了 N 条命令」这类计数摘要，不冲突。

- 完成态的主体用计数；进行中用 DSH 式的「正在{类别}」，取最新一步。
- 类别按 DeskMinis 的工具名重写成办公语：office_write 写「生成文档」，file_grep 写「搜索文件」，不照搬「搜索代码」。

### 5.4 「准备中」行、回合折叠、四档详情【9/24 已写，无新发现】

---

## 6. 交付物与产出物

### 6.1 present 交付卡加收尾正文文件链接【只借思路 → W8a（与「用系统程序打开」同波）】

**DSH 怎么做**

- **present 工具**：schema 描述要求只在需要单独交付文件时使用，尤其 Office、表格、幻灯片；通常只挑最重要的 1–2 个，一次最多 4 个；文件必须已经存在。见 `packages/deliverables/tool-present/README.zh.md`「模型体验」。
- **交付卡**：单个交付占满一行，多个交付用双列网格，超过 4 个默认收起（`ui-deliverables/src/client/Deliverables.tsx:20`、`:87-89`）。
  - 卡上显示文件名、说明或文件类型，以及打开控件：默认应用、关联应用列表，「显示文件位置」永远排在最后。
  - 点卡片本身在右栏预览。
  - 打开成功的提示停留 5 秒后在 200ms 内淡出；失败提示保留到下一次尝试（README「显式交付」）。
- **收尾正文里的行内代码**：精确匹配本回合产出或交付的路径即可点；只写文件名时，只有当唯一一个路径的 basename 与之相同才可点，重名就不可点、不猜（`turn-deliverables.ts:255-283`）。

**DeskMinis 现状**

- 没有交付的概念。右栏「改动」tab 列出本会话写过的所有文件（`dm:r/lib/artifacts/collect.ts:45-85`），中间文件和临时脚本混在里面。
- 用 shell_execute 跑 Python 生成的 xlsx 不会出现在任何清单里：推断，因为 collect 只认 file_write、file_edit、office_write。
- 收尾正文里提到的文件名不可点。

**建议**：cowork 定位下这是「产出物是主角」的核心。

- W8a 增加一个零依赖的 `present` 工具：结果只回一句「已呈现」，路径落进 message part。回合末渲染交付卡，按钮用 W8a 已排的「用系统程序打开 / 在文件夹中显示」。
- 「行内代码→文件链接」可以更早做（W8a 甚至 W7c）：直接复用现成的 collectArtifacts 路径集，点击写 `chat.pendingFilePreview`。S 级。

### 6.2 改动卡是开发者面，交付卡才是用户面【呈现主次的调整 → W8a/W8b 设计稿】

**DSH 怎么做**

- 回合末的「改动文件卡」基于 git 快照：标题写文件数和增删行数，四行后折叠，悬停 500ms 出差分浮层，点击打开左右对比的 review tab。
- 这张卡只在「开发者工具」开启时显示，开关默认开（`ui-settings/src/developer-tools-settings.ts:15`，`ui-deliverables/src/client/index.ts:70`）。
- 交付卡和正文文件链接不受这个开关影响。

**DeskMinis 现状**：W8b 定的是「每个回合一张改动卡，一键回退」。

**建议**：范围不改，主次要改。cowork 默认下，回合末优先显示交付卡，再放一行「本回合改了 N 个文件［撤销］」；差分细节收进展开区或 W8a 的办公呈现档。DSH 用一个开关区分开发者面，印证了 W8a 办公呈现档这个方向。

### 6.3 预览不支持时给出路【只借思路 → W8a】

**DSH 怎么做**

- 文件无法预览时，空态用同一套打开菜单，按钮放大到 40px，显示「打开」或「显示文件位置」；没有默认应用时，主按钮就执行定位（`ui-open-in-app` README「预期行为」）。
- Excel 预览会列出「检测到但未展示」的图表、图片、形状、条件格式，并建议用系统应用打开（`ui-sidebar-documentpreview` README「Excel 预览」第二段）。
- CSV 和 TSV 默认用表格查看，可以切到纯文本。

**DeskMinis 现状**

- 老格式、PDF 或解析失败时，只有「复制完整路径」一个按钮（`dm:r/ui/PreviewPane.vue:105-125`）。
- OfficeView 有一句泛泛的边界声明（`dm:r/ui/OfficeView.vue:47`）。
- CSV 按纯文本显示（推断：PreviewPane 没有 csv 分支）。

**建议**

- W8a 把「复制完整路径」换成「用系统程序打开 / 在文件夹中显示」。
- office/parse 统计绘图部件和图片，在 OfficeView 上写出具体的「未显示 2 张图表、3 张图片」。
- 加一个零依赖的 CSV 表格视图，可以与 W4a 的表格整理技能配套。

不学：FortuneSheet、ExcelJS、SheetJS 和 LibreOffice 转 PDF。都是依赖，路线已明确排除。

---

## 7. 设置页结构

### 7.1 DSH 的分区

- **形态**：模态面板 760×500，左侧导航加右侧内容（`ui-settings-general` README 开头）。
- **通用**
  - 开发者工具开关、当前版本（ui-settings-general）。
  - 外观：主题三态，正文字号 12–17px，默认 14（`ui-theme` README「外观与字号」）。
  - 语言（locale）、网页链接的默认打开方式（ui-chat）、性能与用量的详细或简洁（ui-chat）。
  - 运行中回车的默认行为，排队或插话：`ui-conversation/src/client/settings/EnterBehaviorRow.tsx`。
- **模型**：见 1.1。
- **账号**：更新状态也放在账号行。
- **插件**：清单加各插件的配置页，只在对应命名空间被服务时注册（whileServed）。
- **连接指示**：侧栏底部，设置按钮右侧。9/24 已写，W6b 已排。

### 7.2 DeskMinis 的分区

- 全屏页，左侧七节：模型、权限、技能、MCP、网络搜索、外观、关于（`dm:r/ui/StageSettings.vue:18-28`）。
- 外观只有主题三态，存 localStorage（`dm:r/ui/settings/SecLook.vue:16-27`）。

### 7.3 建议

- **不必学模态形态**：全屏页对七节以上更合适，StageSettings 的注释也是这么说的。
- **按路线逐步新增「通用」一节，承接这些分散的偏好**：
  - 运行中回车的行为（W7a）。
  - 通知开关（W7b）。
  - 关闭窗口的行为：最小化到托盘还是退出（W7b，见 10.2）。
  - 办公呈现档，也就是「显示技术细节」（W8a，参照 DSH 的开发者工具开关，但 cowork 默认关）。
- **字号设置**：12–17 步进，默认 14。现在只有 Ctrl+/- 的整页缩放（`dm:main/app-menu.ts:21-28`），缩放会连带改变 146px 窗控保留区的对齐（W9c 已列真机校验）。按正文字号单独调对年长的办公用户更友好。放 W9c，可选。

---

## 8. 快捷键与右键菜单

### 8.1 编辑右键菜单【照抄改写 → W9b（S，Electron 内置）】

**DSH 怎么做**：`apps/desktop/src/main.ts:254-280`

- 可编辑区域：撤销、重做、剪切、复制、粘贴、全选，各项按 `editFlags` 启用或禁用。
- 有选中文本时只给「复制」。
- Windows 上用本地化标签；`accelerator: ''` 用来去掉 Electron 默认的快捷键提示。

**DeskMinis 现状**：主进程没有任何 context-menu 处理（`dm:main`、`dm:preload` grep 零命中）。打包后，输入框和正文右键都没有反应，办公用户没法用右键粘贴。9/24 在「窗口守卫」一条里提过，但路线没有单独列出（W2b-6 只做了导航守卫）。

**建议**：放进 W9b，或随「界面减法」（删 ☰）一起补上。中文标签写成常量加守卫测试，约 30 行。

### 8.2 全局快捷键：DSH 没有，W9b 继续以 ZCode 为基准【更正与确认】

- **DSH**：packages/client 下 grep 只看到 Escape 关浮层、输入框里的 Enter、Ctrl+Enter、Tab、Shift+Tab、↑↓，以及菜单的方向键；没有 Ctrl+N 或 Ctrl+K 这类全局注册（推断：没有）。
- **Windows 顶栏的「应用 / 编辑」小菜单条**（`preload-menu.ts:10-112`）：roving tabindex 加方向键；打开菜单前记住编辑器的选区，关闭后还原（`:28-50`）。
- **DeskMinis 现状**：渲染端只有 Composer 和若干弹层的局部按键。
- **建议**：W9b 的快捷键注册表继续以 ZCode 为基准。可以借 DSH 的一条细节：弹出菜单后把焦点和选区还给编辑器。不学顶栏菜单条：O1 要删 ☰，而「关于」和「检查更新」已经在托盘和设置里。

### 8.3 菜单与弹层内的键盘约定【照抄约定 → W7c/W9c】

DSH 的约定（`ui-commands` README，`ui-model-selection` README）：

- Tab 接受高亮项；Escape 和 Shift+Tab 离开菜单且不选定。
- 打开时高亮落在当前值上。
- 关闭后焦点回到触发按钮。

DeskMinis 的斜杠菜单与 @ 菜单已有 Tab、Enter、↑↓、Esc（`Composer.vue:128-144`），缺 Shift+Tab 和焦点归还，属于打磨项。

---

## 9. 模型选择器【只借思路 → W9c】

**DSH 怎么做**：`ui-model-selection` README

- 按 provider 分组；推理强度是二级下钻，只列当前模型公布的档位，没有元数据就不显示 Effort 行。
- 选择从下一次请求开始生效，运行中的步骤保留启动时的模型。
- 输入卡放不下时，模型文字降级为图标（见 2.2）。
- 会话路由不可用时，输入框停用并显示本插件的说明，恢复后自动解除。

**DeskMinis 现状**

- 输入卡上的模型胶囊是只读的（`Composer.vue:376`）。
- 改会话的模型要去 NavRail 行菜单里的一个 100px 宽下拉框（`NavRail.vue:159-175`）。

**建议**：W9c「模型选择器支持搜索和分组、思考档位胶囊」时，把胶囊本身变成选择器入口，采用分组、下钻、「下一次请求生效」的说明，以及路由不可用时停用输入框并说明原因。

---

## 10. 通知与注意力

### 10.1 更正 9/24：DSH 只对「更新就绪」做注意力提示【更正】

**DSH 怎么做**：`apps/desktop/src/update-attention.ts:6-57`

- 版本下载完成、窗口不在前台时：flashFrame，加一条 silent 通知。
- 窗口获得焦点即清除；点通知只回到安装确认界面，不代替用户安装。
- 这一类只用于更新。全仓 grep `new Notification|flashFrame` 只命中这里（另外 sdk/client 的 Notification 是 RPC 通知对象，无关）。
- 审批、提问、回合完成都没有系统通知；审批本身也没有超时（`packages/interaction/user-approval/src` 无 timeout）。

**对路线的影响**

- W7b 仍然可以照搬这套机制：失焦才提醒；每个事件一条 silent；聚焦即清；点通知只做 show 加 focus。
- 但「后台审批必须提醒」的必要性来自 DeskMinis 自己的 90 秒超时，DSH 不是它的先例。
- 去重与文案按路线已写的 AionUi 通知去重来做。

### 10.2 关窗隐藏到托盘，却没有任何告知【DeskMinis 侧缺口 → W7b】

- **DSH**：没有托盘；所有窗口关闭即退出（`main.ts:1035-1037`）。
- **DeskMinis**：关窗时 hide 到托盘（`dm:main/index.ts:263-264`），没有首次提示，也没有设置项。办公用户容易以为已经退出，或者找不到窗口。定时任务依赖进程常驻，所以隐藏本身是对的。
- **建议**：W7b 做通知时一并处理：第一次隐藏到托盘发一条通知「DeskMinis 仍在后台运行（定时任务需要），可从托盘退出」，只提示一次，状态存 userData；「通用」里放一个「关闭窗口时」选项。

### 10.3 更新前检查运行中的任务【只借思路 → W6a（main 生命周期）】

**DSH 怎么做**：`main.ts:503-549`，`locale.ts:215-220`

- 安装确认前先检查任务，文案是「仍有进行中的任务 / 重启更新可能中断这些任务 ［停止任务并更新］［稍后更新］」。
- 确认之后再加锁，并复查一次；期间有新任务开始，就提示「有新任务开始，请重新确认更新」。

**DeskMinis 现状**：`update-downloaded` 的对话框不看有没有正在跑的会话（`dm:main/index.ts:307-315`）。点「重启并安装」会优雅停止 minisd，正在跑的回合被中断，事先没有提示。

**建议**：W6a 抽 launcher 时顺手做：main 向 minisd 查询 inFlight 数，大于 0 时换成警示文案。

---

## 11. 国际化【不学】

**DSH 怎么做**

- 每个包各自注册类型化的中英词典，`satisfies` 强制两种语言的键齐全（`packages/client/locale` README，例如 `ui-approval/src/client/locales.ts`）。
- 设置里可以切语言；桌面壳另有一份 `apps/desktop/src/locale.ts` 词典，靠 IPC 与渲染端同步。

**不学的理由**：路线已定「国际化对中文 cowork 用户收益低」，而且为此要维护第二份壳词典。

DeskMinis 已有的「文案放纯模块」做法（`dm:r/lib/perm/copy.ts`、`dm:r/lib/eventnote/copy.ts`）继续保持就够了。可以借一条纯文案规则：中文提示不超过两句时，省略末尾的句号（`dsh-client-ui-ux/SKILL.md:32`）。可选。

---

## 12. 空状态与错误状态

### 12.1 删任务面板会让「上轮结束原因」无处显示【需调整 W5b】

**DSH 怎么做**

- 输出达到 token 上限时，在对话流的截断点插一行琥珀色提示（`ui-chat/src/client/conversation-nodes/turn-max-tokens.ts`，文案见 `ui-chat/src/client/locale.ts:157-158`）：
  - 「已达到输出 token 上限」
  - 「回答被截断，已有输出保留在对话中。发送"继续"可让模型接着输出。」
- 中间的重试不单独出提示；只有终止回合的错误才用红点提示（ui-chat README「指令与失败行」）。

**DeskMinis 现状**

- 「上轮结束原因」只在 TaskPanel 里显示，包括「达到单轮输出上限——回答可能被截断」和「模型拒绝作答」（`dm:r/ui/TaskPanel.vue:38-46`、`:101-104`）。
- 70% 和 90% 两档水位提示也只在 TaskPanel（`:59-61`）。
- 降级、压缩、卸载三项在 EventNotes 里另有提示（`dm:r/ui/EventNotes.vue:16-26`）。
- W5b 定的是「同一提交删掉任务面板（与占用环重复的三张卡）」。但结束原因和水位提示不在这三张卡里，面板一删就无处显示，重演 T 波「换壳丢入口」。

**建议**：W5b 删 TaskPanel 的那一个提交要做三件事：

- 把 maxTokens 和 refusal 的结束原因迁进对话流的 EventNote（琥珀色，文案照 DSH 的可操作写法）。
- 把 70% 和 90% 的提示放进占用环的悬停或点开面板。
- 用 W4b 的 SSR 渲染测试钉住这两项「入口没丢」。

**附带一个低优先项**：重试提示会一直留在 eventNotes 里，即使后来成功了（`dm:r/stores/chat.ts:666-673`）。DSH 不为中间重试出提示。可以在 W7c 改成「成功即撤下」。

### 12.2 空状态

**DSH 怎么做**

- 新会话主视觉极简：鱼形标志、「探索未至之境」、「预览版」徽标（`EmptyHero.tsx:132-164`，`ui-conversation/src/client/locales.ts:73-75`）。
- 不给示例提示词，靠占位符讲手势。
- 没有会话时，头部保留导航，输入框 inert（README「Shell 与标准 props」）。

**DeskMinis 现状**

- 欢迎页比 DSH 更丰富：hero、ModelBar、输入卡、助手卡网格、开场示例、最近会话（`dm:r/ui/StageWelcome.vue:46-99`）。
- 但开场示例是编码向的：「帮我读懂这个项目：从入口开始，讲清核心模块…」「…告诉我这个项目怎么跑起来」（`:39-43`）。

**建议**

- 欢迎页结构保留，不向 DSH 的极简靠拢。W8a 已定用助手空态做结构修。
- 编码向的示例与 cowork 定位不合，建议 W4a 的内容包顺带换成办公示例：周报、整理表格、改写文档、归档文件夹。S 级，纯内容。

### 12.3 致命错误对话框的组成【只借思路 → W6a】

**DSH 怎么做**：`apps/desktop/src/fatal-recovery.ts:20-40`、`:64-100`

- 一个进程只弹第一次。先最多等 1 秒写好崩溃报告，好把报告路径写进对话框。
- 对话框正文：错误的最后 8 行，限制在 1200 字以内，加「诊断报告：{path}」和「如果文件损坏请重装，任务数据存储在独立位置」。
- 按钮：［退出］［重启］［禁用第三方插件并重启］，默认是重启。
- 端口占用有专门文案（`locale.ts:153`）。

**DeskMinis 现状**：W6a 已排「可重试的错误页、安全模式、诊断包」。

**建议**：W6a 的错误页照这个结构来：尾部摘要、报告路径、「数据不在程序目录」的安心句，以及退出、重试、安全模式三个按钮。

### 12.4 反馈面选择规则【9/24 已写】

一次性结果用全局 toast，宿主要比发起面活得久；失败时保留原数据；面板级错误就地显示。DeskMinis 缺全局 toast 宿主，见 3.3。

---

## 13. 无障碍

| 项 | DSH | DeskMinis | 建议 |
|---|---|---|---|
| 状态播报 | 回合过程用一个 `role=status aria-live=polite aria-atomic` 的隐藏节点，只播状态跃迁（进行中→已完成、已停止、失败），不播每秒递增的用时（`ui-chat/src/client/chat/TurnProcessNodeView.tsx:41-47`） | 渲染端 aria-live 零命中 | W7c 的「aria-live 播报」照这个做：只在状态跃迁时播一次，照抄改写 |
| 只靠颜色的状态 | StateDot 设 `aria-hidden`，旁边配视觉隐藏的文字（`StateDot.tsx:30-31`，`Rows.tsx:383-390`） | StepGroup 的点、NavRail 的等待标只有 title | 随 W7b/W7c 补隐藏文字 |
| 减少动态效果 | 约 45 个 css/tsx 文件处理 `prefers-reduced-motion` | 零处理；回合导航点有 `railpulse` 无限动画（`StageChat.vue:344-345`） | W9c 加一段全局 `@media (prefers-reduced-motion: reduce)`，S |
| 文档语言 | 欢迎窗和主界面都设置 `<html lang>`（`WelcomePage.tsx:50`，locale 包） | `dm:renderer/index.html:2` 的 `<html>` 没有 lang | W9c 写死 `lang="zh-CN"`，读屏才会按中文读，S |
| 焦点归还 | 弹层、查看器、设置关闭后焦点回到触发处；欢迎窗切页后自动聚焦到输入框或按钮（`WelcomePage.tsx:59-65`） | 有全局 focus-visible 样式（`theme.css:253`）和键盘可达守卫（`tests/a11y-keyboard-reachable.test.ts`） | 随各弹层逐步补 |
| Todo 面板 | 默认收起；头部摘要为「已完成 N · 进行中 N · 待处理 N」，计数为 0 的段省略；每行状态点配 aria-label（`TodoPanel.tsx:51-66`、`:89`） | 没有 PlanBar | W7c 的 PlanBar 头部摘要按这条规则写 |

---

## 14. 占用环（W5b）补充【只借形态】

**DSH 怎么做**：`ui-conversation/src/client/skeleton/ContextMeter.tsx:1-5`、`:89`、`:95-106`

- 14px 的圆环加百分比；`aria-label` 为「上下文已用 N%」。
- 点开是 dialog 面板，里面是按 system、tools、messages 分段的条。
- 条的**总长**用 provider 报告的精确百分比，**分段**只按启发式比例切分；为 0 的段不画。
- 拿不到容量时整个隐藏；换模型导致容量消失时自动关掉面板。
- Escape 或点外部可以关闭。

**建议**：W5b 按 AionUi 的形态做环本身；点开的面板借 DSH「总长精确、分段启发」的画法，面板里同时接住 12.1 的水位提示。

---

## 15. 明确不该学（cowork 定位不合）

1. **工作区优先的开局**
   - DSH 的做法：没有会话时整张输入卡是「选择工作区」按钮；空安装自动建「默认工作区」目录（`InputBar.tsx:150`、`:376-378`，ui-workspace README）。
   - 不学的理由：DeskMinis 的会话沙箱默认更适合办公用户。只借 chip 的位置，见 4.3。
2. **开发者面**
   - 包括：git 改动卡、左右对比的 review tab（Shiki 高亮，5000 行上限）、Trajectory 视图、侧栏终端、dockkit 分栏与浮窗、可执行脚本的 HTML 交互预览。
   - 不学的理由：DSH 自己也把这些收在「开发者工具」开关后面；O1（砍终端）和 O5（右栏两 tab）也与之同向。
3. **账号、平台、强更、内测声明**
   - 包括：DeepSeek 账号 PKCE 登录、内嵌用量与充值页、强制更新策略（测试版需飞书登录）、版本化「内测声明」弹窗、独立欢迎窗。
   - 不学的理由：BYOK、数据不出本机、用户掌控更新；独立窗口会多一套 IPC 与竞态。
4. **外发与重依赖**
   - 包括：赞踩反馈连同会话日志一起投递（ui-message-feedback README 第 28 行）；语音输入用 sherpa-onnx 并下载 SenseVoice 模型；Excel 与 Office 预览依赖 FortuneSheet、ExcelJS、SheetJS、LibreOffice。
   - 不学的理由：违反「不外发」和「零新依赖」。语音用 Windows 的 Win+H 即可覆盖。
5. **全套国际化**
   - 包括：类型化中英词典、语言切换、壳与渲染端双份词典同步。
   - 不学的理由：路线已定不做。
6. **次要项**
   - 网页链接默认在应用内侧栏浏览器打开：DeskMinis 继续用系统浏览器。
   - 计划模式做成软约束：路线已定要么做硬约束，要么不做。
   - Windows 顶栏「应用 / 编辑」菜单条：托盘和设置已覆盖其功能。

---

## 16. 与已拍板路线的冲突或需调整之处

1. **首启服务商预设与 Key 引导没有排进任何子波。** 建议在 W4c 增加 UI 子项，与 `detectCompat(baseUrl)` 共用一张厂商表；也可以随 W4a 的 0.3.1 先出轻量版。见 1.1、1.2。
2. **W5b「删任务面板」会丢两样东西**：上轮结束原因（maxTokens、refusal）和 70%/90% 水位提示。建议在同一个提交里迁进对话流 EventNote 和占用环面板，并用 SSR 渲染测试钉住。见 12.1。
3. **W7b 通知的依据需要更正。** DSH 只对「更新就绪」做注意力提示，审批没有通知也没有超时。机制照搬没有问题，但必要性来自 DeskMinis 自己的 90 秒超时。另建议把「关窗隐藏到托盘时首次告知」补进 W7b。见 10.1、10.2。
4. **W8b 改动卡的呈现主次需在设计稿里定。** 按 DSH 的分层，cowork 默认先交付卡，再「撤销本回合」，差分收进展开区或办公呈现档。范围不变。见 6.2。
5. **欢迎页开场示例是编码向**（`StageWelcome.vue:39-43`）。建议 W4a 的内容包顺带换掉，S 级。见 12.2。
6. **补一个路线漏项：编辑右键菜单。** 建议放 W9b 或随「界面减法」一起做。见 8.1。

其余建议都能直接落进已排的子波，没有与 O1–O7、F1 冲突的地方。

---

## 17. 未覆盖或未核实

- 没有运行 DSH，欢迎窗与首启的实际视觉只按源码和 README 描述。
- DSH 的 Lexical 编辑器细节（chip 节点、剪贴板投影）、dockkit 内部实现、插件管理器页只看了 README。
- DeskMinis 的 CSV 预览走不走表格，是按 PreviewPane 分支推断的；shell 生成的文件不进「改动」清单，也是按 collect.ts 推断的。都没有实测。
- DeskMinis 空会话的判据（能否用 `updatedAt === createdAt` 推断 blank）未核实，W8a 实施前需确认 `chat.sessions.create` 与首条消息各自写哪些时间戳。
