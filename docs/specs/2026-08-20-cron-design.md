# K 波设计稿：定时任务——interval/once/cron 三态调度，触发即建会话跑回合

状态：**定稿即施工**（自己做模式；用户 2026-08-20「做建议立项和候选池」授权）。
立项依据：AionUi 调研 §4——24/7 自动化是 cowork 叙事的另一半；其 `ICronSchedule`
三态模型（interval/once/cron）值得直接抄，调度器自研（aioncore 闭源不可借）。
前置调研结论（headless 可行性，六路调研之五）：minisd 是随 app 生命周期的独立
utilityProcess、内有 setInterval 成例（McpManager 60s 巡检 unref()）、chat.prompt
可内部复用、消息落库不依赖 renderer 在线。

## §0 决策点记录（审核方裁定，事后可否决）

| 决策点 | 裁定 | 依据 |
|---|---|---|
| 运行边界 | **应用运行时生效**——DeskMinis 不驻留后台服务，应用没开就不跑。面板文案明示，不假装 24/7 | minisd 随 app 启停（main/index.ts:33-42, 230）；诚实优先 |
| 错过策略 | interval/cron 错过（app 没开）**跳过重算下一次**，不补跑——避免开机风暴；**once 错过补跑一次**（一次性任务的意义就是「务必跑一次」），跑后自动停用 | 各态语义各取所需 |
| 权限策略 | **不动全局权限档**。无人值守时权限卡 90s 超时自动拒绝、agent 以「被拒」继续收尾（permissions.ts:331-338 + loop 喂回机制，调研证实）；面板文案明示「要全自动请在设置切完全访问（全局生效，慎用）」 | 定时任务不该静默扩权 |
| 内部调用方式 | 持有**裸 methods 引用**（guardBusinessMethod 包装前）直调 chat.prompt 处理器——处理器本身不读 conn（调研证实），零重构 | 最小侵入 |
| 完成感知 | chat.prompt 的 IIFE finally 处加 **runDoneHooks**（Map<sessionId, (err?)=>void>，一次性钩子 ~4 行）——调度器借此写 last_status='ok'/'error:…'；顺带治理调研发现的「loop 抛错仅广播不落库、无人值守失败无痕」缺口 | 闭包内同域，零新通道 |
| 并发防重 | 同一任务上次会话仍在 inFlight → 本次**跳过**并记 last_status='skipped-running'，重算下一次（inFlight 与调度器同闭包直读） | 不排队不叠跑 |
| 会话形态 | 每次触发**新建会话**：source='cron'（迁移[0] 预留列首次启用）、标题「⏰ 任务名 MM-DD HH:mm」、可绑助手（J 波 applyAssistantPreset 复用——模型/规则/技能三件随助手）、可指定 workspace | 会话列表可见可回溯，J/K 拼积木 |
| 表 | 迁移[10] cron_jobs（user_version 10→11），四版本钉随动申报 | 追加式纪律 |

## §1 数据模型（迁移[10]）

```sql
CREATE TABLE cron_jobs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  prompt TEXT NOT NULL,
  schedule_kind TEXT NOT NULL,
  schedule_value TEXT NOT NULL,
  assistant_id TEXT,
  workspace_root TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  next_run_at REAL,
  last_run_at REAL,
  last_session_id TEXT,
  last_status TEXT NOT NULL DEFAULT '',
  created_at REAL NOT NULL,
  updated_at REAL NOT NULL
);
```

- schedule_kind/value：'interval'=分钟数（≥5，防自我 DDoS）/'once'=epoch 秒/'cron'=5 段表达式。
- CronStore（src/minisd/cron/store.ts）：list/get/create/update/remove/markRun/markDone；
  入参截断（name 50 / prompt 4000）；create/update 时即算 next_run_at（非法表达式抛错，
  不入库坏行）。

## §2 调度纯核心（src/minisd/cron/schedule.ts，零依赖）

`computeNextRun(kind, value, fromMs): number | null`（null = 不再有下一次）：
- interval：fromMs + n 分钟；once：value 秒 > fromMs 则 value，否则 null（错过的 once
  由启动补跑逻辑单独处理，不靠 next 计算）；
