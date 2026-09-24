# 同步、发布工程与对外文档（W2b-synchello / W2b-update / W2b-verifyrelease / W2b-depsfrozen / W2b-license / W2b-readme）

## facts
- 【sync.hello 应答端】src/minisd/sync/rpc.ts:77-85：签名 p:{nonce:string}，要求 authMode=remote + peerFingerprint + pairingService，找不到 key 抛「未配对设备」(:82)；MAC 输入是 'm3c-hello'+p.nonce (:83)；只回 {mac(hex), listenPort} (:84)。没有任何版本或能力字段
- 【sync.hello 发起端】src/minisd/sync/outbound-client.ts:211-239 doHello：:214 只发 {nonce}，把响应强转成 {mac, listenPort}；:216 本地算同一个 'm3c-hello'+nonce 的 HMAC；:219-224 用常量时间比较；:226-234 用 listenPort 刷新地址簿。PeerConnection 结构在 :39-54（没有对端信息字段），:125-136 每次 dial 新建 conn；:29 RPC 超时 10s
- 【传输层】src/minisd/rpc/server.ts:7 RpcConnection 只有 notify/authMode/peerFingerprint/remoteAddress；:87 每个 ws 建一个 conn 字面量（生命周期=连接）；:111 handler(msg.params ?? {}, conn) 整包透传 params，不校验多余字段
- 【wire.ts】src/minisd/sync/wire.ts 只有 Message/Marker/Session/SessionFile 的线格式，没有 hello 类型；WireSession 只带 memoryEnabled 开关 (:44,:156)，不带记忆文件
- 【v0.1.1 兼容基线】git diff 6c48c8b HEAD -- src/minisd/sync src/minisd/rpc/server.ts 为空：v0.1.1 的 hello 与 HEAD 完全一样（请求 {nonce}，响应 {mac, listenPort}）。0.1.1 的 handler 忽略多余参数字段，0.1.1 的客户端只读 mac/listenPort，所以追加字段两个方向都能互通；只有改 MAC 输入会断
- 【现有 hello 测试】tests/outbound-client.test.ts:88-110 bootServer 支持 customHello 覆盖；:188-189 与 :450-452 的 customHello 回的正是旧形状 {mac, listenPort}；tests/sync-rpc.test.ts:115-118 钉住 sync.* 六个方法名；presence.test.ts:115/:236、auto-sync.test.ts:125 做集成。已实跑 outbound-client、sync-rpc、auto-update、m5-packaging 四个文件，Linux 下 38/38 全绿
- 【LAN 可达】src/minisd/index.ts:1221-1224 缺省只监听 127.0.0.1，必须设环境变量 MINISD_HOST 才开放局域网；src/main/index.ts:35 fork 时不注入它；docs/plans/2026-08-01-m3c-handoff.md:467、:1377 自己也写明生产环境要用户手动设 MINISD_HOST。StageDevices.vue:132 让对端填「这台机器的 host:port」，但界面不显示本机端口。代码里没有 mDNS（grep mdns/bonjour/multicast 零命中），配对靠手填 host:port（StageDevices.vue:56-70，remote/index.ts:110-123）
- 【更新源现状】electron-builder.yml:51-62：publish 为 github lincheuk/Deskminis，注释 :54-58 承认私仓会 404。6c48c8b（v0.1.1）的 electron-builder.yml:56 起是同样的配置，package.json 里也有 electron-updater，所以已装的 0.1.1 写死的 feed 就是私仓，永远查不到更新
- 【electron-updater 版本与 provider】node_modules/electron-updater 6.8.9，electron-builder/app-builder-lib 26.15.3。GitHubProvider.js:43 取 github.com/<owner>/<repo>/releases.atom；:160-163 对 github.com 走 /releases/latest 的网页 JSON，不走 API，不受限流；:16 关闭多段 Range；:124-125 找不到 latest.yml 时报 ERR_UPDATER_CHANNEL_FILE_NOT_FOUND。GenericProvider.js:18-24 取 <url>/latest.yml 并加 noCache 查询（util.js:18-27），404 时报同一个错误码。Provider.js:22-25 旧版 blockmap 的 URL 由新 URL 替换版本号得到，所以差分下载要求旧版 blockmap 还留在原路径
- 【产物与 latest.yml 形状】electron-builder.yml:34 顶层 artifactName 被 :47 nsis（DeskMinis-${version}-Setup.${ext}）和 :49 portable（DeskMinis-${version}-win-x64-portable.${ext}）覆盖。只有 nsis 生成更新清单（app-builder-lib PublishManager.js:391-396），便携版不进 latest.yml。updateInfoBuilder.js:133-152：latest.yml 的内容是 version、files[0]={url,sha512,size}、顶层 path/sha512、releaseDate，序列化用 js-yaml，lineWidth 8000（builder-util util.js:94-99）。blockmap 文件名是 <安装包>.blockmap（differentialUpdateInfoBuilder.js:66-67），gzip JSON，version '2'（blockmap.js:128-151）。sha512 是 base64（app-builder-lib util/hash.js:6）。NsisTarget.js:66-67 非便携形态才做差分
- 【app-update.yml】PublishManager.js:86-89 afterPack 时把 publish 配置写进 win-unpacked/resources/app-update.yml；nsis 与 portable 共用这个 appOutDir，所以便携版里也带着更新源
- 【便携版】app-builder-lib templates/nsis/portable.nsi:77 会设置 PORTABLE_EXECUTABLE_DIR，但 src 和 electron-updater 都没有任何 PORTABLE 判断（grep 零命中）。推断：便携版会下载 NSIS 安装包，quitAndInstall 后装出一份安装版，需真机确认。docs/RELEASE.md:68 写「便携版不参与自动更新」，代码里并没有落实
- 【错误态显示】src/main/index.ts:148 把 'error' 存为原始 String(e.message)，:162 的 catch 用 String(e)。builder-util-runtime httpExecutor.js:52-56 的 HttpError 文本含「Headers: {json}」，electron-updater 的 newError 还会拼进 e.stack。SecAbout.vue:85 原样显示，于是设置→关于的状态行会出现英文堆栈加响应头。SecAbout.vue:87 写着「仓库还是私有的话，检查会返回 404——这是预期的」，:76 写「启动时到 GitHub Release 看一眼」
- 【托盘】src/main/index.ts:79「检查更新…」手动检查后没有任何可见反馈，结果只写进 updateState。托盘「打开设置」「切换右栏」(:77-78) 在 preload/index.ts:17-27 暴露了订阅接口，但 src/renderer/src 里零调用（死通道）
- 【更新守卫】tests/auto-update.test.ts:35-40 钉住 provider github、owner、repo；:58-61 钉住 error 监听存在；tests/renderer-stage-views.test.ts:71-78 要求 main 里出现的每个 updateState status 值在 SecAbout 都有中文文案；tests/ipc-contract.test.ts:13-34 在 mock electron/electron-updater 后 import main/index.ts
- 【安装包体积】仓库里没有 Setup.exe 实测体积的记录（docs/plans/2026-08-08-m5-packaging.md:178 只说「交付报告暴露实测体积」）。本机 node_modules/electron/dist（Linux 版）解包后 285MB；推测 Electron 38 的 NSIS 安装包约 80–110MB，与 git 单文件 100MB 硬上限（>50MB 警告）、Pages 站点 1GB 都贴边。GitHub Release 单个资产上限 2GiB
- 【现有发布脚本】scripts/e2e-m5-packaging.mjs 只支持 Windows（:44），用 PASS/FAIL 行加汇总，缺产物退出码 2、断言失败退出码 1（:27、:59、:76）；版本读 package.json（:35-37）。测试里跑 .mjs 的先例是 tests/bridge-cli.test.ts:13/:25 spawn(process.execPath, [脚本])。tsconfig.json 的 include 含 tests/** 且没开 allowJs，静态 import .mjs 会让 typecheck 报缺声明
- 【依赖】package.json:31-43 有 11 个 dependencies，:44-59 有 14 个 devDependencies；package-lock.json 为 lockfileVersion 3，packages[""] 的依赖与 package.json 完全一致（已用 node 比对），但锁根元数据过期：:3、:9 version 仍是 0.1.1，:11 license 为 ISC。没有依赖冻结守卫：tests/ 里没有任何 package-lock 引用，只有 auto-update.test.ts:30-33（electron-updater 在 dependencies）和 build-config.test.ts:74-77（@electron/rebuild 在 devDependencies）两条单点检查
- 【许可】deskminis/package.json:29 写 "license": "ISC"（:28 author 为空），仓库根 LICENSE 是 Apache-2.0（201 行）。electron-builder.yml:11-23 的 files/extraResources 不含 LICENSE 与 THIRD-PARTY-NOTICES.md，所以安装包里既没有本项目许可，也没有第三方署名（包括 Noto 字体 OFL 要求随附的声明）
- 【NOTICES 已过期】THIRD-PARTY-NOTICES.md:7-15 称 tokens.css 的 A 区是 Appica 取值逐字照抄，但 src/renderer/src/styles/tokens.css:5-9、:20 写的是「槽位结构承自 Appica（MIT），取值逐字照抄 AionUi v2.1.59（Apache-2.0）」，NOTICES 里没有 AionUi 条目。NOTICES:49 说 docs/research 下有「九份报告」，实际是 14 个文件，主要是 OpenCode 研读。NOTICES:72-73 列的主要依赖漏了 undici、yauzl、@noble/*、pinia（pinia 会打进渲染包）
- 【借用上游】pi-mono：https://github.com/badlogic/pi-mono，本地快照 /home/user/refs/pi-mono @8676a0d，MIT，Copyright (c) 2025 Mario Zechner；溢出正则在 packages/ai/src/utils/overflow.ts。ZCode：https://github.com/zai-org/ZCode，本地快照 /home/user/refs/zcode @29628c9，Apache-2.0，Copyright 2026 Z.AI Co., Ltd（LICENSE:190）；解压上限常量在 apps/zcode-cli/packages/adapters/src/plugins/zip-source.ts:15-17（500MB / 20000 条 / 50MB），DataRootLock 在 packages/zcode-server-cli/src/runtime/lock.ts；它的 NOTICE.md 是产品功能与数据流声明，没有与这些部件相关的署名条目。deepseek-harness 为 MIT，Copyright (c) 2026 DeepSeek。AionUi 本地没有克隆
- 【思考可见性】渲染端 stores/chat.ts:452 调 chat.prompt 时从不传 thinkingLevel，minisd/index.ts:648 缺省为 'off'；anthropic.ts:35-45 与 gemini.ts:128-129 只在非 off 时请求思考。只有 openai.ts:115 的 reasoning_content 会产生 thinkingDelta
- 【终端】src/minisd/terminal.ts:8 明写「交互式终端驱动（与工具 shell 独立实例）」；minisd/index.ts:336 的 TerminalManager 与 :340 的 ShellManager 是两套实例，终端只是同样起在工作区目录（terminal.ts:138）。README.md:31、CHANGELOG.md:33-34、docs/RELEASE.md:47、TerminalPane.vue:63/:108 都声称二者共用同一个 shell
- 【托盘与定时】src/main/index.ts:98-99 关窗只是隐藏到托盘，:231-233 window-all-closed 空实现；minisd/index.ts:1184 cron 每 30s tick 一次，照常触发。cron/store.ts:117-121 dueJobs 取 next_run_at<=now 的任务，启动后 3s（index.ts:1186）补跑，每个错过的任务只补一次（markRun 从当下重算，store.ts:124-129）。StageCron.vue:92 写「应用没开就不会跑——它不是后台服务」
- 【出网】minisd 启动时就拉 models.dev（index.ts:259-261；model-catalog.ts:12-13，24h 缓存，失败回退 basellm.github.io），没有开关；扩展市场访问 clawhub.ai、registry.modelcontextprotocol.io、awesome-dsh-plugin.com（market/service.ts）；web_search 走 Brave/Tavily（tools/web-search.ts）；技能导入走 api.github.com（skills/importer.ts）。设置页那一节名叫「关于」（StageSettings.vue:26），不是「关于与更新」
- 【凭据位置】provider-store.ts:40 通过 @napi-rs/keyring 把密钥存进 Windows 凭据管理器，不在数据目录。index.ts:102/:145-149 的 minisd-port.json 在数据根；pairing.ts:166 的 pairing-index.json 也在数据根
- 【测试例数】README.md:57 写「1832 例」；HEAD 761b862 的提交正文记「全量 170 文件 / 1914 例（1862 过 + 52 Linux 基线）」；tests/ 下 170 个 *.test.ts
- 【README 守卫】tests/ 里没有任何测试读取 README.md 或 CHANGELOG.md，mu6-capability-wiring.test.ts:22、:109-110 只在注释和失败信息里提到 README
- 【CHANGELOG 位置】CHANGELOG.md 在仓库根，deskminis/CHANGELOG.md 不存在。「## 0.3.0 — 2026-09-07」(:6) 尚未发布；:33-34 写终端共用 shell；:47 写「思考过程展示」补回；:70-72 已知边界只写了私仓 404。「## 0.2.0 — 2026-08-20」(:74) 实际从未公开发布（报告写明 Releases 只有 v0.1.1）；:87-88 写「不驻留后台」
- 【RELEASE.md】docs/RELEASE.md:19 dist 之后没有校验步骤；:60-62 只让上传三个资产，漏了 Setup.exe.blockmap（差分下载需要）；:64-68 仍写私仓不可用；:47 写终端与 agent 共用 shell

## W2b-synchello [S]
行为：sync.hello 两端都带协议版本和可选能力位，缺失一律按旧版处理（所有能力位为 false）。
1) 发起端（OutboundClient.doHello）发送 {nonce, protocolVersion: 2, caps: {}}。
2) 应答端（createSyncMethods 的 sync.hello）在「未配对设备」检查通过之后，才把对端声明解析成 SyncPeerInfo，记到 conn.syncPeer；响应为 {mac, listenPort, protocolVersion: 2, caps: {}}。
3) 发起端在 MAC 校验通过后，把响应解析后记到 PeerConnection.peer，并公开 peerInfo(fp)（对端不在线时返回 undefined）。
4) 解析规则 parseSyncHello(raw)：
   - protocolVersion 必须是大于等于 2 的整数，否则整体视为旧版 {protocolVersion:1, caps:{}}，此时 caps 一概忽略；
   - caps 必须是普通对象，只认值严格等于 true 的键（键名为字母开头、最长 32 位的字母数字下划线，最多 32 个），其余一律为 false；
   - 未知能力位保留但不使用；更高的版本号不拒绝。
   peerHasCap(undefined, x) 恒为 false。
5) MAC 输入保持 'm3c-hello'+nonce 不变。把版本或能力位并进 MAC 会让 0.1.1 两个方向都互认失败；同步本身走 ws:// 明文，绑进 MAC 也不增加实际防护。
6) 0.3.0 本端声明的 caps 是空对象（这一版没有新的数据种类），这套机制到 W5c 才真正起作用。不新增 RPC 方法，不动数据库。

互通矩阵：
- 0.1.1 发起 → 0.3.0 应答：应答端记为旧版，返回多出的字段被 0.1.1 忽略，互认成功。
- 0.3.0 发起 → 0.1.1 应答：0.1.1 忽略多余参数，只回 {mac, listenPort}；0.3.0 视对方为旧版，互认成功。
- 0.3.0 ↔ 0.3.0：双方互记为 v2。
- 0.4.0（v3，带 caps）→ 0.3.0：0.3.0 不拒绝，记为 v3。
改动点：
  - src/minisd/sync/wire.ts 文件尾：新增 SYNC_PROTOCOL_VERSION=2、LOCAL_SYNC_CAPS（空对象，冻结）、SyncPeerInfo 类型、LEGACY_SYNC_PEER={protocolVersion:1,caps:{}}、parseSyncHello(raw: unknown)、peerHasCap(peer|undefined, name)
  - src/minisd/rpc/server.ts:7：RpcConnection 加可选字段 syncPeer?: { protocolVersion: number; caps: Readonly<Record<string, boolean>> }。用结构类型，rpc 层不 import sync 层；:87 的 conn 字面量不用改
  - src/minisd/sync/rpc.ts:77-85：参数类型改为 { nonce: string; protocolVersion?: unknown; caps?: unknown }；在 :82 之后写 conn.syncPeer = parseSyncHello(p)；:84 的返回值加 protocolVersion: SYNC_PROTOCOL_VERSION 和 caps: {...LOCAL_SYNC_CAPS}；:83 的 MAC 输入不动；:72-76 注释补一句版本协商规则
  - src/minisd/sync/outbound-client.ts:39-54：PeerConnection 加 peer: SyncPeerInfo；:125-136 初始化为 LEGACY_SYNC_PEER；:214 发送参数加 protocolVersion 和 caps，响应先当 unknown 处理，再取 mac/listenPort；:224 校验通过后写 conn.peer = parseSyncHello(resp)；新增公开方法 peerInfo(fp)（仅在线时返回）；文件头 :5-6 补一句协议版本说明
先红：
  - tests/sync-hello-version.test.ts ① parseSyncHello 纯函数：
- ({nonce:'x'}) 得旧版 {1,{}}；
- ({caps:{a:true}}) 没有版本号，按旧版处理，peerHasCap('a') 为 false；
- ({protocolVersion:'2'})、(null)、([]) 都得旧版；
- ({protocolVersion:2, caps:{a:true, b:'true', c:1}}) 只有 a 为真；
- ({protocolVersion:99, caps:{future:true}}) 得版本 99 且 future 为真（向前兼容，不拒绝）。
现在会红：wire.ts 还没有这些导出
  - ② 直接调应答端 handler，pairingService 用桩 get→{authKey: 32 字节}：
- 参数 {nonce:'n1'} → 返回的 protocolVersion === SYNC_PROTOCOL_VERSION，caps 是对象，conn.syncPeer 深等旧版；
- 返回的 mac === hex(hmac(sha256, authKey, 'm3c-hello'+'n1'))，参数带上 protocolVersion/caps 时算出同一个 mac（钉死 MAC 输入不变）；
- 桩 get→undefined 时抛「未配对设备」，conn.syncPeer 仍为 undefined。
现在会红：返回值里没有 protocolVersion
  - ③ 发起端对旧版应答端：复用 outbound-client.test.ts 里的 setupMutualPair/bootServer，customHello 只回 {mac, listenPort}（即 6c48c8b 的形状）。断言 onOnline 触发，且 client.peerInfo(fpB) 深等旧版。现在会红：peerInfo 不存在
  - ④ 发起端对新应答端：customHello 包住真 handler，截获 params 和 conn。断言 params.protocolVersion === 2 且 params.caps 是对象；上线后 client.peerInfo(fpB).protocolVersion === 2，截获的 conn.syncPeer.protocolVersion === 2。现在会红：doHello 只发 {nonce}
  - ⑤ 向前兼容：customHello 回 {mac, listenPort, protocolVersion:99, caps:{x:true}}。断言照常上线，peerInfo 的版本为 99，x 为 true
守卫：
  - tests/outbound-client.test.ts:188-189、:450-452 的 customHello 回旧形状，必须继续绿（它们天然成为「与 0.1.1 应答端互通」的回归测试），不用改
  - tests/sync-rpc.test.ts:115-118 的方法名列表不变，保持绿；:12 的 makeConn 字面量不受新可选字段影响
  - tests/presence.test.ts:115/:236、tests/auto-sync.test.ts:125 的集成测试只是多了字段，预期保持绿（需实跑确认）
风险：
  - 以后有人把版本或能力位并进 MAC，或者按版本拒绝对端，就会和 0.1.1 断连；由 ②③ 两例钉住
  - conn.syncPeer 必须在鉴权通过之后才写，否则未配对连接发来的参数也会被记住
  - ws:// 明文下，中间人可以剥掉 caps，把对端降成旧版：后果只是少推数据，不会多推，与现状同级
  - 0.3.0 声明空 caps，这套机制暂时不起作用；W5c 加第一个能力位时，要在两端同时补「对端不声明就不推」的测试
  - 解析必须是纯同步计算：0.1.1 的客户端对 RPC 有 10s 超时（outbound-client.ts:29）

## W2b-update [S]
行为：推荐落法 (a)：publish 仍用 github provider，owner: lincheuk，repo 改成一个只放发布资产的公开仓库（暂名 deskminis-releases，由用户创建）。
- 0.3.0 安装包里的 resources/app-update.yml 写死这个公开仓库。检查更新走 releases.atom 和 /releases/latest 这两个网页端点：不走 API、不吃限流、不需要 token。
- 单个资产上限 2GiB，不受 100MB 限制；旧版 blockmap 留在旧 Release 下，差分下载可用。
- 相对现状只改配置，不加依赖。

与 (b) generic provider 比较：
- 放在 GitHub Pages：资产要提交进 git，单文件硬上限 100MB，站点上限 1GB；安装包估计 80–110MB，每版两个大文件，几版就会超限，删掉旧版又会断差分。不推荐。
- 放在对象存储（R2/S3/OSS）：没有体积问题，还能挂自有域名，方便日后迁移。但要开账号、可能计费；国内 CDN 还要备案。这条作为备选交用户定。

主进程随本项一起修：
1) 便携版判断：process.env.PORTABLE_EXECUTABLE_DIR 存在时，既不检查也不下载，状态为 'portable'。
2) 错误态经纯函数 describeUpdateError(e) 映射成一行中文，原始错误写 stderr（W2b 本地日志落地后会进日志）。文案建议如下：
- ERR_UPDATER_LATEST_VERSION_NOT_FOUND / ERR_UPDATER_NO_PUBLISHED_VERSIONS / ERR_UPDATER_CHANNEL_FILE_NOT_FOUND / HTTP_ERROR_404 →「发布页上还没有可用的版本信息」
- HTTP_ERROR_403 / 429 →「更新服务器暂时拒绝访问（可能被限流），稍后再试」
- HTTP_ERROR_5xx →「更新服务器出错，稍后再试」
- ENOTFOUND / EAI_AGAIN / ECONNREFUSED / ECONNRESET / ETIMEDOUT / ENETUNREACH，或消息里含 net::ERR_ →「连不上更新服务器（离线或网络受限）」
- ERR_CHECKSUM_MISMATCH →「新版安装包校验不符，已丢弃，下次启动重试」
- ERR_UPDATER_INVALID_UPDATE_INFO / ERR_UPDATER_INVALID_RELEASE_FEED →「版本信息格式不对，已跳过本次检查」
- 其它 →「检查失败：」加原文首行（去掉 Error: 前缀，最多 120 字）

设置→关于：删掉「仓库还是私有…404 是预期的」；提示改为「启动时到 GitHub 上的 lincheuk/deskminis-releases 查一次新版本」；新增 portable 状态的文案「便携版不自动更新，请到发布页下载新版」。
改动点：
  - deskminis/electron-builder.yml:51-62：注释改写为 2026-09-24 的新裁定；repo: Deskminis 改为 deskminis-releases（名字待用户定）
  - deskminis/src/main/update-status.ts（新建）：纯函数 describeUpdateError(e: unknown): string，不 import electron，便于直接测试（与 src/main/attachments.ts 同一手法）
  - deskminis/src/main/index.ts:148 的 autoUpdater.on('error') 与 :162 的 catch：改为调用 describeUpdateError，原文写 process.stderr
  - deskminis/src/main/index.ts:153-161 checkUpdates：在 isPackaged 判断之后加便携版短路 updateState = { status: 'portable' }（自动检查和手动检查都走这条）；:146-147 注释删掉「仓库还是 private」
  - deskminis/src/renderer/src/ui/settings/SecAbout.vue:16-26：STATUS_TEXT 加 portable；:76 提示改写；:87 删掉私仓 404 那句
  - docs/RELEASE.md §4/§5：具体改法见 W2b-readme 的 RELEASE.md 条目
  - （可选）src/main/index.ts:79：托盘「检查更新…」在手动检查时，把结果用非模态 dialog 告诉用户；自动检查维持静默
先红：
  - tests/auto-update.test.ts 新增：electron-builder.yml 的 repo 行必须是 deskminis-releases，且不能是私仓 Deskminis。现在是 Deskminis，会红
  - tests/update-error-text.test.ts（新建）按 builder-util-runtime 的错误形状构造输入：
- {code:'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND', message: 'Cannot find latest.yml ... HttpError: 404 ... Headers: {...} ... at ...'}：返回值不含 Headers、不含换行和堆栈，长度不超过 60，且含「还没有」；
- {code:'HTTP_ERROR_429'} 含「限流」；
- new Error('net::ERR_INTERNET_DISCONNECTED') 含「连不上」；
- {code:'ERR_CHECKSUM_MISMATCH'} 含「校验」；
- 未知错误以「检查失败」开头，长度不超过 130。
现在会红：模块不存在
  - tests/auto-update.test.ts 源码守卫（认调用形态）：
- main 的 autoUpdater.on('error' 回调里出现 describeUpdateError( 调用；
- main 出现 process.env.PORTABLE_EXECUTABLE_DIR 和 status: 'portable'。
现在会红
守卫：
  - tests/auto-update.test.ts:35-40：选 (a) 保持绿（provider github、owner、repo 都还在）；若选 (b) generic 会红，要改为钉 provider generic 与 https url
  - tests/renderer-stage-views.test.ts:71-78：main 新增 status 'portable' 后，SecAbout 缺 portable: 文案就会红。这是预期的强制函数，同一提交补文案
  - tests/ipc-contract.test.ts:13-34：main 只新增纯模块 import，不用改桩；要是新用到 electron API，就得补桩
  - tests/auto-update.test.ts:58-61（error 监听存在）不受影响
风险：
  - 已装 0.1.1 的用户写死的是私仓 feed（6c48c8b:electron-builder.yml:56-59），永远 404，只能手动装一次 0.3.0；发布说明和 README 要写明
  - 公开仓库建好但还没发 Release 时，检查会报 NO_PUBLISHED_VERSIONS / LATEST_VERSION_NOT_FOUND；映射后显示「发布页上还没有可用的版本信息」，不会误导
  - GitHubProvider 用 /releases/latest 取 tag：Release 不能是 draft 或 prerelease，tag 用 v0.3.0，latest.yml 必须作为资产上传
  - 国内访问 github.com / objects.githubusercontent.com 不稳，(a) 和 Pages 方案都有这个问题，只有国内对象存储能解决
  - feed 一旦写死进 0.3.0，日后迁移只能先在旧 feed 上发一个带新 publish 配置的过渡版
  - 便携版判断依赖 portable.nsi:77 设置的环境变量，要在 Windows 真机确认；autoDownload=true（启动 8 秒后自动下载约 100MB）维持现状
  - 错误态和 portable 文案在 dev 模式下看不到（isPackaged=false 会短路成 'dev'），只能留到 W3 在打包态手测

## W2b-verifyrelease [M]
行为：新增 scripts/verify-release.mjs：零依赖 ESM，风格仿 e2e-m5-packaging.mjs（逐项 PASS/FAIL/SKIP 行加汇总）。
用法：node scripts/verify-release.mjs [--dist <目录>] [--version <x.y.z>]。dist 缺省为 <cwd>/dist，版本缺省取 cwd 下的 package.json。

依次检查：
① <dist>/latest.yml 必须存在。否则 FAIL：「缺 latest.yml——electron-updater 靠它发现新版；检查 electron-builder.yml 的 publish 段是否还在」。
② 用自写的最小 YAML 解析读它：只认 electron-builder 的输出形状（顶层标量 version/path/sha512/releaseDate，加 files 列表下的 url/sha512/size）；单双引号去壳；未知的标量键忽略；遇到不认识的结构直接 FAIL，不去猜。
③ version 必须等于 package.json.version。否则 FAIL：「latest.yml 是 X 版，package.json 是 Y 版——dist 里是旧产物」。
④ files 非空，且 files[0].url === DeskMinis-${version}-Setup.exe。每个 url 对应的文件都要存在：流式计算 sha512（base64）须与 yml 一致，size 须等于 stat.size，顶层 path/sha512 须与 files[0] 一致。sha512 不符时 FAIL：「DeskMinis-0.3.0-Setup.exe 的 sha512 与 latest.yml 不符（期望 …，实际 …，各取前 12 位）——照此上传会让所有用户更新失败（ERR_CHECKSUM_MISMATCH）」。
⑤ 每个 .exe 条目都要有 <url>.blockmap：非空、以 gzip 魔数 1f 8b 开头、解压后 JSON 的 version==='2'。缺失时 FAIL：「缺 blockmap——下一版无法差分下载」。
⑥ 便携版 DeskMinis-${version}-win-x64-portable.exe 存在且非空。
⑦ 若存在 <dist>/win-unpacked/resources/app-update.yml：其 provider/owner/repo 须与 electron-builder.yml 的 publish 段一致，且 repo 不是私仓 Deskminis（这是写死的 feed 的最后一道闸）；不存在就 SKIP 并说明。
⑧ W2b-license 落地后，再查 win-unpacked/resources 下有 LICENSE.txt 和 THIRD-PARTY-NOTICES.md。

退出码：任一项 FAIL 退 1，参数错误退 2，全过退 0。
脚本导出 parseLatestYml(text) 和 verifyRelease({distDir, version}) 供测试；CLI 入口判断 import.meta.url === pathToFileURL(process.argv[1]).href。
package.json 只加一行 "verify:release": "node scripts/verify-release.mjs"，不改 dist 行。
改动点：
  - deskminis/scripts/verify-release.mjs（新建，约 150 行）
  - deskminis/package.json:6-26：在 :18 e2e:m5 之后加一行 "verify:release": "node scripts/verify-release.mjs"
  - docs/RELEASE.md:19 与 §2（:25-32）：npm run dist 之后跑 npm run verify:release；§4 上传之后，把公开 Release 的四个资产下载回临时目录，再跑 npm run verify:release -- --dist <目录>
  - deskminis/tests/verify-release.test.ts（新建）
  - deskminis/tests/m5-packaging.test.ts：加一条静态断言，scripts['verify:release'] 必须含 verify-release.mjs
先红：
  - tests/verify-release.test.ts 构造 mock dist：mkdtemp 建临时目录，用 64KB 随机字节写 DeskMinis-<pkg.version>-Setup.exe；把 JSON {version:'2', files:[{name:'file', offset:0, checksums:[], sizes:[]}]} 用 zlib.gzipSync 压好写 .blockmap；便携版写随机字节；按 electron-builder 的形状写 latest.yml（releaseDate 带单引号）。
统一用 spawnSync(process.execPath, [脚本, '--dist', dir], {cwd: repoRoot, env: process.env}) 调用（先例 tests/bridge-cli.test.ts:25）。
- 正例：退出码 0，stdout 有 PASS、没有 FAIL。
- 反例：
  · 写完 yml 后改 exe 一个字节 → 退 1，输出含 sha512 和文件名；
  · 删掉 latest.yml → 退 1，输出含 latest.yml；
  · 删掉 blockmap → 退 1，输出含 blockmap；
  · yml 的 version 写成 0.0.1 → 退 1；
  · size 不符 → 退 1；
  · win-unpacked/resources/app-update.yml 写 repo: Deskminis → 退 1。
现在全部会红：脚本不存在，正例拿不到 0；反例同时断言消息关键词，所以也会红
  - 同一文件里对 parseLatestYml 做单测：用 await import(pathToFileURL(脚本).href) 动态导入（静态 import .mjs 会让 typecheck 报缺声明）。断言能解析出含 + / = 的 sha512 和数值型 size
  - tests/m5-packaging.test.ts 新增 package.json 的 verify:release 断言，现在会红
守卫：
  - 没有现有守卫会因此变红：build-config.test.ts:48-78 和 app-icon.test.ts:33-38 读 scripts 时只看各自的键
  - 新测试不依赖平台，不进 52 例 Windows-only 基线
风险：
  - 自写 YAML 解析只覆盖 electron-builder 当前的输出形状；以后 files 里若多出 blockMapSize、isAdminRightsRequired 这类键，只能忽略，不能 FAIL
  - 真实安装包约 100MB，必须流式计算哈希；测试只用小文件
  - 脚本只能证明 dist 内部自洽；上传后被替换或截断的情况，要靠 W3 把资产下载回来再跑一遍（写进 RELEASE.md）
  - 若把 ⑦ 的 app-update.yml 检查设成硬 FAIL，而用户选了 (b)，要跟着把判断改成对照 generic 的 url

## W2b-depsfrozen [S]
行为：新增 tests/deps-frozen.test.ts：
1) 文件内写死 FROZEN = { dependencies: {11 条}, devDependencies: {14 条} }，逐字照抄 package.json:31-59 的当前值。
2) pkg.dependencies 和 pkg.devDependencies 必须分别与 FROZEN toStrictEqual。
3) package.json 不得出现 optionalDependencies、peerDependencies、bundleDependencies、bundledDependencies、overrides、resolutions 这些键。
4) package-lock.json 里 packages[""] 的 dependencies/devDependencies 必须与 package.json 完全一致。清单和锁文件一漂移就在 Linux 上报出来，不必等到 Windows 真机跑 npm ci 才发现。
5) 失败信息用同文件里的纯函数 diffDeps(actual, frozen) 生成 +/-/~ 清单，例如：「依赖清单变了：+ left-pad@^1.3.0；~ ws ^8.21.1→^8.21.2。本项目零新依赖，确需变更须用户点头，然后同步改本快照并在 commit 正文申报」。
6) 不比对锁根的 version/license 元数据，避免与 W2b-license 的手改互相牵扯。
改动点：
  - deskminis/tests/deps-frozen.test.ts（新建）
  - docs/RELEASE.md §6（:70-74）加一句：改依赖要先获批，并同步 tests/deps-frozen.test.ts
  - README.md:55 的 npm install 改为 npm ci（归 W2b-readme 一起提交）
先红：
  - 守卫类测试一建成就是绿的，先红用「变异自检」证明：临时往 package.json 加 "left-pad": "^1.3.0"，或把 ws 改成 ^8.21.2，应变红并打印 diff；再把锁根的 dependencies 改得与清单不一致，也应变红；恢复后变绿。两次红的输出存档进 commit 正文（与 mu6-capability-wiring.test.ts:51-56 记载的自检手法一致）
  - 对 diffDeps 本身先写断言、后写函数：diffDeps({a:'1'},{}) 应为 ['+ a@1']，diffDeps({},{a:'1'}) 应为 ['- a@1']，diffDeps({a:'2'},{a:'1'}) 应为 ['~ a 1→2']。先写断言时是红的
守卫：
  - 没有同类的现有守卫。auto-update.test.ts:30-33（electron-updater 必须在 dependencies）和 build-config.test.ts:74-77（@electron/rebuild 必须在 devDependencies）保留，二者不冲突
风险：
  - W1/W2 的其它子波想加依赖会被拦住，这正是目的；要在波次说明里写清怎么申报
  - npm 升级可能改锁文件格式，但 lockfileVersion 3 下 packages[""] 的结构是稳定的

## W2b-license [S]
行为：1) deskminis/package.json:29 从 "ISC" 改为 "Apache-2.0"（SPDX 写法）。package-lock.json 手改三处元数据：:3 和 :9 的 "0.1.1" 改为 "0.3.0"，:11 的 "ISC" 改为 "Apache-2.0"。不跑 npm install，依赖树不动。

2) 让许可随安装包分发：electron-builder.yml 的 extraResources 追加两条：from ../LICENSE to LICENSE.txt，from ../THIRD-PARTY-NOTICES.md to THIRD-PARTY-NOTICES.md。依据：MIT 要求随副本附上版权与许可声明；Apache-2.0 §4(a)(d) 要求给接收者许可副本和 NOTICE 署名；Noto 字体的 OFL 也要求随附。

3) 修正 THIRD-PARTY-NOTICES.md 现有条目：
- §1 改为「槽位结构承自 Appica」；
- 新增 AionUi（Apache-2.0）条目：tokens.css 的 A 区取值是逐字照抄 AionUi 的；
- §2 的「九份报告」改成与 docs/research 现状一致；
- §3 补列 undici、yauzl、@noble/*、pinia。

4) 统一登记格式（W1a/W1b/W2a/W2b 通用）。
(a) 源文件头（MIT 例）：
/* 部分改编自 pi-mono（https://github.com/badlogic/pi-mono）
 *   上游：packages/ai/src/utils/overflow.ts @ 8676a0d
 *   许可：MIT，Copyright (c) 2025 Mario Zechner（全文见仓库根 THIRD-PARTY-NOTICES.md）
 *   本文件已修改：<一句话> */
