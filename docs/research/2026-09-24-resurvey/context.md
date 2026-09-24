# 决策背景（第二轮评审共用输入）

## 要回答的问题

用户原话（2026-09-24）：「我們之前的參考項目有了較大程度的修改，我想要你先把我們之前的參考項目重新閱讀一下，
再進行重新革新優化還是繼續怎麼樣」，并补充参考项目包括 OpenMinis、AionUi、deepseek harness、ZCode、pi。

要给出的是方向建议：
- A「继续增量」：维持现有架构与路线，按交接文档 §6 待办继续补功能，吸收参考项目的点状改进；
- B「定向革新」：保留 minisd + Electron + Vue 的骨架，但对某几个子系统（例如 agent 循环 / 会话协议 / 渲染层）做成批重写，
  并按参考项目新趋势重排路线；
- C「重构」：推倒某一层或整体重来（例如换引擎架构、换 UI 框架、改成嵌入外部 agent 运行时）；
- 或组合 / 其它。
评审要拿证据说话，并给出分波路线。

## DeskMinis 当前事实

- Windows 桌面通用 Agent 应用：Electron + TypeScript + Vue3 + Pinia + better-sqlite3。
  自研 agent 引擎 minisd 跑在 Electron utilityProcess 里，与渲染层经 WebSocket JSON-RPC（per-run token）通信。
  仓库 github.com/lincheuk/Deskminis，应用代码在 deskminis/ 子目录；本地 /home/user/Deskminis/deskminis。
- 版本 0.3.0，**从未正式发布过**：GitHub Releases 只有 v0.1.1；v0.2.0 做了发布就绪但没上架；0.3.0 需要 Windows 真机走发布检查单。
- 170 测试文件 / 1914 例；云端 Linux 上有 52 例 Windows-only 基线失败。
- 波史：A–H 引擎与工具；I 波按 AionUi 换色板失败；J 助手体系（cowork 地基）；K 定时任务；L 系列；M 同步 / 模型组后端；
  R v0.2.0 发布就绪；S 调字体失败；T 波 UI 推倒重建（新组件树 src/renderer/src/ui/）；T6 删旧树；U Office 能力（零依赖自建 OOXML）；
  V/W 修补；X 首发竞态结案；Y 换壳遗失入口补回；Z 模型组降级界面。
- 交接文档 §6 待办（原样摘要）：
  - 一档：0.3.0 上架（需 Windows 真机）；欢迎页选助手的既有撒谎；ModelBar 与胶囊并排显得矛盾。
  - 二档：办公技能包；vue-tsc 立项评估。
  - 三档（需先出设计稿）：会话正文全文搜索、用量与成本面板、genui 内联交互组件、多窗口对话墙、图片生成、内置浏览器。
  - 其它未做：预览区 Snapshot/History/Open in system app/Download/代码语法高亮、Ctrl+K 命令面板、非图像附件、模型选择器搜索、
    消息内路径可点击、已完成回合自动折叠、规划模式、会话分叉、技能覆盖三层判定、会话级权限覆盖、MCP 的 OAuth/resources/prompts 等。

## 本轮顺带核实的 DeskMinis 真缺陷（主会话已亲自读代码确认）

1. src/minisd/tools/files.ts 的 file_edit 用 `content.replace(oldStr, newStr)` 写盘，String.replace 会解释 `$$`、`$&`、`$'` 等替换序列：
   new_string 里的 `"$$5"` 落盘变成 `"$5"`。静默改坏用户文件。
2. src/minisd/agent/loop.ts:550 对同一批工具调用一律 runWithConcurrency(calls, 10)，不看副作用。
   【复核修正】不会丢更新：file_edit 在权限 await 之后的读-改-写是同步的，shell 自带串行队列。
   真实问题只是「同批调用的先后次序无保证」：例如同批的 file_write 与依赖它的 shell 命令可能先后颠倒，权限卡也会同时弹出多张。严重度低于初判。
3. src/minisd/skills/importer.ts 的 unzipToMemory 没有条目数、解压总量、单文件大小上限（office/zip.ts 反而有这三道闸）：zip 炸弹可吃光内存。
4. 渲染层 rpc.ts 没有 onclose 处理：连接断开时挂起的调用永远不结束；minisd 崩溃后无人接管，也没有重连。
5. 压缩静默失效：agent/compact.ts 的 summarize 把「摘要提示词 + 从 history[0] 到锚点的完整 raw history」发给模型，
   不并入已有 marker；锚点通常是 assistant 消息，请求以 assistant 结尾（新一代 Claude 视为 prefill 会 400）；
   maxTokens 只有 1024；loop.ts 的 catch {} 把失败吞掉继续跑。第一次压缩之后，摘要请求本身可能比触发压缩的有效历史更大。