- cron 5 段（分 时 日 月 周）：每字段支持 `*`、`*/n`、`a`、`a-b`、`a,b,c`（逗号项可含
  区间与步进）；周 0-7（0 与 7 都是周日）；**日/周同时受限时任一命中即触发**（Vixie cron
  经典 OR 语义，注释写明）；从 fromMs 下一整分逐分钟扫描，上限 366 天扫不到返回 null。
  逐分钟扫是 O(527k) 上界的蠢办法——但只在任务保存与跑完后各算一次，蠢而正确 > 巧而错。
- 12+ 例单测：五字段各形态/OR 语义/跨月跨年/非法表达式抛错/上限 null。

## §3 调度器（index.ts startMinisd 闭包内）

- `setInterval(tick, 30_000).unref()`（McpManager 成例）+ 启动即 tick 一次（once 补跑门）。
- tick（同步防重入标志）：取 enabled=1 且 next_run_at<=now 的任务 →
  ① 上次会话仍在 inFlight → skipped-running，重算 next；
  ② 否则：createSession(source='cron', 标题⏰) → 有 assistant_id 走 J 波 applyAssistantPreset
  （查无则忽略助手照常跑）→ 有 workspace_root 写会话工作区（目录不存在则忽略并记入
  last_status 前缀）→ markRun（last_run_at/last_session_id/last_status='running'/重算 next；
  once 置 enabled=0, next=null）→ 注册 runDoneHook → 裸 methods['chat.prompt']({sessionId,
  text: prompt}) → catch 同步抛错记 last_status='error:…'。
  每次状态变化广播 'cron.changed'。
- 提供 `cron.runNow {id}` 走同一执行函数（绕过 next_run_at）。

## §4 RPC 面

cron.list / cron.create { name, prompt, scheduleKind, scheduleValue, assistantId?,
workspaceRoot? } / cron.update { id, …+enabled? } / cron.delete { id, confirm? } /
cron.runNow { id }。全部广播 cron.changed。

## §5 UI（工作台「定时」tab）

- App.vue BUILTIN_TABS 增 { id:'cron', label:'定时', icon:'clock', short:'定时' }（全局
  tab，market 成例：懒挂载不进不请求）；四内置面板 v-show 绑定红线不碰（新增一行同构绑定）。
- CronPanel.vue：任务列表（名称/人话调度描述/下次运行/上次状态 + 最近会话跳转
  （switchRightTab 成例反向：chat.open + 关面板？——直接 chat.open，会话列表已可见）/
  启停 toggle/立即运行/删除二次确认）+ 新建/编辑表单（名称/指令 textarea/三态 select +
  对应输入（分钟数/日期时间 datetime-local/cron 表达式 + 帮助文案）/助手 select（复用
  chat.assistants）/工作区路径可选）。
- 人话调度描述纯函数 lib/cron/describe.ts（「每 30 分钟」「每天 09:00」「8-20 时每小时」
  ——描述不了的直接show原表达式，不硬编人话）。
- 权限与运行边界文案常驻面板头（§0 两条裁定的用户可见面）。
- store：chat.cronJobs + refresh + 订阅 cron.changed。

## §6 守卫与测试

- 纯测：cron-schedule.test.ts（§2 12+ 例）、cron-describe.test.ts、cron-store.test.ts
  （迁移例 + CRUD + 截断 + 非法表达式拒收）。
- 集成：调度 tick 触发建会话（FakeProvider）+ once 自动停用 + skipped-running。
- 源码守卫：renderer-cron.test.ts（tab 注册/面板接线/权限文案在/a11y 成例）。
- 版本钉随动申报：四文件 toBe(10)→11 + DROP cron_jobs 各回退段。

## §7 拆步

| 步 | 内容 | 先红 |
|---|---|---|
| **K1** | 迁移[10] + schedule/describe 纯核心 + CronStore + 调度器 + runDoneHooks 接缝 + RPC 五件 + 版本钉随动 | cron-schedule / cron-store / 版本钉改锚 |
| **K2** | 前端：store 面 + 工作台 tab + CronPanel + 人话描述 | renderer-cron |
| **K3** | xvfb 目视（面板/建任务/触发实跑 FakeProvider）+ 全量对基线 + 记账 | —（终验步） |