Apache-2.0 照同样格式写，其中「本文件已修改」一行满足 §4(b) 的显著修改声明。ZCode 例：上游写 apps/zcode-cli/packages/adapters/src/plugins/zip-source.ts:15-17 @ 29628c9，许可写 Apache-2.0，Copyright 2026 Z.AI Co., Ltd。
(b) NOTICES 每个上游一节。标题写「## N. <项目> — 代码改编（<许可>）」，下接一张表，列为：本仓位置 | 上游位置 @ 提交 | 借了什么 | 怎么改的。表后写项目链接和许可：MIT 照录全文（含版权行）；Apache 写版权行，并注明全文同本仓 LICENSE。
(c) ZCode 的 NOTICE.md 是产品功能与数据流声明，不含与所借部分相关的署名条目，注明「未转载」即可（§4(d) 只要求转载与衍生作品相关的署名）。
(d) 另立一节「仅借思路、未复制代码」：OpenMinis（GPLv3）、AionUi 的单实例锁与 dev 数据隔离、deepseek-harness（MIT，Copyright (c) 2026 DeepSeek）的窗口守卫与 session-stop 语义。若实际复制了代码，就挪进上面的改编表。
改动点：
  - deskminis/package.json:29
  - deskminis/package-lock.json:3、:9、:11（只改元数据）
  - deskminis/electron-builder.yml:19-23：extraResources 追加 LICENSE 与 THIRD-PARTY-NOTICES.md
  - THIRD-PARTY-NOTICES.md:7-15（§1 改写）、:43-49（§2 报告数）、:64-75（§3 依赖清单），再新增 AionUi 节、pi-mono 节、ZCode 节和「仅借思路」节
  - README.md:6-7 与 :99-101：说明部分代码改编自 pi-mono/ZCode，界面令牌取值来自 AionUi，安装包 resources/ 下附有 LICENSE 与 NOTICES
