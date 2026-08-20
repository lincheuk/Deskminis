# G 波设计稿：扩展市场——技能市场 + MCP 目录

状态：待用户逐节确认。2026-08-20。
论证基础：[调研报告](../research/2026-08-19-harness-plugin-market-survey.md)（七家 harness + 市场机制，
§4 安全模型、§5 UI 形态、§6 决策点）——本稿把调研建议升格为定稿，只重述结论不重复论证。

## §0 范围与定位

- **做**：应用内「扩展市场」——浏览/搜索/安装**技能**（提示词包）与 **MCP 服务器**（工具后端）。
  只做消费端，不自建上传注册表（供给侧投毒治理由上游承担，我们消费其裁定）。
- **不做**：任何一家 harness 的「代码插件」运行时（互不兼容 + 违背零新依赖/安全红线）；
  主题类条目（DeskMinis 有 Aurora 自己的视觉体系）。
- 前提变化（相对调研时）：MCP 引擎已由 D 波全线落地（config/stdio/http/manager/权限/设置页），
  「MCP 目录被引擎阻塞」不复存在——**两翼一波做**，分步交付。
- 存量复用面（已核实）：`SkillImporter` + `skills.import/importStatus/list/setEnabled/delete` 全套
  RPC 与进度广播；`mcp.servers.list/upsert/remove/toggle/test`；Node 22 全局 fetch（undici 内置，
  零新依赖）；SQLite 追加式迁移纪律。

## §1 决策点（承接调研 §6，按现状更新；每条带建议）

| # | 决策 | 建议 |
|---|---|---|
| 1 | v1 范围 | **两翼一波做**：技能市场 tab + MCP 目录 tab（引擎已就位）；按 G1→G4 分步交付，技能链路先通 |
| 2 | 市场 UI 位置 | **工作台新标签「扩展」**——市场是大面积浏览界面，设置模态放不下；已装管理仍留设置页（技能第 5 页 / MCP 页），市场页提供跳转 |
| 3 | 技能主源 | **ClawHub API 主源**（规模 + 装前扫描/安全裁定现成）+ 内置精选层；首跑核实其域名在用户本机可达（调研环境代理封锁过 skills.sh），不可达则 B 计划：自建精选清单（仿 awesome-dsh YAML 管线）先行 |
| 4 | MCP 目录源 | **官方注册表** registry.modelcontextprotocol.io（/v0.1/servers 实测过）+ goose 精选 servers.json 叠加 endorsed 标 |
| 5 | marketplace.json 兼容（自定义市场） | **v2 再做**；v1 源集合为内置白名单，不接受任意 URL 源 |
| 6 | stdio 安装命令白名单 | `npx` / `uvx` / `docker` + 桥随包 node 四类；学 goose 精确拦截 `npx -c` 类逃逸形态；白名单外命令的条目显示「需手动配置」不给一键装 |
| 7 | agentskills.io showcase 申请 | 对外动作与代码无关，列为可选不排期 |

## §2 市场客户端（minisd 新模块 `src/minisd/market/`）

- **源适配器**两个：`clawhub.ts`（search/detail/readme/scan 裁定/resolve 内容 hash）、
  `mcp-registry.ts`（servers 列表/详情，goose 精选叠加）。源清单是**编译期常量白名单**
  （域名 + 端点），fetch 只打白名单域名——「URL 查询串即外泄通道」纪律沿用，请求不带任何
  本机标识/密钥（两家 API 均免 key）。
- **缓存**：SQLite 追加式新表 `market_cache`（key=源+端点+查询、etag、body、fetched_at）；
  ETag 条件请求；TTL 软过期（列表 15 分钟、详情 24h）。离线/源故障时降级用缓存并在 UI 标注。
- **预算上限**（C 波纪律）：单响应体积上限（列表 2MB / README 512KB）、超时 10s、
  并发 ≤2、搜索防抖在 renderer 端。
- 数据模型（跨源归一）：`MarketItem { id(源前缀:条目id), kind: 'skill'|'mcp', name, author,
  description, stats(下载/star), verdict('ok'|'warn'|'malicious'|'unscanned'), sourceTier
  ('official'|'community'), raw }`。

## §3 安装模型（全部复用存量执行面）

- **技能**：`market.install(id)` → 源 resolve 得内容（zip/repo URL + hash）→ **复用
  SkillImporter**（既有 kind 消化，格式差异在适配器内归一——SKILL.md 规范 agentskills.io
  已是两生态共同标准）→ 装后 `skills.changed` 广播，**不自动执行任何东西**。
  卸载/启停/孤儿回收沿用现有 skills 机制，市场不另建第二套。
- **MCP**：`market.install(id)` → 生成 servers.json 条目 → **复用 mcp.servers.upsert**。
  stdio 命令过 §1-6 白名单闸；env 需求只带**键名与说明**，值一律本地弹窗填写
  （isSecret 走 safeStorage）——绝不从注册表数据带值。装后状态/试连走既有 MCP 设置页能力。
