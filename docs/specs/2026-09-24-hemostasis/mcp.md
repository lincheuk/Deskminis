# MCP 配置与设置页（W1a-mcpcorrupt / W1a-mcpedit / SecMcp 守卫与 mu6 清单）

## facts
- 【基线】tests/mcp-config.test.ts、renderer-mcp-settings.test.ts、mu6-capability-wiring.test.ts、mcp-test-rpc.test.ts 四个文件共 67 例在 Linux 上全绿；market-install.test.ts 与 market-update.test.ts 共 45 例全绿（本次只读实跑）
- 【store 的写入方法】McpServersStore 只有三个会调 save() 的方法：upsert（src/minisd/mcp/config.ts:186-211）、remove（:213-216）、toggle（:218-224）。任务里写的 add、setEnabled 在代码里并不存在，对应的是 upsert 和 toggle
- 【读取：ENOENT 与其它错误】现状 src/minisd/mcp/config.ts:124 用 existsSync 判断文件在不在。existsSync 在任何 stat 错误下都返回 false，所以 ENOENT、父目录 EACCES、ENOTDIR 都被当成「没有文件」，不记 loadError，而且之后照常可写
- 【读取：其它读错误被标成解析失败】readFileSync 包在同一个 try 里（config.ts:126-130），文件存在时的 EACCES、EPERM、EISDIR、EBUSY 都记成 loadError='servers.json 解析失败: <message>'，和真正的语法错误混在一起。顶层不是对象时记 'servers.json 顶层不是 JSON 对象'（:132-135）
- 【读取：BOM】UTF-8 BOM 没有剥掉。实测 JSON.parse('﻿{}') 会抛错，所以用带 BOM 的编辑器（比如记事本）保存的合法文件会进 loadError
- 【读取：空文件】0 字节或只有空白的文件同样进 loadError（报 Unexpected end of JSON input）
- 【覆盖路径】loadError 只在 config.ts:129/:133 记一笔，之后 entries 为空，没有任何拦截。upsert 会走到 save()（:173-175，tmp 加 rename），用只有新条目的 {mcpServers} 覆盖原文件。remove 遇到空 Map 直接 return（:214），toggle 抛「不存在」（:220）。所以现在真正能写坏文件的只有 upsert，入口是设置页添加和市场安装
- 【不重新读盘】McpServersStore 只在构造函数里读盘一次（config.ts:117），全仓没有 fs.watch 或 reload。save 把内存副本整份写回（:152-176）
- 【loadError 可能带出密钥】loadError 原文可能含密钥片段。在 Electron 38.8.6 / V8 14.0 上实测，JSON.parse 报错会带出约 10 字符的源码上下文，例如：Unexpected token 'u', ..."9"}, "x": undefined}"... is not valid JSON。所以拒写时的错误文案绝不能拼进 loadError
- 【RPC 呈现】src/minisd/index.ts:837 的 mcp.servers.list 只回 configError: Boolean(loadError)，注释 :835-836 说明原文不出 minisd。upsert、remove、toggle 三个 RPC（:838-849）原样调用 store，抛出的错经 rpc/server.ts:112 以 error.message 原文传出，渲染端在 rpc.ts:52 用 reject(new Error(msg.error.message)) 接住
- 【store 侧】src/renderer/src/stores/chat.ts:77-84 的 mcpServers 状态里有 configError 布尔。:333-339 fetchMcpServers 负责透传；:341-352 的 upsert、remove、toggle 执行成功后都会重拉列表；:355-357 testMcpServer 原样转发
- 【SecMcp：两条重复横幅】SecMcp.vue 有两条同时出现的 configError 横幅：:82-84（T5，提交 6fd7aa9）和 :89-91（T6e-3，提交 dddbbf8，补搬时没发现已经有一条）。:83 写着「修好文件后回到这页会自动重读」，这是假话：store 不会重读，只有重启才会
- 【SecMcp：出错时仍能添加】SecMcp.vue:119 的「添加服务器」按钮在 configError 时照样显示；:95 的开关是 @change="chat.toggleMcpServer(...)"，没有 await 也没有 catch，失败时勾选框已经翻了但后端没变
- 【SecMcp：编辑载荷】SecMcp.vue:11 的 blank 表单只有 name、transport、command、args、url、note 六个字段。startEdit（:25-35）用 args.join(' ') 回填（:31）；payload()（:40-49）固定塞 enabled: true（:41），参数用 split(/\s+/) 重新切分（:44），note 为空时是 undefined，走 JSON 会被丢掉。表单里没有 env、headers、cwd、startupTimeoutSeconds 这几项
- 【SecMcp：改名先删后加】SecMcp.vue:55 改名时先 removeMcpServer(旧名)，再 upsert。upsert 校验失败时旧条目已经删掉，这是又一条丢配置的路径
- 【SecMcp：试连不带已存字段】SecMcp.vue:65-74 表单内试连也用 payload()，index.ts:862-870 在 scratch 临时目录新建 store 执行 upsert(p)。编辑已有服务器时，已存的 env、headers、cwd、startupTimeoutSeconds 不会进入试连，需要环境变量的服务器在表单里试连必然失败
- 【upsert 整条替换】config.ts:189 只对 input 本身做 decodeEntry，:199-206 只从旧条目保留 createdAt 和 extra（extra 做浅合并），其余字段整条替换，缺省 enabled 回到 true（:87）
- 【decodeEntry 支持的字段】decodeEntry（config.ts:73-102）：name（键名或参数，trim 后非空）；command（string，出现即判为 stdio）；url（string）；type 或 transport（http、streamable-http、streamable_http、sse 四个别名只在没有 command 时参与判型，:61-62、:83）；args（string[]，非字符串元素被静默过滤，:48-51）；env、headers（Record<string,string>，非字符串值被静默过滤，:52-57）；cwd、note（string）；enabled 或 disabled（disabled:true 优先，其次 enabled!==false，:87）；startupTimeoutSeconds（只收 number，:95）；createdAt、updatedAt（非空 string）。其余键都进 extra（:98-100，KNOWN_KEYS 见 :65-68）
- 【save 写回什么】save() 先铺 extra（:155），再按传输类型只写该族字段：stdio 写 command、args、env、cwd（:156-160），http 写 url、headers（:161-164）；enabled 只在 false 时落盘（:167）；不写 transport 和 type；顶层只写 {mcpServers}（:174），其它顶层键全部丢弃
- 【load 静默跳过】load 的 absorb（config.ts:136-140）会静默跳过解码失败的条目，比如 command 是数组或数字、既没有 command 也没有 url 的草稿条目。下一次任意保存时，这些条目就从文件里消失了
- 【全部写入方】servers.json 的写入方全仓只有四处：index.ts:839 的 mcp.servers.upsert、index.ts:865 的试连 scratch store、src/minisd/market/install.ts:503 的市场安装与更新，以及测试 mcp-manager.test.ts:77/:138 和 mcp-config.test.ts。没有独立的「导入」RPC，所谓导入就是 load() 的三变体宽容读取，不走 upsert
- 【市场：env 合并】market/install.ts:172-185 的 mergeEnvForUpdate 只保留新版本声明过的键，:184 的注释写明旧 env 里未声明的键靠这一步清掉。:495 只在 merged.env 非空时才设置 entry.env；:498 远端分支的条目只有 name、transport、url。在补丁语义下：(1) 新版本完全不声明 env 时，旧 env 会被保留，违背 :184 的意图；(2) 从 stdio 换成远端时，如果不做族切换，旧 command 仍在，decodeEntry(:81) 会继续判为 stdio
- 【市场：错误如实显示】StageMarket.vue:245 调用 market.install，:257 和 :411 把服务端错误原样显示，拒写文案会如实出现在市场确认卡上
- 【一行一条的先例】渲染端已有「一行一条」的写法：StageAssistants.vue:37 用 join('\n')，:45 用 split('\n').map(trim).filter(Boolean)，textarea 用 class="f-area"（theme.css:286、:292）。src/renderer/src/lib/*/ 下的纯 .ts 模块在 typecheck 范围内，可以直接单测（例如 tests/renderer-mcp-perm.test.ts 直接 import lib/perm/copy.ts）
- 【manager 不跟随配置变化（相邻发现）】ensureForRun（manager.ts:114-152）只连「enabled 且还没连上」的服务器，已连上的不会因为配置改动而重连。执行器不查 store 里的 enabled，全局停用或删除一台已连上的服务器后，它的工具要等 10 分钟空闲驱逐（manager.ts:55、:182-192）才下表。SecMcp.vue:80「改动即时生效，不用重启」对启停和编辑都不成立
- 【stdio 启动】stdio.ts:86-88：Windows 上命令是裸名（如 npx）时，经 cmd.exe /d /s /c 包一层再启动。带空格的参数到了子进程是否仍完整，需要真机验证
- 【README】README.md:28 的 MCP 能力行写「设置页添加 / 试连 / 启停 / 删除」，没有提编辑

## W1a-mcpcorrupt [S]
行为：【读取分流】load() 去掉 existsSync，直接用 readFileSync：
- 错误码为 ENOENT：按空配置处理，可写，不记 loadError（首次运行的正常路径）。
- 其它 errno（EACCES、EPERM、EISDIR、EBUSY 等）：loadErrorKind='read'，loadError 只记 `servers.json 读取失败: <code>`（只记 errno 码，不记 message）。
- 读到内容后先剥掉开头的 ﻿；剩下只有空白时按空配置处理，可写；JSON.parse 失败为 'parse'；顶层不是对象为 'shape'。

【拒写】upsert、remove、toggle 三个方法都在第一行调用 assertWritable()，位置在名称校验和任何 Map 改动之前；save() 首行再加一道防线。有 loadErrorKind 时抛固定的中文错误，绝不拼进 loadError 原文。
- remove 或 toggle 对不存在的名字，在 loadError 下也抛这条拒写错误，不再静默成功或报「不存在」。
- 文案建议（parse、shape）：「servers.json 格式有误。为免覆盖你原来的配置，MCP 服务器暂时不能添加、修改、启停或删除。请修好这个文件后重启 DeskMinis。」
- 文案建议（read）：「servers.json 无法读取（EACCES）。为免覆盖原文件，MCP 服务器暂时不能添加、修改、启停或删除。请检查文件权限或是否被其它程序占用，然后重启 DeskMinis。」
- 若采纳 W1a-mcpstale 的 refresh，两条文案的末句改为「修好后回到这页即可」。

【RPC】mcp.servers.list 保留 configError 布尔，出错时另带 configErrorKind:'read'|'parse'|'shape'。没出错时不带这个键，或者值为 undefined，不要用 null。

【试连与市场】mcp.servers.test 不写盘，不受影响。市场安装经 upsert 自然被拒，recordInstall（install.ts:504）不会执行，StageMarket 原样显示中文错误。

【SecMcp】
- 删掉 :82-84 那条横幅：它与 :89-91 重复，而且「自动重读」是假话。
- :89-91 保留被守卫钉住的原句，并补一句「为免覆盖原文件，这里暂时不能添加或修改」；read 类另写一句说明权限或占用。
- :119 的「添加服务器」在 configError 时隐藏。
- :95 的开关改成 onToggle(s, ev)：用 try/catch 把错误写进 err，再 fetchMcpServers 回滚勾选态。
改动点：
  - src/minisd/mcp/config.ts:4 删 existsSync 导入
  - src/minisd/mcp/config.ts:109-111 保留 loadError: string|undefined（旧测试只断言 truthy），新增 loadErrorKind、loadErrorCode
  - src/minisd/mcp/config.ts:123-135 重写读取段：readFileSync 的 catch 里按 code==='ENOENT' 分流、剥 BOM、处理只有空白的文件、区分 parse 与 shape
  - src/minisd/mcp/config.ts 新增 private assertWritable() 与 refuseMessage(kind, code)，文案为常量，不接收 loadError
  - src/minisd/mcp/config.ts:152 save() 首行、:186 upsert 首行、:213 remove 首行、:218 toggle 首行调用 assertWritable()
  - src/minisd/index.ts:837 追加 ...(mcpServers.loadErrorKind ? { configErrorKind: mcpServers.loadErrorKind } : {})
  - src/renderer/src/stores/chat.ts:77-84 类型加 configErrorKind?: 'read'|'parse'|'shape'；:335-339 透传 r?.configErrorKind
  - src/renderer/src/ui/settings/SecMcp.vue:82-84 删除；:89-91 改文案并按 configErrorKind 分支；:95 改为 @change="onToggle(s, $event)"，在 script 里加 onToggle（try/catch、fetchMcpServers、回写 checked）；:119 的 v-if 改为 !open && !chat.mcpServers.configError
先红：
  - tests/mcp-config-corrupt.test.ts（路线图指定的文件名）：写入 '{ 这根本不是 json'，记下 Buffer 后执行 store.upsert({name:'a',command:'x'})。断言 toThrow(/servers\.json/)，且 readFileSync(cfgFile) 与原 Buffer 逐字节相等。现在会红：upsert 成功，save 用 {mcpServers:{a:...}} 覆盖了文件
  - 同一文件：坏 JSON 下 store.remove('a') 与 store.toggle('a', false) 都 toThrow(/servers\.json/)。现在会红：remove 在 config.ts:214 静默返回；toggle 抛的是「MCP server 不存在: a」
  - 同一文件：拒写之后 store.list() 仍为 []。现在会红：upsert 已经写进内存和磁盘。这条同时防止实现者把闸只放在 save() 里、内存先被改掉
  - 同一文件：顶层是 [] 时 loadErrorKind==='shape'，upsert 被拒，文件字节不变。现在会红：kind 字段不存在，而且会被覆盖
  - 同一文件：写入 '﻿{"mcpServers":{"a":{"command":"x"}}}'，断言 list 名单为 ['a']、loadError 为 undefined、upsert 能写。现在会红：带 BOM 被判成解析失败
  - 同一文件：先 mkdirSync(cfgFile) 让 servers.json 变成一个目录（触发 EISDIR；容器里是 root，chmod 000 挡不住，所以不用 chmod），断言 loadErrorKind==='read'、loadError 不含「解析失败」、upsert 被拒。现在会红：现有 loadError 是「servers.json 解析失败: EISDIR…」，也没有 kind 字段
  - 同一文件：写入 '{"mcpServers":{"a":{"env":{"TOKEN":"sk-SECRET789"}, "x": undefined}}}'，捕获 upsert 抛出的错，断言 message 不含 'SECRET' 也不含 'undefined}'。现在会红：upsert 根本不抛
  - 同一文件（回归钉，现在是绿的）：没有文件时 loadError 为 undefined，upsert 能建出文件
  - 同一文件 RPC 例：用坏 JSON 启动 minisd。mcp.servers.upsert 回 error.message 匹配 /servers\.json/ 且文件字节不变；mcp.servers.list 回 configError:true、configErrorKind:'parse'，JSON.stringify 结果不含「解析失败」。现在会红：upsert 回 {ok:true}
  - tests/market-install.test.ts：给 makeCtx（:163）加可选参数 seedServersJson，在 :180 构造 McpServersStore 之前落盘。新增一例：servers.json 损坏时安装 mcp-registry:io.github.owner/mcp-fetch，断言 reject 且 message 匹配 /servers\.json/、文件字节不变、installed({kind:'mcp'}).items 为 []。现在会红：安装成功并覆盖了文件
  - tests/renderer-mcp-settings.test.ts 新增 describe 'W1a 配置损坏'（源码守卫，按调用形态断言）。现在全部会红：
- `v-if="chat.mcpServers.configError"` 恰好出现 1 次（现在是 2 次）；
- 源码不含「自动重读」；
- 添加按钮的 v-if 含 `!chat.mcpServers.configError`；
- 开关是 `@change="onToggle(`；
- onToggle 函数体里有 `.toggleMcpServer(` 和 catch。
守卫：
  - tests/mcp-config.test.ts:119-126 只断言 loadError truthy 且构造不抛，保留字符串型 loadError 就仍然绿
  - tests/mcp-config.test.ts:259 与 :276 用 toEqual({ servers: [], statuses: [], configError: false }) 精确比对。configErrorKind 只能在出错时带；实现成 null 会红（undefined 会被 toEqual 忽略，走 JSON 时也会被丢掉）
  - tests/mcp-test-rpc.test.ts:87-105 断言 list 结果里不出现「解析失败」。configErrorKind 取英文枚举即可，绝不能把 loadError 放进 list
  - tests/renderer-mcp-settings.test.ts:29-32 钉着「servers.json 解析失败，已按空配置加载——请检查文件语法」这一句。在 parse、shape 分支保留原句（后面可以追加），就不需要重指
  - tests/renderer-mcp-settings.test.ts:62-72 的行正则要求 `<div v-for="s in list"` 整行结构不变，且行内含 s.name 和 f-switch。onToggle 的改法不影响
  - tests/renderer-mcp-settings.test.ts:74-79 的 toContain('toggleMcpServer') 由 onToggle 函数体满足
风险：
  - Windows 上杀软或编辑器保存时短暂锁文件（EBUSY/EPERM），会让这次启动期间整个 MCP 配置只读，直到重启。采纳 W1a-mcpstale 的 refresh 后可以自愈
  - 只有空白的文件按「可写的空配置」处理是个取舍：文件被截成 0 字节时原内容已经不在了，不存在再丢一次的问题
  - 与 W1b 的数据根写闸相关：agent 用 file_write 把 servers.json 写坏后，本项保证界面和市场不会再把它覆盖。两边的测试互不依赖
  - 路线图的「借鉴」一栏提到 pi 的 settings-manager「有 loadError 就不写」，那是 MIT 许可。只借思路、不抄代码，就不需要登记 NOTICE

## W1a-mcpedit [M]
行为：后端的合并语义、改名、试连预览、市场调用方适配。

【补丁语义】upsert 改为「以旧条目为底打补丁」：
- base = entries.get(renameFrom ?? name)。
- raw = encodeEntry(base)：把 save() 里单条序列化的代码（config.ts:155-170）抽出来，保证与写盘时同形。
- 对 input 的每个键：值为 undefined 视为没出现；值为 null 表示删除该键（也适用于 extra 键，例如 oauth:null）；其它值覆盖。env、headers、args 按整值替换，不做深合并，市场「移除未声明键」依赖这一点（install.ts:184）。
- 最后执行 decodeEntry(name, raw) 做归一和校验。

【传输类型切换】input 显式给出 transport 或 type（http 别名或 'stdio'），或者只给 command（判 stdio）、只给 url（判 http），并且与 base.transport 不同时，先从 raw 删掉旧族字段，再覆盖：stdio 族是 command、args、env、cwd；http 族是 url、headers。如果不先删，base 里的 command 会让 decodeEntry(:81) 把「改成远端」仍判成 stdio，url 又被 save 静默丢掉。

【enabled 与时间戳】
- input 里没有 enabled 或 disabled 键时保留旧值；给了 enabled 时先删 raw.disabled 再覆盖。
- createdAt 取 base 的值；没有 base 时用 input.createdAt ?? now。updatedAt 取 now。
- 原来 :199-204 对 extra 的特殊合并由通用逻辑吸收，可以删掉。

【改名】renameFrom 是控制键：
- 必须在 decodeEntry 之前从 input 里剥掉，否则会被 :99 收进 extra，写进 servers.json。
- 在原位置替换键名，一次 save 原子完成。
- 旧名不存在时抛「MCP server 不存在: X」；新名已被别的条目占用时抛「已存在同名 MCP server: Y」。
- 这样可以取代 SecMcp:55 的「先删后加」。

【试连预览】新增 preview(input)：走同一套合并与校验，不写盘，也不受 loadError 拦截。
- mcp.servers.test 带字段的分支改用 mcpServers.preview(p)，去掉 scratch 目录。编辑表单试连时，env、headers、cwd、startupTimeoutSeconds 会取自已存条目。
- 只带 {name} 的分支（index.ts:858-861）不变。

【错误文案】四句全部保持原样：「MCP server 名称不能为空」「command 必须是字符串」「url 必须是字符串」「xx 类型必须提供 url/command」。判定依据改为合并之后的 raw。

【市场】
- stdio 分支（install.ts:495）一律带上 env；merged.env 为空时传 env:null，显式清空。
- 远端分支已经带 transport:'streamable-http'，靠上面的族切换清掉旧的 stdio 字段。
- 用户设置的 note、cwd、startupTimeoutSeconds、enabled:false、extra 在重装时保留（见 open_questions）。
改动点：
  - src/minisd/mcp/config.ts:152-176 抽出 encodeEntry(e)，save 改为调用它
  - src/minisd/mcp/config.ts:183-211 upsert 拆成 private compose(input) 加 save：剥 renameFrom 和 undefined → 查 base → 改名冲突检查 → 推断目标传输类型并清旧族 → 覆盖，null 表示删除 → decodeEntry → 翻译错误 → 补时间戳
  - src/minisd/mcp/config.ts 新增 public preview(input): McpServerEntry，复用 compose，不写盘
  - src/minisd/mcp/config.ts 改名分支用 new Map 按原顺序替换键，再 save 一次
  - src/minisd/index.ts:862-870 改为 try { entry = mcpServers.preview(p) } catch → { ok:false, error }；:1 的 mkdtempSync 与 tmpdir 导入只有这里用，一并清掉
  - src/minisd/market/install.ts:495 改为 entry.env = Object.keys(merged.env).length > 0 ? merged.env : null（:488-496 的 stdio 分支）
先红：
  - tests/mcp-config-edit-preserve.test.ts（路线图指定的文件名）。种子数据两条：
- local：command 为 C:\Program Files\nodejs\node.exe；args 为 ['C:\Program Files\srv\index.js','--root','D:\My Docs']；env {TOKEN:'$$TOK',MODE:'x'}；cwd 'D:\work'；startupTimeoutSeconds 45；enabled false；note 'old'；oauth {p:'g'}
- remote：url 'https://mcp.example/api'；headers {Authorization:'Bearer $$TOK'}；enabled false；note 'r'
  - 同一文件：upsert({name:'local', note:'new'}) 之后，env、args（逐元素）、cwd、startupTimeoutSeconds、enabled=false、extra.oauth、createdAt 全部不变，只有 note 变成 'new'。现在会红：输入里没有 command，抛「stdio 类型必须提供 command」
  - 同一文件：upsert({name:'remote', note:'n2'}) 之后 headers 与 enabled=false 不变。现在会红，原因同上
  - 同一文件（模拟旧界面的载荷去掉 enabled）：upsert({name:'local', transport:'stdio', command:'npx', args:['-y','pkg']}) 之后 command、args 被替换，env、cwd、startupTimeoutSeconds、enabled=false、note 保留。现在会红：整条替换，env 等全部丢失，enabled 变回 true
  - 同一文件：删除标记。
- upsert({name:'local', note:null}) 后 note 为 undefined；
- {name:'local', oauth:null} 后 extra 为 undefined；
- {name:'local', env:null} 后 env 为 undefined。
现在会红：输入里没有 command，直接抛错
  - 同一文件（语义钉）：upsert({name:'local', env:{NEW:'1'}}) 后 env 精确等于 {NEW:'1'}，不与旧值合并。现在会红：抛「必须提供 command」
  - 同一文件：upsert({name:'local', transport:'streamable-http', url:'https://x'}) 后 transport 是 streamable-http，command、args、env、cwd 都是 undefined，note、enabled=false、startupTimeoutSeconds、extra 保留。现在会红：note 丢失，enabled 变成 true。反方向 remote → stdio 同理，headers 与 url 被清掉
  - 同一文件：upsert({name:'local', url:'https://x'})（只给 url）后切换为 http。现在会红：保留字段丢失
  - 同一文件：upsert({name:'local', enabled:true}) 后 enabled 为 true
  - 同一文件：改名。
- upsert({name:'local2', renameFrom:'local', note:'z'}) 后名单为 ['local2','remote']（位置不变）；local2 保留 local 的全部字段和 createdAt；读回的文件文本不含 'renameFrom'。现在会红：renameFrom 被收进 extra，旧的 local 还在，新条目又缺 command，直接抛错
- renameFrom:'local' 且 name:'remote' 时 toThrow(/已存在/)
- renameFrom:'ghost' 时 toThrow(/不存在/)
  - 同一文件（回归，现在是绿的）：upsert({name:'fresh', command:'x'}) 后 enabled 为 true，createdAt 等于 updatedAt
  - 同一文件：preview({name:'local', note:'q'}) 返回合并后的条目，但文件字节和 list() 都不变。现在会红：preview 方法还不存在
  - tests/mcp-test-rpc.test.ts 新增一例：b.call('mcp.servers.test', { name:'fixture-stdio', note:'x' }) 返回 ok:true 且 toolCount ≥ 1。现在会红：scratch store 里只有 {name, note}，秒回「stdio 类型必须提供 command」，不用等真连接超时
  - tests/market-update.test.ts 新增一例（回归钉，现在是绿的；如果只改 config.ts 不改 install.ts:495 就会红，所以要先写这条）：v2.0.0 带 env 安装，升到 registryEnv=[] 的版本后 entry.env 为 undefined
  - tests/market-update.test.ts 新增一例：先安装，再 mcpStore.toggle(name, false)，并用 upsert 写入 note，然后更新到新版本。断言 enabled 仍为 false、note 仍在。现在会红：整条替换，enabled 被重置为 true，note 丢失。这条是否保留要看 open_questions 第 4 条的决定
守卫：
  - tests/mcp-config.test.ts:148-159「更新只动 updatedAt，createdAt 与 extra 保留」在补丁语义下仍然绿
  - tests/mcp-config.test.ts:162-178 的校验文案：没有 base 时必须抛出同样的中文句子，不能改字
  - tests/mcp-config.test.ts:34-44 roundtrip 断言 Object.keys(raw) 为 ['mcpServers']，不受影响
  - tests/mcp-test-rpc.test.ts:61-67 断言 ephemeral 不落盘，preview 只要不写盘就是绿的；:78-84 badhttp 的错误要同时含「必须提供」和「url」
  - tests/market-update.test.ts:436-470：env 必须整值替换。实现成深合并时 :469 的 toEqual({ FETCH_MODE: 'fast' }) 会红
  - tests/market-install.test.ts:317-330（env 反向锚）与 :439-451（删后重装）：首次安装没有 base，不受影响
  - tests/mcp-manager.test.ts:77 的 seedStdio 用 upsert 新建条目，不受影响
风险：
  - 语义翻转：upsert 从「整条替换」变为「打补丁」，依赖「不传即清空」的调用方行为都会变。已知只有市场的 env（本项已处理）和 SecMcp 清空备注（界面需发 note:null，见 W1a-mcpedit-ui）
  - renameFrom 不迁移会话级禁用名单（sessions.mcp_disabled_json 存的是名字，chat-store.ts:40-46），也不迁移 market_installs.local_ref。改名后，这台服务器在原先禁用它的会话里会重新可用；market.installed（install.ts:514-521）会把登记行当孤儿删掉，市场的更新追踪随之丢失。这是现状（先删后加也一样），本项不会让它更糟
  - null 作为删除标记是新约定，只作用于 upsert 的输入。用户在 servers.json 里手写的 null 值，经 load 再 save 后的行为不变（decodeEntry 本来就忽略 null）
  - 在补丁语义下，用已有的名字「添加」会合并进旧条目，而不是覆盖它，界面必须拦住（见 W1a-mcpedit-ui 和 open_questions）

## W1a-mcpedit-ui [M]
行为：【抽出纯模块】把表单转载荷的逻辑抽成 src/renderer/src/lib/mcp/edit.ts。它在 typecheck 范围内，可以直接单测，与 lib/perm/copy.ts 同一种做法：
- argsToText(args)：args.join('\n')。
- textToArgs(text)：按 /\r?\n/ 切，每行 trim，去掉空行。
- buildMcpUpsert(orig, form)：
  - 新建（orig 为 undefined）：stdio 返回 {name, transport, command, args}，http 返回 {name, transport, url}；note 非空才带；不带 enabled。
  - 编辑：从 {name} 起步。名字变了加 renameFrom: orig.name。transport 变了，就带上 transport 和新族的完整字段。否则只带有变化的字段：command 与 orig 不同才带；参数框文本与 argsToText(orig.args) 不同才带 args（没动就不提交，参数里有换行这种没法按行表示的内容也安全）；url 同理；note 改成空时发 note:null，改成其它值时发该值。任何情况下都不带 enabled。

【SecMcp】
- 参数输入框（:141-145）换成 <textarea v-model="form.args" class="f-area">，提示改为「每行一个参数；带空格的路径原样写一行即可」。
- startEdit（:25-35）记下 orig 快照，参数用 argsToText 回填。
- 删掉 payload()（:38-49），submit 和 test 都改用 buildMcpUpsert(orig, form)。
- submit（:51-59）不再先调 removeMcpServer，改名交给 renameFrom。
- 新建时如果列表里已有同名条目，前端直接报「已有同名服务器「X」，请换个名字或编辑它」，不发请求。

【用户看到的效果】
- 只改备注并保存后，env、headers、cwd、startupTimeoutSeconds 和停用状态全部不变。
- 带空格路径的参数逐元素不变。
- 表单里试连会带上已存的 env。
改动点：
  - 新建 src/renderer/src/lib/mcp/edit.ts：argsToText、textToArgs、buildMcpUpsert，以及 McpForm、McpOrig 两个类型
  - src/renderer/src/ui/settings/SecMcp.vue:11 blank 不变；新增 const orig = ref<McpOrig|undefined>()；:24 startNew 置 orig=undefined
  - src/renderer/src/ui/settings/SecMcp.vue:25-35 startEdit：记 orig，:31 改为 argsToText
  - src/renderer/src/ui/settings/SecMcp.vue:38-49 删除 payload() 及其注释
  - src/renderer/src/ui/settings/SecMcp.vue:51-59 submit：先做同名检查（仅新建时），再 await chat.upsertMcpServer(buildMcpUpsert(orig.value, form))，删掉 :55
  - src/renderer/src/ui/settings/SecMcp.vue:69 test() 改用 chat.testMcpServer(buildMcpUpsert(orig.value, form))
  - src/renderer/src/ui/settings/SecMcp.vue:141-145 input 换成 textarea.f-area，同时改 hint
先红：
  - tests/renderer-mcp-edit.test.ts（新文件，直接 import ../src/renderer/src/lib/mcp/edit）：
- textToArgs('C:\Program Files\x\srv.js\r\n--flag\n\n') 精确等于 ['C:\Program Files\x\srv.js','--flag']
- textToArgs(argsToText(['a b','D:\My Docs'])) 与原数组逐元素相等
现在会红：模块不存在，import 失败
  - 同一文件：orig={name:'a',transport:'stdio',command:'npx',args:['x y'],note:'n'}，form 与 orig 完全一致时，buildMcpUpsert 结果精确等于 {name:'a'}（不含 enabled、args、command）
  - 同一文件：只改 note 时结果为 {name:'a', note:'m'}；note 清空时结果为 {name:'a', note:null}
  - 同一文件：只改参数框时结果带 args，且它是按行切出来的数组；改名为 b 时结果含 renameFrom:'a'；transport 改成 streamable-http 并填了 url 时，结果为 {name, transport:'streamable-http', url}
  - 同一文件：orig 为 undefined（新建）时，结果不含 enabled 键，args 按行切分
  - tests/renderer-mcp-settings.test.ts 新增 describe 'W1a 编辑不丢字段'（源码守卫，按调用形态断言，不认裸字符串）。现在全部会红：
- 匹配 /\.upsertMcpServer\(\s*buildMcpUpsert\(/
- 匹配 /\.testMcpServer\(\s*buildMcpUpsert\(/
- 含 <textarea v-model="form.args"
- 不匹配 /\.split\(\/\\s\+\/\)/
- 不匹配 /enabled:\s*true/
- 不匹配 /args[^\n]*\.join\(' '\)/
- 用 /async function submit\(\)[\s\S]*?\n}/ 截出 submit 函数体，其中不含 .removeMcpServer(
守卫：
  - tests/renderer-mcp-settings.test.ts:51-60 仍要求 SecMcp 含 testMcpServer、试连接、testResult、连上了、连不上，本改动都保留
  - tests/renderer-mcp-settings.test.ts:74-79 的 toContain('removeMcpServer') 由 remove()（:60-64）满足，submit 删掉调用也不会变红
  - tests/renderer-mcp-settings.test.ts:45-49 的空例注释写着「新页面没有 env/headers 编辑器」，本项不加编辑器，维持原状（W8c 才恢复）
  - tests/mu6-capability-wiring.test.ts:69-70 的 WIRED 两条要求 ui/ 下存在 .upsertMcpServer( 和 .testMcpServer( 调用，改后仍在
  - tests/mu6-capability-wiring.test.ts:144-150 的自守例要求「每个 store action 都有 ui 调用或 store 内部调用」。不要新增 renameMcpServer、previewMcpServer 之类的 store action，改名和预览都走现有 action 的参数
风险：
  - .vue 不在 typecheck 覆盖范围内。把逻辑放进 lib 下的纯模块，风险就挪到了可测的地方，SecMcp 只剩下接线，需要 xvfb 目视确认
  - 每行 trim 会去掉参数首尾有意留的空格（极罕见）；参数没改动时不提交，可以兜住这种情况
  - 旧条目的参数里如果本身有 \n，在文本框里会被拆成多行显示；用户一旦编辑参数，就会按行重新切分。这种情况可以接受，也可以在 startEdit 检测到后提示
  - 界面的同名检查只防渲染端；市场安装同名时仍会合并进已有条目（open_questions 第 5 条）

## W1a-mcpstale [S]
行为：（建议纳入 W1a。这是本次侦察发现的第四条丢数据路径，路线图的三条里没有它。）

【为什么要修】SecMcp.vue:38-39、:144 和 renderer-mcp-settings.test.ts:46-48 都明确告诉用户：env、headers 和带空格的参数请直接改 servers.json。但 store 只在构造时读一次盘（config.ts:117），save 会把内存副本整份写回。应用开着时手改了文件，只要在界面上随手启停任意一台、或者在市场装一个，手改的内容就被覆盖。

【改后行为】
- store 记住上一次读到或写出的磁盘文本 lastDiskText。
- upsert、remove、toggle 在 assertWritable 之前先调 syncFromDisk()：重新读文件（ENOENT 视为没有文件）。内容与 lastDiskText 不同时，清空 entries 和 loadError 并整份重新 load，然后在新读到的内容上应用这次改动；重新解析失败时进入 loadError，拒绝写入。
- 新增公开的 refresh()，在 mcp.servers.list 的处理器（index.ts:837）里先调一次。这样设置页每次打开都能看到磁盘现状，W1a-mcpcorrupt 的文案可以改为「修好后回到这页即可」，:83 那句「自动重读」也就成真了。
改动点：
  - src/minisd/mcp/config.ts 新增 private lastDiskText；在 load 读到的文本处和 save 的 :174-175（写入的 JSON 文本）处赋值
  - src/minisd/mcp/config.ts 新增 private syncFromDisk() 与 public refresh()，在 upsert、remove、toggle 首行调用（在 assertWritable 之前）
  - src/minisd/index.ts:837 mcp.servers.list 处理器先调 mcpServers.refresh()
先红：
  - tests/mcp-config-stale.test.ts：用 {a:{command:'x'}} 构造 store，然后在外部 writeFileSync 给 a 加上 env {T:'1'}、再加一条 b，执行 store.toggle('a', false)，再重开 store。断言 a.env 为 {T:'1'}、b 存在、a.enabled 为 false。现在会红：save 写的是旧的内存副本，env 和 b 都被覆盖掉了
  - 同一文件：构造之后在外部把文件写坏，执行 store.upsert({name:'z',command:'y'})。断言 toThrow(/servers\.json/) 且文件字节不变。现在会红：直接覆盖
  - 同一文件 RPC 例：minisd 启动后在外部追加一条 c，调 mcp.servers.list，断言 servers 里有 c。现在会红：不重读
守卫：
  - tests/mcp-manager.test.ts 全程只在内存里 upsert，没有外部写入，不受影响
  - tests/mcp-config.test.ts:46-55 的持久化例是「重开 store 读回」，不受影响
  - scripts/e2e-mcp-acceptance.mjs:48 在启动前预写 servers.json，不受影响
风险：
  - manager 在下一次 ensureForRun 就会看到外部改动，这本来就是「即时生效」的承诺；但已经连上的服务器不会重连（见 open_questions 第 8 条）
  - 外部写到一半时 refresh 可能读到半截文件，结果是 MCP 列表清空、写入被拒，文件修好后下一次 refresh 自愈
  - 每次 list 都读一次小文件，开销可以忽略

## W1a-mcpguards [S]
行为：【守卫与能力清单】不新增 store action：改名走 upsertMcpServer 的 renameFrom 参数，预览走 testMcpServer。因此 mu6 能力清单 WIRED 里的两条（mu6-capability-wiring.test.ts:69 upsertMcpServer / mcp.servers.upsert，:70 testMcpServer / mcp.servers.test）不用改，GAPS 仍为空。

【守卫落点】SecMcp 的守卫集中在 tests/renderer-mcp-settings.test.ts，新增两个 describe：
- 'W1a 配置损坏'：条目见 W1a-mcpcorrupt。
- 'W1a 编辑不丢字段'：条目见 W1a-mcpedit-ui。
两个 describe 都只认调用形态，写成 `.upsertMcpServer(buildMcpUpsert(` 这种，不认散文里出现的裸字符串，与 mu6:54-55 的 calls() 同一原则。

【真行为测试】真正的行为由纯模块测试 tests/renderer-mcp-edit.test.ts 和后端测试钉住，源码守卫只证明「调用写出来了」。

【README】README.md:28 的 MCP 行可以补上「编辑（只提交改过的字段）」，放到 W2b 核对能力表时顺手做。
改动点：
  - tests/renderer-mcp-settings.test.ts 追加两个 describe，只新增、不改动 :15-96 原有各例
  - tests/mu6-capability-wiring.test.ts 不改（:69-70 两条继续有效）
  - README.md:28（W2b 核对能力表时处理）
先红：
  - 见 W1a-mcpcorrupt 和 W1a-mcpedit-ui 两项中的 renderer-mcp-settings.test.ts 条目。自检方法：把 SecMcp 里的 buildMcpUpsert( 临时改名，守卫应当变红；只在注释里提到它的名字，守卫不应变绿
守卫：
  - tests/mu6-capability-wiring.test.ts:144-150：如果实现时新增了 store action 却没有在 ui/ 下调用，这条会红，要么接到 ui 上，要么登记进 GAPS
  - tests/renderer-mcp-settings.test.ts:29-32、:62-72、:74-79 的影响见各项分析；目前都可以不用重指
风险：
  - 源码守卫只能证明「写了调用」，证明不了「点下去后端真的收到了」。编辑、改名、试连这三条路径必须用 xvfb 目视确认

## W1a-mcplossy（可选） [S]
行为：【三处静默丢数据】load 读进来、save 写回去的过程中还有三处会静默丢数据，与路线图那三条路径属于同一类：
- (a) 解码失败的条目在 absorb（config.ts:136-140）被跳过，下一次任意保存时就从文件里消失，例如 command 写成 ["npx"]，或者还没写完、既没有 command 也没有 url 的草稿。
- (b) save 只写 {mcpServers}（:174），其它顶层键会丢，例如从 claude_desktop_config.json 整份粘进来的 globalShortcut、$schema。
- (c) asStringArray 和 asStringRecord（:48-57）会过滤掉非字符串的值，写成 "args": ["--port", 8080] 或 "env": {"PORT": 3000} 的配置，保存一次之后 8080 和 3000 就永久消失。

【改法】
- load 时把跳过的条目按原键保存原文，把顶层的其它键也存起来；save 时原样写回。识别出的条目按插入顺序写在前面，未识别的跟在后面。
- (c) 把有限的数字和布尔值转成字符串（String(v)），不再丢弃。
改动点：
  - src/minisd/mcp/config.ts:136-147 absorb：失败时存入 rawUnknown: Map<string, unknown>；在标准形态下，把 mcpServers 之外的顶层键存进 topExtra
  - src/minisd/mcp/config.ts:152-176 save：写 {...topExtra, mcpServers: {...识别条目, ...rawUnknown}}；识别条目和 rawUnknown 撞名时以识别条目为准
  - src/minisd/mcp/config.ts:48-57 asStringArray 与 asStringRecord：number 和 boolean 转成 String(v)
先红：
  - tests/mcp-config-corrupt.test.ts 追加三例。三例现在都会红：
- 种子 {mcpServers:{bad:{command:['npx']}, good:{command:'x'}}}，执行 toggle('good', false) 后，文件里 bad 原样还在
- 种子 {globalShortcut:'Ctrl+Q', mcpServers:{a:{command:'x'}}}，执行 upsert 后文件里仍有 globalShortcut
- 种子 args ['--port', 8080] 与 env {PORT: 3000}，执行 toggle 后读回为 ['--port','8080'] 和 {PORT:'3000'}
守卫：
  - tests/mcp-config.test.ts:109-117 只断言坏条目不出现在 list() 里，写回时保留原文不影响这两例
  - tests/mcp-config.test.ts:34-44 的种子只有 mcpServers 键，Object.keys(raw) 仍为 ['mcpServers']
风险：
  - 保留未识别的条目，意味着 list() 与文件内容不一致，界面上看不到这些条目。可以以后再在界面上提示「有 N 条无法识别，已原样保留」
  - 把数字转成字符串，会改变「数字参数被丢弃」这个旧行为。旧行为本身就是丢数据，没有任何测试钉住它

## open_questions
- Q: servers.json 损坏时，是拒绝一切写入，还是先把原文件改名为 servers.json.corrupt-<ts> 再按空配置写入？（路线图 W1a 两种都接受）
  推荐: 拒绝写入，这也是任务的要求。以后可以在横幅上加一个「把损坏的文件另存为 .corrupt 并从空白开始」按钮，那时再做改名。
  理由: 拒写最简单：原文件留在原位不动，不用多管理一类文件，用户修好之后也不用找备份。改名方案会让用户在不知情时看到一个「全新的空配置」，而且以后还得设计 .corrupt 文件怎么清理。
- Q: 0 字节或只有空白的 servers.json，按「可写的空配置」处理，还是按 parse 错误拒绝写入？
  推荐: 按可写的空配置处理，剥掉 BOM 之后也按同样的规则判断。
  理由: 文件里已经没有数据可丢了。拒写只会让用户卡住，他们得自己去删掉这个文件。
- Q: W1a-mcpstale（应用开着时手改 servers.json，之后任意一次保存都会覆盖手改内容）要不要纳入 W1a？还有，要不要在 mcp.servers.list 上 refresh？
  推荐: 纳入，规模 S。三个写方法前先对比磁盘内容，list RPC 也做 refresh。这样 SecMcp 里「回到这页会自动重读」就成了真话，拒写文案也可以改为「修好后回到这页即可」。
  理由: 目前 env、headers 只能手改 servers.json（renderer-mcp-settings.test.ts:46-48 和 SecMcp.vue:144 都这么指引用户），所以这条路径在 0.3.0 用户那里是高频的。它和另外三条同属「静默改坏配置」，路线图第 266 行把「MCP 配置被覆盖或抹掉」列为上架前必须修掉的缺陷。
- Q: 改成补丁语义之后，市场「更新」是否应当保留用户自己的 enabled:false、note、cwd、startupTimeoutSeconds、headers？现状是整条替换：更新一次，停用的服务器会被悄悄重新启用，备注也会丢。
  推荐: 保留，这是补丁语义自然得到的结果。只有两点特殊处理：env 一律显式传（为空时传 null，保住 mergeEnvForUpdate 的移除清理）；更换传输类型时清掉旧族字段。market-update.test.ts 补上对应的两例。
  理由: 「更新」修的是包的版本，用户自己的开关和备注不属于上游数据。现状下更新会重新启用用户停掉的服务器，这本身就是一种撒谎。
- Q: 在设置页用一个已存在的名字「添加」服务器时怎么办？（现状：整条覆盖旧条目，丢掉它的 env；改成补丁语义后：合并进旧条目，同样出乎意料。）
  推荐: 0.3.0 只在前端拦截，SecMcp 新建时对照 list 报「已有同名服务器」。后端不加 createOnly 之类的控制键。
  理由: mcp.servers.upsert 的调用方只有设置页和市场。市场同名时正是更新流程，合并语义正是它需要的。在前端拦截，零协议改动。
- Q: upsert 输入里的「删除某个键」用 null 表示还是空串表示？
  推荐: 用 null，与 JSON Merge Patch（RFC 7396）一致，也适用于 extra 键和 env。note:'' 仍按现状存成空串。
  理由: undefined 走 JSON-RPC 会被丢掉，表达不了「清空」；空串对 env、headers、args 又没有意义。null 是唯一一个在 JSON 里能用、对所有字段都说得通的删除标记。
- Q: mcp.servers.list 要不要增加 configErrorKind？
  推荐: 增加，但只在出错时带，取值为 'read'、'parse'、'shape' 之一，不要用 null。
  理由: 界面需要区分「格式错了，请改语法」和「读不到，请查权限或占用」两种情况；只在出错时带这个键，可以避免 mcp-config.test.ts:259、:276 的 toEqual 变红，而且枚举值不含原文，不会破坏脱敏红线（mcp-test-rpc.test.ts:87-105）。
- Q: 相邻发现，不在本分区：全局停用、删除或编辑一台已经连上的服务器，manager 不会断开或重连它（manager.ts:114-152 只连还没连上的服务器，执行器也不查 store 里的 enabled），工具要等 10 分钟空闲驱逐（manager.ts:55、:182-192）才下表。SecMcp.vue:80「改动即时生效，不用重启」对启停和编辑都不成立。这个归谁修？
  推荐: 归 W2a 或 W2b 的撒谎止血，由主控分配。最小改法有两步：一是执行器在调用时查 store 里的 enabled，停用了就拒绝，报「该 MCP server 已停用」，与会话级禁用同一手法，工具表不变、不碰前缀稳定性；二是在 mcp.servers.upsert、remove 的处理器里通知 manager 执行 forget(name)（dispose 并回到 idle），下一回合就会用新配置重连。
  理由: 编辑表单修好之后，用户改完 env 会自然期待「立刻生效」。现在要等 10 分钟或者重启才生效，W1a 修好的配置实际上用不上。直接摘工具又会碰到 W5c 的前缀稳定问题，所以停用优先做成调用时拒绝。
- Q: 改名（renameFrom）要不要同时迁移会话级禁用名单（sessions.mcp_disabled_json）和 market_installs.local_ref？
  推荐: 0.3.0 不迁移（保持现状，先删后加本来也不迁），在 CHANGELOG 里写明。等 W8a 或 W8c 做助手的 MCP 开关时统一改为按 id 引用。
  理由: 迁移要改 chat-store 和 market 两个子系统，还会碰到「0.3.0 前不加迁移」的纪律（虽然这只是改 JSON 列里的值、不改表结构）。本项的改动不会让现状更糟。
- Q: Windows 下，裸命令名（如 npx）会经 cmd.exe /d /s /c 包一层启动（stdio.ts:86-88），带空格的参数到子进程时还完整吗？
  推荐: W3 真机冒烟时加一条：参数里有 C:\Program Files\... 路径的服务器能正常试连。W1a 只保证配置层面逐元素不变。
  理由: Linux 上验证不了 cmd.exe 的引号规则。配置层修好之后，如果传给进程时又被拆开，用户看到的症状是一样的。

## files
- /home/user/Deskminis/deskminis/src/minisd/mcp/config.ts
- /home/user/Deskminis/deskminis/src/minisd/index.ts
- /home/user/Deskminis/deskminis/src/minisd/market/install.ts
- /home/user/Deskminis/deskminis/src/renderer/src/stores/chat.ts
- /home/user/Deskminis/deskminis/src/renderer/src/ui/settings/SecMcp.vue
- /home/user/Deskminis/deskminis/src/renderer/src/lib/mcp/edit.ts（新建）
- /home/user/Deskminis/deskminis/tests/mcp-config-corrupt.test.ts（新建）
- /home/user/Deskminis/deskminis/tests/mcp-config-edit-preserve.test.ts（新建）
- /home/user/Deskminis/deskminis/tests/mcp-config-stale.test.ts（新建，W1a-mcpstale）
- /home/user/Deskminis/deskminis/tests/renderer-mcp-edit.test.ts（新建）
- /home/user/Deskminis/deskminis/tests/renderer-mcp-settings.test.ts
- /home/user/Deskminis/deskminis/tests/mcp-test-rpc.test.ts
- /home/user/Deskminis/deskminis/tests/market-update.test.ts
- /home/user/Deskminis/deskminis/tests/market-install.test.ts
- /home/user/Deskminis/README.md（W2b 能力表核对时，第 28 行）

## xvfb
- servers.json 写坏后打开设置页的 MCP 一节：只出现一条红色横幅（不再两条叠在一起），「添加服务器」按钮隐藏，列表为空时不显示「还没有配置 MCP 服务器」
- servers.json 是目录或读不到时（read 类）：横幅文案是权限或占用的说明，不是「解析失败」
- 在市场上安装一个 MCP，同时 servers.json 已损坏：确认卡上的错误行显示中文拒写文案，文件没有被改动
- 编辑一台带 env 的 stdio 服务器：参数框是多行 textarea，一行一个参数，C:\Program Files\... 路径完整显示在一行；只改备注并保存后，重新打开编辑，参数逐行不变；列表行的开关仍保持原来的停用状态
- 表单里点「试连接」：对需要 env 的已存服务器显示「连上了，N 个工具」，不再因为缺 env 而连不上
- 改名：保存后列表里这一行原位换成新名字，位置不变，没有留下孤儿条目；改成一个已存在的名字时，在表单内显示中文错误
- 新建时用了已存在的名字：在表单内报「已有同名服务器」，不发请求
- 开关失败（例如启动后在外部把 servers.json 写坏，再去点开关）：错误行出现，勾选框回到原来的状态
- 把连接方式从 stdio 切到 streamable-http 并填好 URL 后保存：列表行显示 URL，再次编辑时是 http 表单