6. mcp/config.ts：servers.json 解析失败只记 loadError，之后任意一次 save() 会用内存里的空列表覆盖用户原文件。
7. store/db.ts 迁移 runner 只处理 user_version < MIGRATIONS.length，旧版应用打开新版库时不拦截（降级打开无守卫）。
8. tools/shell.ts 超时/取消用 proc.kill('SIGKILL')，Windows 上只杀 PowerShell 本身，不杀进程树（mcp/stdio.ts 反而用了 taskkill /T /F）。
9. 渲染层从不传 thinkingLevel，原生思考恒为 off；anthropic.ts 一旦开思考只会发 budget_tokens（新一代 Claude 会 400）；
   OpenAI 兼容路径不回传 reasoning_content，也不对默认开思考的模型（DeepSeek V4 等）显式关闭。
10. 桥（命名管道）不认证对端，sessionId 取自请求本身；同用户进程本就有同等权限，风险偏低，但可冒用某会话的权限档。

## 用户历来的方向表态（原话）

- 2026-08-20：「我喜欢这个项目（AionUi）的 UI，按照这个重做 UI，把目前有的功能完美的把 UI 和功能集成；还有我更希望我的项目不止可以 coding，
  也可以像 cowork 一样，请搜集里面的功能，看看有哪些可以复用在本项目里。」
- 2026-08-21：「抛弃原本的 ui 设计，你一直在基于原本有的做改造，我的目的是你重新做一个，而不是你在原有基础搞出四不像」。
  （此后 T 波推倒重建了 UI，新树已是唯一 UI。）
- 生态盘点时点名过的远期候选：多窗口对话墙、genui 内联交互组件、用量面板、图片生成、内置浏览器。
- /goal：「把他做成一个可以发布的版本」。
- 协作风格：中文、决策快、放权但要求申报与可否决；「自己做模式」——Claude 设计 + 实现 + 直推 main。

## 硬约束

- **零新 npm 依赖**：dependencies/devDependencies 一行不动（U 波 Office 能力就是在这条约束下自建的）。任何建议若需要新依赖，必须显式标出并单列为「需用户破例」。
- **许可证**：OpenMinis 是 GPLv3，只能借鉴思路，不能衍生代码；AionUi 与 ZCode 是 Apache-2.0，DSH 与 pi 是 MIT，可借鉴代码但须保留署名与许可证声明。
- DB 只追加式迁移；TDD 先红；UI 改动必须 xvfb 目视；只在 Windows 真机发布验证（云端无法做 Windows 打包验收）。
- 执行者是单个 AI 会话按波推进，每波通常 1–3 天工作量量级；大重写的风险是「换壳遗失入口」这类回归（T 波教训：
  1890 例全绿 + typecheck 0 + 所有实拍都没拦住权限卡从没渲染过）。

## 历史教训（交接文档 §7 摘要）

1. 换壳是搬家，不是在新房子里重写主要房间；搬家清单必须从旧实现逐项核对。
2. 内部标识符漏给用户看。
3. 界面撒谎比界面难看严重。
4. 「全绿 ≠ 界面正常」已五次兑现，UI 改动必 xvfb 目视。
5. 守卫是资产；6. 有守卫 ≠ 有覆盖。
7. I 波、I6、S 波三次把「重做」当「改造」执行，被用户批评为四不像。「最小改动面」是维护期纪律，用在重做需求上就是错的。

## 第一轮之后主会话追加核实的缺陷（DSH 核验者报告，已亲自读代码确认）

11. 上下文溢出被当成「请求被拒」：providers/types.ts 把 400/422/429 一律标 fallbackable，溢出报错（通常是 400）会立即降级换模型、
    成功后会话还改绑过去；整组失败时报「所有模型均不可用」，与真实原因不符（界面撒谎）。没有「溢出 → 强制压缩 → 重试一次」。
12. 卸载桩自相矛盾：agent/offload.ts 的桩让模型「用 file_read 读取 /var/minis/offloads/<id>.txt」，但 file_read 不支持 offset/limit，
    读回的全文 >20000 字符又会被卸载成桩——模型永远取不回原文（只能碰巧改用 shell 分页）。
13. 系统提示每一步重建（index.ts promptFactory）：记忆块含当日日志，而 memory_write 正是往当日日志追加；技能块带当前时间参数；
    助手规则实时读表。回合内任一变化都会让 system 字节变化，Anthropic 的 cache_control 断点打在 system 上，整条前缀缓存失效。
14. 主进程没有 requestSingleInstanceLock：可同时开多个实例，两个 minisd 共用同一数据根与 SQLite 库。
15. 主进程没有 setWindowOpenHandler / will-navigate 守卫；模型输出的 Markdown 链接是 target=_blank，点击会新开一个 Electron 窗口加载外部网页。
    【主会话实验】Electron 38 下子窗口不继承 preload，外部页面拿不到 minisd 令牌；风险是「外部网页开在无地址栏的应用窗口里」（钓鱼），修法是交给系统浏览器。
16. chat.sessions.delete 只 dispose 终端，不 abort 该会话正在跑的 run：任务会在会话删除后继续执行工具。