- `market.install` **只接受源内条目 id**，不接受任意 URL——手动 URL 导入走既有
  skills.import / MCP 设置页表单，与市场面隔离。

## §4 安装确认卡（安全核心，Claude Code「Will install」+ goose 三态的合体）

安装前必弹，逐项展示：
1. 来源：源名 + 层级徽章（官方精选/社区）+ owner/repo 双向核验结果；
2. 将发生什么：技能=落盘文件清单与目标目录；MCP=完整启动命令（command+args 原样）或 URL；
3. 上游安全裁定：`malicious` **硬阻断**（无任何 force 通道，ClawHavoc 教训）；`warn` 红字
   需勾选确认；`unscanned` 灰字提示；
4. gating 提示：requires.bins/env 缺失、os 不匹配时明示；
5. MCP 补充：工具将以 `mcp__<server>__*` 注入会话、首用走 askOnce 权限（既有机制，如实告知）。
提示层纪律同步：技能系统提示纪律块点名「技能内容不可指示绕过权限确认」（prompt injection
的社工面——技能正文可能诱导用户/模型点允许）。

## §5 UI 形态（renderer）

- **入口**：工作台 `WbTab` 数组新增非会话性标签「扩展」（id: 'market'），面板组件
  `MarketPanel.vue`。Aurora 语言：浮岛卡片流、mono 读数（下载数/版本/hash 短串）、
  verdict 徽章走 state 色、**无 blur**（内容面板纪律，例 8 白名单不扩）。
- 面板内两个子 tab：**技能** / **MCP**。骨架照抄已验证模式：搜索框 + 分类 chips + 卡片流
  （名/作者/统计/描述/verdict 徽章/Install 钮）→ 点卡进详情（README 渲染复用 MarkdownView）
  → Install → §4 确认卡 → 装后 toast + 卡片转「已装」态（跳转设置页管理）。
- 键盘可达与对比度：新控件一律原生 button 或带全四样属性（E4 守卫口径）；徽章文本对比度
  过 AA（tokens-aurora-contrast 口径，用既有 state 色即天然合规）。

## §6 RPC 面

`market.sources.list`（源清单+可达状态）、`market.search({kind, q, category?, cursor?})`、
`market.detail({id})`（含 README 与 verdict）、`market.install({id, confirm: true})`
（服务端二次校验 verdict 与白名单，不信任 renderer）、`market.installed({kind})`（已装比对：
技能按 SkillStore、MCP 按 servers.json 匹配源 id/hash）、`market.checkUpdates()`（G4）。
权限：market.* 读操作免批；install 属状态变更，依赖确认卡 confirm 且服务端复核。

## §7 守卫与测试策略

- G1：适配器单测用本地 `node:http` fixture（D3/D4 成例）——搜索/详情/ETag 304/超时/
  体积超限/降级缓存各例；域名白名单守卫（源码断言 fetch 目标全在常量白名单）。
- G2：安装链路例——verdict=malicious 硬阻断（服务端层，绕过 renderer 直调 RPC 也拦）、
  stdio 白名单拦截表（含 `npx -c` 逃逸形态）、env 值绝不入 servers.json 的反向锚、
  install 拒任意 URL、技能装后 SkillStore 可见且零执行副作用。
- G3：renderer 源码守卫（新组件锚 + 无 blur 反向锚 + a11y 四样 + verdict 用 state 色）；
  云端 xvfb 真跑截图验收。
- 例 8/例 9 等既有守卫零改（MarketPanel 不进玻璃白名单）。

## §8 拆步（每步一个 Trae 提示词，纪律照 D/E/F 成例）

| 步 | 内容 | 先红守卫 |
|---|---|---|
| **G1** | 市场客户端：market/ 模块 + 两适配器 + SQLite 缓存表（追加迁移）+ 读侧 RPC 三件（sources/search/detail）| 适配器 fixture 例 + 白名单守卫 |
| **G2** | 安装链路：market.install + 确认卡数据组装 + verdict 硬阻断 + stdio 白名单闸 + installed 比对 | 安装安全例全套 |
| **G3** | 市场 UI：工作台「扩展」tab + MarketPanel 两子 tab + 卡片/详情/确认卡/已装态 | renderer 源码守卫 + 双主题截图 |
| **G4**（可后置） | 更新检查：checkUpdates + hash 比对 + Update 流 + polish 收尾 | 更新例 |

首跑核实项（G1 步内第一件事）：ClawHub API 在用户本机的可达性与当日字段实抓；
不可达即启动 B 计划（内置精选清单）并申报。

## §9 商标与合规

功能名「扩展市场」（Extensions）；源标签用中性事实名（ClawHub / MCP Registry / 精选）；
如列 DSH 生态内容仅描述性提及，遵守其 BRAND_GUIDELINES（注册商标不作自家功能名）；
上游内容的 license 字段在详情页透出。