先红：
  - tests/license-consistency.test.ts（新建），逐条列出：
- pkg.license === 'Apache-2.0'：现在是 ISC，会红；
- 仓库根 LICENSE 前 3 行含 Apache License 和 Version 2.0；
- lock 的 packages[""].license === pkg.license：现在是 ISC，会红；
- electron-builder.yml 的 extraResources 含 LICENSE 和 THIRD-PARTY-NOTICES.md：现在没有，会红
  - 同一文件里做双向绊线：
- 正向：扫 src/**/*.{ts,vue} 和 scripts/*.mjs 里「改编自 <名>（https://…）」的文件头，NOTICES 里必须有对应的「## N. <名>」节，且表里出现该本仓路径；
- 反向：NOTICES 改编表里列出的本仓路径必须存在，且文件头含「改编自」。
今天两侧都为空，是绿的；从 W1a 第一次借代码起才生效。自检方法：在任一源文件加一行假的改编头，应变红
守卫：
  - 没有现有守卫涉及 license 字段
  - tests/m5-packaging.test.ts:21-25 只查 extraResources 里有两个桥件，追加条目不影响
  - 若 W2b-verifyrelease 的 ⑧ 检查 resources/LICENSE.txt，要与本项同提交或排在本项之后
风险：
  - extraResources 的 from 指向工程目录之外（../LICENSE），要在 Windows 真机跑一次 npm run dist，确认 electron-builder 接受；不接受就退回到在 deskminis/ 下放一份拷贝，再加一致性测试
  - 只登记数字常量（ZCode 的解压上限）算不算「借用」存疑；W1a 若最终只复用自家 office/zip.ts 的闸（2000 条 / 64MB），ZCode 就不必登记
  - 登记格式和绊线应该在 W1a（第一次借代码）就定下来；拖到 W2b，W1a/W2a 的提交就会先违反「借用即登记」的纪律
  - 本地没有 AionUi 克隆，它的版权行要到上游 LICENSE/NOTICE 去抄

## W2b-readme [M]
行为：仓库根 README.md 的能力表和说明逐行对照代码核对，凡与代码不符的都改写（对照清单见 change_points），并把每行「属实 / 已改写 + 依据」的核对清单写进提交正文。
- 根 CHANGELOG.md 的 0.3.0 节补上 W1/W2 的止血内容，并修掉其中同类的不实说法。
- docs/RELEASE.md 同步到新的更新源和校验流程。
- README 提交排在 W2b 最后：依赖其它分区的行（欢迎页选助手、断线横幅、权限卡按会话、数据根收窄、killTree、压缩止血）要等代码落地后才能写成「属实」。
改动点：
  - README.md:30 设备同步与接力。① 记忆文件不同步，线格式只带每个会话的 memoryEnabled 开关（wire.ts:44、:156）；② 没有「接力」功能（src 里 grep「接力」「handoff」零命中）；③ 缺省只监听 127.0.0.1（minisd/index.ts:1223-1224），主进程不注入 MINISD_HOST（main/index.ts:35），界面也不显示本机端口（StageDevices.vue:132）。→ 改为 🟡「内网直连配对后，会话与消息双向同步（记忆文件不同步，只同步每个会话的记忆开关）。跨机器使用须先在两台机器上设环境变量 MINISD_HOST=0.0.0.0 再启动，界面暂无开关。设备页可暂停/恢复同步」
  - README.md:90 架构图里的「同步引擎（mDNS + 直连）」：代码里没有 mDNS，配对靠手填 host:port（StageDevices.vue:56-70、remote/index.ts:110-123）。→ 改为「同步引擎（手填 host:port 配对 + 直连）」
  - README.md:32「NSIS 安装包 + 便携版 + 自动更新」与 :45「安装版（推荐，支持自动更新）」：feed 现在指向私仓，会 404（electron-builder.yml:54-62）；便携版在代码里没有任何限制。→ 改为「NSIS 安装包（自动更新：从公开发布仓库 lincheuk/deskminis-releases 检查，可在设置→关于里关掉）+ 便携版（不自动更新）」，并加一句「0.1.1 用户需手动安装一次 0.3.0」。若用户选择不带自动更新，就如实写「0.3.0 不带自动更新」
  - README.md:43 Releases 链接指向私仓，外人打开是 404。→ 改为公开发布仓库的 Releases 页
  - README.md:16「思考过程可见（Anthropic/Gemini 原生思考与 DeepSeek 类 reasoning_content 都渲染）」：渲染端从不传 thinkingLevel（stores/chat.ts:452），后端缺省为 off（minisd/index.ts:648），anthropic.ts:35 和 gemini.ts:128 只在非 off 时才请求思考。→ 改为「DeepSeek 类 reasoning_content 的推理过程可见；Anthropic/Gemini 原生思考暂无档位入口，新一代 Claude 自带的思考不回显（思考档位计划在 0.6.0）」
  - README.md:21 定时任务「应用运行时生效（不驻留后台，不假装 24/7）」：关窗只是隐藏到托盘（main/index.ts:98-99、:231-233），cron 每 30 秒照常 tick（minisd/index.ts:1184），错过的任务启动后补跑一次（cron/store.ts:117-129，index.ts:1186）。→ 改为「关掉窗口后应用仍在托盘运行，定时任务照常触发；从托盘退出或关机后不再触发，错过的任务下次启动时补跑一次（不逐次补）」
  - README.md:57「npm test # 1832 例」：HEAD 761b862 记录的是 170 文件 / 1914 例（1862 过 + 52 Linux 基线）。→ 不写死数字，改为「npm test  # Windows 上应全绿；Linux 上有 52 例 Windows 专属用例会失败」
  - README.md:31「终端与 agent 共用同一个长驻 shell（cd 与环境变量互通）」：terminal.ts:8 自称「与工具 shell 独立实例」，minisd/index.ts:336 与 :340 是两套实例。→ 改为「终端在本会话工作区里另起一个 PowerShell，与 agent 的 shell 不共享 cd 和环境变量」。同样的话还出现在 CHANGELOG.md:33-34、docs/RELEASE.md:47、TerminalPane.vue:63/:108，一并改
  - README.md:79-80「只有一处主动出网：启动时向 GitHub 查一次版本号」：启动时还会拉 models.dev（minisd/index.ts:259-261；model-catalog.ts:12-13，24h 缓存，失败回退 basellm.github.io，没有开关）；另有扩展市场三源（market/service.ts）、web_fetch/web_search（Brave/Tavily，要过权限卡）、技能从 GitHub 导入、用户配置的 MCP http 服务器。设置里那一节叫「关于」（StageSettings.vue:26）。→ 逐项列出出网点，并写明哪些可以关、哪些是用户主动触发
  - README.md:66-73「一切都在 %APPDATA% 下的 DeskMinis」：API 密钥其实在 Windows 凭据管理器（provider-store.ts:40）；目录里还有 providers.json、mcp-servers/、models-dev-cache.json、minisd-port.json、pairing-index.json、update-prefs.json 和 Chromium 缓存；W2b 之后崩溃记录与日志在 LOCALAPPDATA；W1a 之后开发态数据在 DeskMinis-dev。→ 补全布局，改掉「一切都在」
  - README.md:6-7「只研读架构，未复用代码」：这句只对 OpenMinis 成立。→ 补一句「部分实现改编自 pi-mono（MIT）、ZCode（Apache-2.0），界面令牌取值来自 AionUi（Apache-2.0），见 THIRD-PARTY-NOTICES」
  - README.md:20「欢迎页选中助手再输入即建绑定会话」：已有空会话处于激活状态时，欢迎页照样显示（AppShell.vue:50），但 Composer.vue:225 只在没有 activeId 时才套用助手。→ 等 W2b 的最小修落地后才能标「属实」
  - README.md:15「点停止即时中断正在跑的工具」：现在停止只 SIGKILL powershell 本体（tools/shell.ts:151、:156），不杀进程树。→ W1b 的 killTree 落地后才属实
  - README.md:18「工作区内文件直接放行」：属实，但漏了一点，整个数据根现在都免审（tools/files.ts:27-32）。W1b 收窄之后补一句「应用自己的配置和数据库，agent 不能改写」
  - README.md:24 压缩与修剪：压缩、卸载、修剪都有已知问题（compact.ts:62/67/92/97，loop.ts:340，offload.ts:34，prune.ts:39）。→ 补「0.3.0 的压缩是止血版：失败会提示，不再静默；长会话的压缩质量在 0.4.0 改进」
  - README.md:34 模型组降级：W2a 之后，上下文溢出不会再降级到窗口相同的模型，前缀绑定类 400 也不再降级。→ 补「上下文已满时不换到同窗口的模型，会提示新建会话接力」
  - README.md:36-37 图例写「0.3.0 起 🟡 已清零」：设备同步那行改成 🟡 之后，这句要一起改
  - README.md:55 npm install → npm ci（与依赖冻结一致）；:56 补一句「开发态数据在 DeskMinis-dev」（W1a 之后）
  - README.md:96-97「research/ 是 OpenMinis 研读报告」：docs/research 实际是 14 个文件，主要是 OpenCode 研读和插件市场调研。→ 改写（NOTICES:49 同步改）
  - README.md:39「只在 Windows 上开发与验证过」→「只在 Windows 上验证过」；README.md:33 的浏览器/屏幕行维持 ⛔（截屏桥存在，但结果对模型不可见），属于次要项
  - 抽查属实、不改的行：README.md:17、:19、:22、:23、:25-29；其中 :19、:25、:28、:30 的入口由 tests/mu6-capability-wiring.test.ts 的 WIRED 清单钉住
  - CHANGELOG.md:6：日期留到 W3 真正发布时再填（在那之前标「待发布」），标题下加一句「首个公开版本；0.2.0 未公开发布，其内容一并计入」
  - CHANGELOG.md 0.3.0 节新增「数据安全」与「失效与界面诚实」两节，逐条列 W1a/W1b/W2a/W2b 的止血项（file_edit 的 $ 替换、MCP 配置被覆盖、DB_NEWER_THAN_APP、数据根收窄、单实例、删运行中会话、优雅退出、压缩止血、溢出分类、Claude drop_block、DeepSeek V4 回传、卸载与修剪如实、断线横幅、权限卡按会话、外链交给浏览器、本地崩溃记录、同步握手带协议版本、发布校验、许可改 Apache-2.0、更新源改公开仓库）
  - CHANGELOG.md:33-34 终端共用 shell 的说法改掉；:47「思考过程展示」限定为 reasoning_content 类
  - CHANGELOG.md:70-72 已知边界：删掉私仓 404 那句，改列：0.1.1 用户需手动装一次；便携版不自动更新；设备同步需 MINISD_HOST；记忆文件不同步；压缩质量到 0.4.0；没有思考档位入口；SmartScreen 提示
  - CHANGELOG.md:74 的 0.2.0 标注「（未公开发布）」；:87-88「不驻留后台」按 README.md:21 同样改写
  - docs/RELEASE.md：
- :19/§2 加 verify:release；
- §3 加两项检查：「设置→关于→现在检查」显示已是最新而不是报错；安装目录 resources 下有 LICENSE.txt；
- :47 终端文案修正；
- §4（:54-62）改为发布到公开发布仓库：上传四个资产（Setup.exe、Setup.exe.blockmap、portable.exe、latest.yml），不能是 draft 或 prerelease，tag 用 v<版本>，上传后下载回来再跑一次 verify；
- §5（:64-68）改写，删掉私仓说明；
- §6（:70-74）加依赖快照规则
先红：
  - 路线图对 README 的验收只要求在提交正文附逐行核对清单。可选再加 tests/readme-claims.test.ts，钉住三条能机器核对的：
- ① README 不写死测试例数：现在 README.md:57 写着数字，会红；
- ② README 一旦提到 mDNS，src/minisd 里就必须有 mdns 实现：现在 README.md:90 提了、src 零命中，会红；
- ③ README 的 Releases 链接里的 owner/repo 必须与 electron-builder.yml publish 段一致：现在两边都是 lincheuk/Deskminis，是绿的；以后改 feed 时它会逼着同步改 README
守卫：
  - 没有现有 README/CHANGELOG 文本守卫：mu6-capability-wiring.test.ts:22、:109-110 只在注释和失败信息里提到 README，不读文件
  - 如果顺手改 TerminalPane.vue 的文案：tests/renderer-content-form.test.ts:17-52 只查颜色变量和残留皮肤，不受影响
风险：
  - 设备同步行改成 🟡 会推翻 README.md:36-37「🟡 已清零」的脚注和 Y/Z 波的叙事，要一起改
  - 同样的不实说法也在界面文案里：TerminalPane.vue:63/:108「与 agent 共用」、StageCron.vue:92「它不是后台服务」、StageDevices.vue:87「会话与设置在两边同步」。只改 README，文档就会和界面互相矛盾。这些 .vue 文件属于渲染端分区，要协调，并在 xvfb 下目视
  - README 的「更新源」和「许可」两段依赖 W2b-update 与 W2b-license 的裁定和落地，顺序上要排在它们之后
  - 当前私仓的 README 外人看不到，公开发布仓库需要一份对外 README（可以从根 README 拷贝），这一步要写进 RELEASE.md

## open_questions
- Q: 更新源具体怎么落：(a) github provider 指向一个只放发布资产的公开仓库，(b) generic provider 指向 Pages 或对象存储，还是 (c) 0.3.0 不带自动更新？仓库名用什么？
  推荐: 选 (a)：新建公开仓库 lincheuk/deskminis-releases（名字由用户定），electron-builder.yml 只改 repo 一行
  理由: (a) 只改配置、零依赖；资产上限 2GiB；差分下载可用；不走 API，不吃限流；现有守卫 auto-update.test.ts:35-40 继续有效。(b) 放 Pages 会撞 git 单文件 100MB 和站点 1GB 的上限；放对象存储要开账号、可能计费，但能挂自有域名，方便日后迁移、做国内加速，可以作为以后的迁移目标。仓库得由用户在 GitHub 上建，本侦察无权也无网络替他建
- Q: W3 前是否实测安装包体积？
  推荐: W3 在 Windows 上跑完 npm run dist 后记录 Setup.exe 和 portable.exe 的字节数，写进 RELEASE.md 和发布说明
  理由: 仓库里没有任何实测记录。选 (a) 时不影响决定；如果用户倾向 Pages 方案，体积直接决定可不可行
- Q: 0.3.0 的 sync.hello 要声明哪些能力位？
  推荐: protocolVersion=2，caps 为空对象；只实现解析、记录与 peerHasCap，第一个能力位留给 W5c
  理由: 0.3.0 没有新的数据种类，声明了也没东西可用。现在带上版本号，是为了让 0.4.0 能分清对端是 0.3.0 还是 0.1.1，同时让 0.3.0 能容忍将来的能力位
- Q: 应答端把对端的 hello 声明存在哪？
  推荐: 给 RpcConnection 加可选字段 syncPeer（server.ts:7），用结构类型，不 import sync 层
  理由: conn 对象一个连接一份（server.ts:87），生命周期正确。W5c 要在 sync.pull/sync.push 里按对端能力过滤，直接读 conn 最简单。WeakMap 方案要多暴露一个取值器
- Q: README 里的设备同步怎么定级？
  推荐: 标 🟡，写明跨机器要在两台机器上设 MINISD_HOST=0.0.0.0 再启动、界面暂无开关、记忆文件不同步；本轮不加开关
  理由: 缺省只监听 127.0.0.1（minisd/index.ts:1223-1224），开箱时跨机器不可用，写 ✅ 属于撒谎。加开关是新功能，违反 W2「不加新功能」；这种情况正好符合 🟡「后端已建成、没有界面入口」的定义
- Q: LICENSE 和 THIRD-PARTY-NOTICES 是否随安装包分发？
  推荐: 要，用 electron-builder.yml 的 extraResources 从 ../ 拷进 resources/，由 verify-release 与 W3 真机确认
  理由: 现在安装包里没有本项目许可，也没有第三方署名（包括 Noto 字体 OFL 要求随附的声明）；这一轮借用 pi（MIT）的代码之后，二进制分发必须带上 MIT 声明
- Q: NOTICES 的登记格式和双向绊线测试在哪个子波引入？
  推荐: 放在 W1a（第一次借用 pi 的 edit.ts 或 ZCode 常量的那一笔），格式照本分区给出的写；W2b 只做 package.json 的许可和随包分发
  理由: 路线图写的是「凡借用 MIT/Apache 代码的子波都在 NOTICES 登记」。W1a、W1b、W2a 都排在 W2b 前面，等到 W2b 再定格式，前面几个子波的提交就先违纪了
- Q: ZCode 的解压上限常量要不要登记？
  推荐: W1a 如果只复用自家 office/zip.ts 的闸（2000 条 / 64MB），就不登记 ZCode；如果采用 ZCode 的数值（500MB / 20000 条 / 50MB），就按 Apache 格式登记
  理由: 单纯的数字常量是否构成可版权的表达存疑；本地的 office/zip.ts 已经有三道闸，路线图写的也是「复用 office/zip.ts」
- Q: 要不要加 README 可机检守卫（tests/readme-claims.test.ts）？
  推荐: 加，只钉三条：不写死测试例数；提到 mDNS 就必须有实现；Releases 链接与 publish 段一致
  理由: T6c 起 README 已经被纠正过两轮，还是会再漂，没有测试网兜着。这三条能机器核对、误报低；其余能力行仍靠提交正文的逐行清单
- Q: 托盘「检查更新…」手动检查的结果要不要显示？
  推荐: 要：手动检查时，把结果（已是最新 / 有新版在下载 / 失败原因）用非模态 dialog 告诉用户；自动检查维持静默。托盘里的两个死通道（打开设置、切换右栏）交给渲染端分区去接
  理由: 现在从托盘点检查更新，界面上完全没反应（main/index.ts:79），这违背 W2「失败都看得见」；auto-update.test.ts:58-61 只要求自动检查静默，并不禁止手动检查给反馈
- Q: package-lock.json 根上过期的 version/license 元数据怎么处理？
  推荐: 手改 :3、:9、:11 三处，不跑 npm install
  理由: 那是 0.1.1 时代的元数据，与 0.3.0 和 Apache-2.0 不一致；手改不动依赖树，也不触发依赖冻结守卫（它只比对 dependencies/devDependencies）
- Q: 公开发布仓库里要不要放 README、LICENSE、NOTICES、CHANGELOG？
  推荐: 要，W3 发布时把根目录这四个文件拷过去，写进 RELEASE.md §4
  理由: 主仓是私有的，外人看不到根 README，公开仓库就成了唯一的对外入口；Apache 与 MIT 的声明也应该在分发处可见
- Q: 界面里同类的不实文案（TerminalPane.vue:63/:108、StageCron.vue:92、StageDevices.vue:87）谁来改？
  推荐: 与 README 同一波改，归 W2b 渲染端分区，附 xvfb 截图
  理由: 只改 README，文档就会和界面互相矛盾；.vue 不在 typecheck 覆盖范围内，要目视确认
- Q: CHANGELOG 里的 0.2.0 要不要标「未公开发布」？
  推荐: 标
  理由: Releases 里只有 v0.1.1。0.3.0 是第一个公开版本，读者要知道 0.2.0 的内容其实是随 0.3.0 一起首发的

## files
- /home/user/Deskminis/deskminis/src/minisd/sync/wire.ts
- /home/user/Deskminis/deskminis/src/minisd/sync/rpc.ts
- /home/user/Deskminis/deskminis/src/minisd/sync/outbound-client.ts
- /home/user/Deskminis/deskminis/src/minisd/rpc/server.ts
- /home/user/Deskminis/deskminis/tests/sync-hello-version.test.ts（新）
- /home/user/Deskminis/deskminis/electron-builder.yml
- /home/user/Deskminis/deskminis/src/main/index.ts
- /home/user/Deskminis/deskminis/src/main/update-status.ts（新）
- /home/user/Deskminis/deskminis/src/renderer/src/ui/settings/SecAbout.vue
- /home/user/Deskminis/deskminis/tests/auto-update.test.ts
- /home/user/Deskminis/deskminis/tests/update-error-text.test.ts（新）
- /home/user/Deskminis/deskminis/scripts/verify-release.mjs（新）
- /home/user/Deskminis/deskminis/tests/verify-release.test.ts（新）
- /home/user/Deskminis/deskminis/package.json
- /home/user/Deskminis/deskminis/package-lock.json（仅根元数据）
- /home/user/Deskminis/deskminis/tests/m5-packaging.test.ts
- /home/user/Deskminis/deskminis/tests/deps-frozen.test.ts（新）
- /home/user/Deskminis/deskminis/tests/license-consistency.test.ts（新）
- /home/user/Deskminis/deskminis/tests/readme-claims.test.ts（新，可选）
- /home/user/Deskminis/THIRD-PARTY-NOTICES.md
- /home/user/Deskminis/README.md
- /home/user/Deskminis/CHANGELOG.md
- /home/user/Deskminis/docs/RELEASE.md
- （跨分区，建议同波）/home/user/Deskminis/deskminis/src/renderer/src/ui/TerminalPane.vue、StageCron.vue、StageDevices.vue 文案

## xvfb
- 设置→关于：「仓库还是私有…404」一句已删除；:76 的提示改为公开发布仓库；dev 下状态行仍显示「开发模式：不检查更新」。错误映射文案和 portable 状态在 dev 下看不到，列入 W3 的 Windows 打包态手测
- （跨分区）底部终端抽屉的标题与连接提示不再宣称「与 agent 共用同一个长驻 shell」（TerminalPane.vue:63、:108）
- （跨分区）定时任务页页头改为「关窗后仍在托盘运行、任务照常触发；退出后不触发，错过的下次启动补跑一次」（StageCron.vue:92）
- （跨分区）设备页副标题不再写「会话与设置在两边同步」，并提示跨机器需要 MINISD_HOST（StageDevices.vue:87）