# minisd 工具层（W1a-edit / W1b-datagate / W1b-killtree / W1a-zip）

## facts
- 路径约定：下文相对路径均以 /home/user/Deskminis/deskminis 为根；THIRD-PARTY-NOTICES 在 /home/user/Deskminis/THIRD-PARTY-NOTICES.md（仓库根，不在 deskminis/ 内）。任务里写的 tools/terminal.ts 实际是 src/minisd/terminal.ts。
- [edit] src/minisd/tools/files.ts:118-123：readFileSync(utf8) → split 计数 → content.replace(oldStr, new_string)。字符串模式的 replace 仍会解释替换串里的 $ 序列，已用 Node 实测："X"→"$$5" 落成 "$5"；"$&!" 落成 "X!"；"[$']" 插入匹配之后的全文；"[$`]" 插入匹配之前的全文。
- [edit] BOM 现状：readFileSync(...,'utf8') 不剥 BOM。实测 EF BB BF 解码为 ﻿，writeFileSync 原样写回，所以 file_edit 现在是碰巧保住了 BOM，代码里没有显式处理。file_read（files.ts:67）会把 ﻿ 原样交给模型。
- [edit] CRLF 现状：files.ts:120 按原文匹配。CRLF 文件配 LF 的 old_string 计数为 0，返回「未找到」（实测）。new_string 里的换行原样写入，LF 的 new_string 写进 CRLF 文件后行尾就混了；反过来，CRLF 的 new_string 写进 LF 文件也会混。
- [edit] files.ts:118 用 utf8 读 GBK 或 UTF-16LE 文件后，任意一次 file_edit 都会把不可解码字节写回成 U+FFFD，属于同类静默损坏。files.ts:120 的 split 计数不计重叠出现（在 "aaa" 里找 "aa" 记 1 次，替换第 0 位）。old_string 为空串且文件为空时，''.split('') 算出 -1，最后把 new_string 前插到文件开头。
- [datagate] 目录布局 src/minisd/paths.ts:4-5：会话桶是 sessions/<id>/{workspace,attachments,offloads,browser}，全局目录是 memory、skills、shared、mcp-servers。dataRoot() 在 :9-13（DESKMINIS_DATA_DIR 优先，否则 %APPDATA%\DeskMinis）。resolveGuestPath 在 :42-64：盘符绝对路径在 :43 直接 resolve，不设围栏；/var/minis/<ns> 映射在 :45-53；其它以 / 开头的绝对路径在 :54-55 抛错，所以 Linux 上无法经工具表达宿主绝对路径；穿越检查在 :59-62。shared/ 在代码里没有任何使用方。
- [datagate] guardWrite 在 files.ts:27-33，guardRead 在 :43-49。只要路径在数据根内或 workspaceOf 内就一律免审。isInsideRoot（:18-21）只做词法 relative 判断，没有 realpath，也没有 8.3 短名、ADS、尾点尾空格的规范化。guardRead 的注释（:36-37）自己点名 minis.db 是外泄通道，代码却对整个数据根免审。
- [datagate] 数据根里的真实文件名：minis.db 及 -wal/-shm（WAL 模式见 store/db.ts:193，打开在 index.ts:235）；providers.json(.tmp)（provider-store.ts:102-109）；search-provider.json(.tmp)（search-provider-store.ts:22-29）；mcp-servers/servers.json(.tmp)（mcp/config.ts:114-115,174-175）；models-dev-cache.json(.tmp)（index.ts:260、model-catalog.ts:300）。配对与凭据文件：pairing-index.json 与 peer-addresses.json(.tmp)（remote/pairing.ts:166-167,197-215）；minisd-port.json(.tmp)，明文含 authToken（index.ts:102,169-174）；vault.json(.tmp)，只在 DESKMINIS_E2E 下出现（provider-store.ts:60-77）。密钥本体存 Windows 凭据库（KeyringVault，provider-store.ts:38-47），不落文件。
- [datagate] 推断 Electron userData 与数据根重合，需在 Windows 真机 dir 核对：electron-builder.yml:4 的 productName 是 DeskMinis，package.json:2 的 name 是 deskminis，main 进程没有调用 setPath/setName。所以 userData 就是 %APPDATA%\DeskMinis，也就是 dataRoot()。据此 Chromium 的 Local Storage、Network、Preferences 等和 update-prefs.json（main/index.ts:108）也都在数据根内。
- [datagate] 系统提示没有教模型用 file_write 写 skills 或 memory。STABLE_IDENTITY 见 agent/system-prompt.ts:11；技能块 skills/prompt.ts:57 给出 SKILL.md 的宿主绝对路径，:64 让模型用 shell ls，:67 要求 file_read 正文；记忆块 store/memory-injector.ts 只做读注入。不过设计上确实允许「agent 直写技能目录」：importer.ts:157-170 的 adoptOrphans、index.ts:368-369、importer.ts:208-214。scripts/e2e-m2c-acceptance.mjs:4,149 的注释写着「数据根内不弹权限卡」；该脚本对权限卡自动 allow-once（:86-90），功能不会坏，但注释会过时。
- [datagate] SOUL.md 以指令身份、不包裹地注入系统提示（memory-injector.ts:25-28），而 file_write /var/minis/memory/SOUL.md 目前免审。这是一条跨会话持久的提示注入通道，也是收窄 memory/ 写入最有力的理由。
- [datagate] memory_write 不经过 guardWrite：tools/memory.ts:13-15,72-73 直接调用 MemoryStore.appendDailyLog，日期经 DATE_RE 校验（memory-store.ts:9,59），只能写到 memory/YYYY-MM-DD.md。技能没有模型可调用的写工具，导入和删除都走 RPC，由用户发起。
- [datagate] office_read 与 office_write 复用 guardRead/guardWrite（office.ts:61-63,117-119），会自动跟随收窄。扩展名白名单（office.ts:92-95）使它写不出 providers.json。office_read 在权限闸之后没有复查取消（:61-64）。
- [datagate] 其它写路径都不经过 guardWrite，而且都是应用内部写入，不需要收：粘贴附件 main/index.ts:196-203；截图 bridge/handlers.ts:159-164，写当前会话的 attachments；卸载 agent/offload.ts:19-27；技能导入 importer.ts:188-202；MCP、provider、记忆各自的 store 自写。
- [datagate] search.ts:112-124 的 resolveBaseDir 只对基准目录判一次 guardRead，walkDir（search.ts:74）会一路下行。基准是数据根的祖先时（例如工作区绑到用户主目录），会顺带读到 servers.json 和其它会话的文件。
- [datagate] 权限链路：PermissionRequest 定义在 tools/types.ts:21，字段为 {kind, detail, sessionId, toolTitle, preview?}。网关判定在 permissions.ts:308-341，会话授权键是 会话+kind+detail（:314）。'full' 档对 file-write/file-read 全部 bypass（:273）。index.ts:307 广播整个 req，:308-309 审计时只剔除 preview。渲染端 chat.ts:10 定义 PendingPerm，:155-161 逐字段拷贝，新字段不显式拷贝就会丢。PermCard.vue:22-27 是 props，:60-63 是 detail 区；lib/perm/copy.ts 按 kind 出标题。
- [datagate] 钉住「数据根免审」的现有测试：files-tools.test.ts:57-62、:77-84、:208-213，写的都是当前会话 workspace 桶，收窄后仍免审；:129-150 绑定工作区、search-tools.test.ts:196-207 也一样。skills-rpc.test.ts:120-137 经 FakeProvider 调 file_read /var/minis/skills/<id>/SKILL.md，要求不弹卡并计数，所以读 skills 必须继续免审。没有任何 vitest 断言写 skills/memory/mcp-servers 免审。
- [baseline] 本分区在 Linux 上属于 52 例 Windows-only 基线的共 24 例：files-tools 10 例、search-tools :208 1 例，都因 paths.ts:54-55 拒绝 POSIX 绝对路径；shell.test.ts 13 例，因为没有 powershell。已实跑：shell.test.ts 13 败 6 过；files-tools 加 search-tools 共 11 败 37 过；mcp-stdio、skills-import、renderer-permcard 共 55 例全过。
- [killtree] shell.ts:61 和 terminal.ts:74 都用裸名 'powershell.exe' 启动，cwd 是工作区（shell.ts:62；terminal.ts:75,138），没有 windowsHide。interrupt、超时、dispose 都只对直接子进程 kill('SIGKILL')（shell.ts:125,151,156；terminal.ts:97）。终端没有 interrupt 和超时，只有 dispose（terminal.ts:95-99；调用点 index.ts:520 与 :1214）。ShellManager 没有按会话 dispose（shell.ts:159-178），chat.sessions.delete 只销毁终端（index.ts:517-522）。
- [killtree] 裸名配合 cwd 等于工作区，存在劫持面。按 libuv win/process.c search_path 的语义，裸文件名先在子进程 cwd 里查找，再查 PATH；工作区根目录（比如克隆来的仓库）里如果放了 powershell.exe，就会被执行。这是推断，需 Windows 真机复现。同类裸名还有：mcp/stdio.ts:89 的 'cmd.exe'（cwd 来自配置）、bridge/handlers.ts:52 的 'powershell.exe'（无 cwd，已有 windowsHide，超时路径 :67-68 仍只做 SIGKILL）、bridge/server.ts:64 和 market/install.ts:256 的 'where.exe'。
- [killtree] mcp/stdio.ts:109-122 的 killTree 在 win32 下调用 spawnImpl('taskkill', ...)，用的是裸名，没有 windowsHide，随后 :121 立刻同步 child.kill()。根进程很可能在 taskkill 枚举进程树之前就已被终止，/T 找不到 pid，孙进程照样残留（推断）。平台与 spawn 通过函数尾部默认参数注入（:62-69、:109-113），测试成例见 mcp-stdio.test.ts:217-258、:278-299。另一种现有做法是 vi.mock('node:child_process')（market-install.test.ts:19-21），但它改不了 process.platform，所以推荐沿用参数或构造注入。
- [killtree] pi 的参考实现（MIT，/home/user/refs/pi-mono/packages/coding-agent/src/utils/shell.ts:216-245）：win32 下调用 join(SystemRoot ?? 'C:\\Windows','System32','taskkill.exe')，参数 /F /T /PID，带 windowsHide 与 detached，用 once('error') 吞掉错误，并且不再补杀根进程。edit 相关在 core/tools/edit-diff.ts:11-25 与 edit.ts:190-197：先 splitBom，再整文件归一为 LF，最后按首个行尾整体还原；edit-diff.ts:306-307 对 old/new 同样归一为 LF。
- [zip] importer.ts:69-117 的 unzipToMemory 没有任何上限，:84 对每个条目 openReadStream 并全量读入内存。它的调用方有两个：importer.ts:223 的 importZip（技能 zip 导入，以及市场安装 install.ts:431-438 经 runImport('zip') 走到这里），和 market/install.ts:369 的 planSkill，后者直接调用。市场下载只限制压缩体积 32MB（install.ts:35），解压后不设上限。
- [zip] office/zip.ts 实际只有两道闸，不是三道：MAX_ENTRIES=2000（:14，在 :109 计数，而且是跳过目录项和穿越项之后才计）；MAX_TOTAL=64MB（:15，在 :110-111 按 entry.uncompressedSize 累计，发生在 openReadStream 之前）。没有单文件上限，也没有按实际字节做流式把关，这部分靠 yauzl 2.10.0 默认开启的 validateEntrySizes（node_modules/yauzl/index.js:30,553-554,641-647 的 AssertByteCountStream，实际字节超过声明值就报错）。stored 条目如果声明尺寸与实际不符，yauzl 在 entry 事件之前就会报错（index.js:408），所以伪造尺寸的测试必须用 deflate 条目。office/zip.ts:36 的 writeZip 零依赖，可以直接造 deflate 包。

## W1a-edit [S]
行为：改后行为：
1. 替换改为 indexOf+slice 拼接，new_string 逐字落盘，$$、$&、$'、$` 不再有特殊含义。
2. 读取改为 Buffer 读入后按 utf8 解码。若 Buffer.from(text,'utf8') 与原字节不等，说明文件不是 UTF-8，直接拒绝，文件字节不动（此条待拍板，见 open_questions）。文案：「该文件不是 UTF-8 编码（可能是 GBK 或 UTF-16），file_edit 会损坏它；请改用 shell_execute 或 file_write 整体重写」。
3. BOM：先 splitBom，在去掉 BOM 的正文上匹配；old_string 开头若带 ﻿ 也一并剥掉；写回时补回 BOM。现状已碰巧保持，改后变成显式保持。
4. 行尾：先按首个换行判定文件行尾（首个是 \r\n 就算 CRLF，没有换行按 LF）。old_string 与 new_string 都先把 \r\n 归一成 \n，然后在正文的 \r\n→\n 归一视图里找匹配。命中区间 [start,end) 映射回原文偏移：每个由 \r\n 归一来的 \n 在原文多占 1 位。只替换这个区间，替换文本按文件行尾还原（CRLF 文件把 \n 换回 \r\n），区间外字节一律不动。这一点和 pi 不同：pi 会把混合行尾的文件整体统一。
5. old_string 或 new_string 自带 CRLF 时：一律先归一为 LF 参与匹配；new_string 写回时用文件的行尾，不会把混合行尾带进文件。
6. 唯一性：取 first=indexOf(old)，再用 indexOf(old, first+1) 查第二处，重叠出现也算第二处。文案沿用「old_string 出现 N 次，必须唯一。请提供更长的上下文。」，保证现有测试断言的 '2' 仍在。
7. old_string 归一后为空时拒绝：「old_string 不能为空；新建或整体覆盖请用 file_write」。
8. 纯 LF 文件除了 $ 的修复和 CRLF new_string 被归一以外，行为与现在逐字节一致。权限预览（files.ts:111-114）不变。
改动点：
  - src/minisd/tools/files.ts:118-123：改为 readFileSync(abs) 取 Buffer，做 UTF-8 往返校验，再依次 splitBom、归一匹配、偏移映射、slice 拼接，最后写回 bom+结果
  - 把编辑逻辑抽成纯函数，例如 applyExactEdit(text, oldStr, newStr) → {text} | {error}，放在 files.ts 顶部或新文件 src/minisd/tools/edit-text.ts。文件头注明借鉴 pi edit-diff.ts:11-25 与 edit.ts:190-197（MIT），并在 /home/user/Deskminis/THIRD-PARTY-NOTICES.md 登记
  - src/minisd/tools/files.ts:102（可选）：file_edit 的描述补一句「CRLF 文件可用 LF 写 old_string；写回保持原行尾与 BOM」
先红：
  - 新建 tests/file-edit-dollar.test.ts：用工作区相对路径和 AllowAll 网关，Linux 可跑
  - ① 'price: X' 替换成 'cost $$5'，读回字节应为 'price: cost $$5'。现在落成 '$5'，红
  - ② new_string 为 '$&-$`-$\''，落盘应逐字相等。现在会插入原文，红
  - ③ CRLF 文件 'a\r\nb\r\nc\r\n'，old 'a\nb'，new 'x\ny'：应成功，字节为 'x\r\ny\r\nc\r\n'。现在报「未找到」，红
  - ④ CRLF 文件改单行 'a' 为 'x\ny'：应得 'x\r\ny\r\nb\r\nc\r\n'。现在写成混合行尾，红
  - ⑤ LF 文件 'a\nb\n'，old 'a\r\nb'，new 'q\r\nr'：应得 'q\nr\n'。现在报「未找到」，红
  - ⑥ BOM 加 CRLF：EF BB BF + 'hello\r\nworld\r\n'，old 'hello\nworld'，new 'hi\nall'：前三字节仍为 EF BB BF，正文为 'hi\r\nall\r\n'。因为 CRLF 现在红。另加一例纯 BOM+LF，现状就是绿的，作为回归守卫，提交时申报「非先红」
  - ⑦ 混合行尾 'a\r\nb\nc\r\n' 只改 'b'：其余字节不变（新增守卫）
  - ⑧ 在 'aaa' 里改 'aa'：应失败并提示不唯一。现在静默替换第 0 位，红
  - ⑨ 空文件，old ''：应失败。现在会前插，红
  - ⑩（若拍板纳入）GBK 字节文件 [C4 E3 BA C3 0A]，old '\n'：应失败且文件字节不变。现在写回 U+FFFD，红
守卫：
  - tests/files-tools.test.ts:30-38「file_edit 唯一匹配替换; 多处匹配报错」断言输出含 '2'：保持「出现 N 次」文案就不会翻红
  - tests/files-tools.test.ts:200-206 file_edit 预览：属 Linux 基线失败例，预览逻辑不动
  - tests/diff.test.ts:94 extractEditPair：只解析参数，不受影响
风险：
  - 偏移映射错一位就会写坏文件。需要覆盖这些边界：匹配在首行或末行、old_string 以换行结尾、文件以 \r\n 结尾、文件只有一行
  - 拒绝非 UTF-8 后，以前看似能改（其实在改坏）的 GBK 文件会被拒；文案要给模型指出替代做法
  - 把重叠出现也算作不唯一后，极少数以前能成功的编辑会被要求提供更长的上下文
  - file_write 写回会丢 BOM、file_read 会把 ﻿ 交给模型，这两个问题不在本项

## W1b-datagate [M]
行为：新增纯函数 dataGate(abs, {root, sessionId, workspace}, op: 'read'|'write', platform = process.platform)，返回 free、deny(reason) 或 ask(note?) 之一。guardWrite 和 guardRead 先过它：deny 直接返回拒绝串，不进网关，'full' 档也照拒；free 直接放行；ask 进网关，kind 不变，另带 note。

判定顺序：数据根规则优先于工作区规则，所以工作区绑到数据根或它的祖先时，仍按数据根规则判。

（A）先规范化。abs 和 root 都取 realpath；abs 不存在时，对最近一个存在的祖先做 realpathSync.native，再拼回剩余段。win32 下对每段：转小写，剥掉 ':' 起的流名（ADS），剥掉尾部的 '.' 和空格。

（B）写入，abs 在数据根内时：
· 硬拒：根层的 providers.json、search-provider.json、minis.db 及 -wal/-shm/-journal、pairing-index.json、peer-addresses.json、minisd-port.json、vault.json，以及它们各自的 .tmp。W1b 单实例锁文件落地后也加进来。文案：「写入被拒绝：<abs> 是 DeskMinis 的核心数据（模型与密钥配置 / 会话数据库 / 配对与连接凭据），agent 不能修改。如需调整，请让用户在设置里操作。」
· 免审：sessions/<当前会话>/{workspace,attachments,offloads,browser}/**、shared/**。
· 走卡，note 写「将修改应用配置」：mcp-servers/**（后缀「：MCP 配置里的命令会在下次连接时执行」）、skills/**（后缀「：技能」）、memory/**（后缀「：记忆，SOUL.md 会成为今后所有会话的指令」）。
· 走卡，note 写「将修改其它会话（<id>）的文件」：sessions/<其它会话>/**。
· 其余（数据根本身、sessions/ 本身、models-dev-cache.json、update-prefs.json、Chromium 配置等）走卡，note 写「将修改 DeskMinis 的应用数据」。

（C）读取，abs 在数据根内时：
· 免审：当前会话各桶、shared/、skills/（SKILL.md 的读取和计数依赖它）、memory/。
· 走卡：minis.db*，note「将读取 DeskMinis 会话数据库（含全部会话内容）」；sessions/<其它>/**，note「将读取其它会话（<id>）的文件」；mcp-servers/**，note「将读取 MCP 服务配置（可能含密钥）」（待拍板）；其余根层文件，包括 minisd-port.json 等凭据文件，note「将读取 DeskMinis 的应用数据」。

（D）不在数据根内、但在绑定工作区内：免审，与现在一致。两者都不在：维持现状，kind 为 file-write 或 file-read，走卡，不带 note。

PermissionRequest 新增可选字段 note?: string。kind 不变，所以档位、会话授权键、标题映射都不用动；preview 仍然只放差分。

搜索三件套：基准目录按同一规则判定。若数据根落在基准之内，且基准本身不在数据根内，walkDir 跳过数据根子树，并在尾注写「[已跳过 DeskMinis 数据目录]」（待拍板）。

渲染端：权限卡在路径区之后显示 note，整句换行、不截断、用警示色。
改动点：
  - src/minisd/tools/files.ts:17-21：isInsideRoot 旁边新增规范化函数和 dataGate，并导出 dataGate 供测试直接调用
  - src/minisd/tools/files.ts:27-33 guardWrite、:43-49 guardRead：先调 dataGate，deny 直接返回，ask 把 note 带进 ctx.permissions.check；同时重写 :23-26、:35-42 的注释
  - src/minisd/tools/types.ts:21：PermissionRequest 加 note?: string，并在 :16-19 的注释里说明 note 与 preview 的分工
  - src/minisd/paths.ts:4-7：导出 SESSION_BUCKETS 和 GLOBAL_DIRS，让 dataGate 复用，避免重复写常量
  - src/minisd/tools/search.ts:74：WalkDirOptions 加 skipDirs；:112-124 的 resolveBaseDir 算出要跳过的数据根并传下去
  - src/renderer/src/stores/chat.ts:10 PendingPerm 加 note?: string；:155-161 push 时加 note: req.note
  - src/renderer/src/ui/PermCard.vue:22-27 props 加 note；在 :60-63 的 .args 之后加 <div v-if="perm.note" class="note">{{ perm.note }}</div>，样式不得用 text-overflow: ellipsis
  - scripts/e2e-m2c-acceptance.mjs:4,149：注释改为「会弹卡，脚本自动 allow-once」
  - src/minisd/index.ts 不用改：:307 广播整个 req，note 自动带上；:308-309 审计里带上 note 也无妨
先红：
  - 新建 tests/data-root-write-gate.test.ts，用记录请求的 DenyAll/AllowAll 假网关。因为 paths.ts:54-55 在 Linux 上拒绝 POSIX 绝对路径，涉及宿主绝对路径的用例直接调用导出的 guardWrite、guardRead、dataGate
  - ① file_write '/var/minis/mcp-servers/servers.json'：应弹 1 卡，kind=file-write，note 含「将修改应用配置」，文件未生成。现在免审直接写，红
  - ② file_write '/var/minis/skills/x/SKILL.md'、file_write '/var/minis/memory/SOUL.md'、file_edit 记忆文件、office_write '/var/minis/skills/x/a.docx'：各弹 1 卡。现在都免审，红
  - ③ 对 f ∈ {providers.json, providers.json.tmp, search-provider.json, minis.db, minis.db-wal, minis.db-shm, pairing-index.json, peer-addresses.json, minisd-port.json, vault.json} 调 guardWrite(join(root,f))，网关用 AllowAll：应返回含「核心数据」的拒绝串，网关 0 次调用。现在返回 undefined，红
  - ④ 同 ③，但网关换成 new PermissionGatewayImpl(async()=>'allow-once') 并 applyPreset('full')：仍应拒绝。现在放行，红
  - ⑤ guardRead(join(root,'minis.db'))：应弹卡，kind=file-read，note 含「数据库」。guardRead 与 guardWrite 作用于 join(root,'sessions','S2','workspace','x.txt')：应弹卡，note 含「其它会话」。现在都免审，红
  - ⑥ paths.setWorkspaceResolver(()=>root)，也就是把工作区绑到数据根，然后 file_write 相对路径 'providers.json'：应拒绝。现在因为「在工作区内」免审，红
  - ⑦ symlinkSync(root, L) 后调 guardWrite(join(L,'providers.json'))：应拒绝且不进网关。现在当作根外路径走卡，红
  - ⑧ dataGate 纯函数，platform='win32'，root='C:\\X\\DeskMinis'：'…\\Providers.JSON'、'…\\providers.json.'、'…\\providers.json '、'…\\providers.json::$DATA' 都应判 deny。函数现在不存在，红
  - ⑨ 免审守卫（现状即绿，申报非先红）：file_write 到 /var/minis/workspace/a.txt、/var/minis/shared/a.txt、/var/minis/attachments/a.png、/var/minis/offloads/x.txt 均零卡；file_read /var/minis/skills/x/SKILL.md、/var/minis/memory/GLOBAL.md 均零卡
  - ⑩（若拍板纳入）工作区解析到 root 的父目录，在 root/mcp-servers/servers.json 里放 NEEDLE，执行 file_grep NEEDLE：结果不应含该文件，并带跳过尾注。现在会命中，红
  - tests/renderer-permcard.test.ts 追加守卫，断言调用形态而不是裸字符串：chatTs 中 rpc.on('permission.request' 处理器的切片应匹配 /note:\s*req\.note/；PendingPerm 应匹配 /note\?:\s*string/；permCard 的 <template> 切片里，/v-if="perm\.note"/ 应位于 class="args" 之后，且有 {{ perm.note }} 插值。现在都不存在，红
守卫：
  - tests/files-tools.test.ts:57-62、:77-84、:208-213：都是当前会话 workspace 桶，收窄后保持免审，不翻红
  - tests/files-tools.test.ts:129-150 与 tests/search-tools.test.ts:196-207：绑定工作区在数据根外，不翻红
  - tests/search-tools.test.ts:223 断言 detail 等于基准绝对路径：note 必须单独成字段，不能拼进 detail（该例属 Linux 基线失败例）
  - tests/skills-rpc.test.ts:120-137：前提是读 skills 免审；收了就会超时翻红，所以不能收
  - tests/permission-audit.test.ts:114-135：审计只剔除 preview，多出 note 不影响断言
  - tests/renderer-chat-capabilities.test.ts:31-37：PermCard 不得出现 text-overflow: ellipsis，note 行也要整句换行
  - tests/renderer-permcard.test.ts:145-160 断言 preview 位于 .args 之后：note 行也放在 .args 之后，不冲突
  - scripts/e2e-m2c-acceptance.mjs:4,149（不在 vitest 内）：注释会过时，需同步改
风险：
  - 和 W2b「权限卡按会话区分」同时改 chat.ts:155-161，会有合并冲突。本项只加 note 一个字段，后合入的一方保留两边的改动
  - 和 W1b 单实例锁同改数据根：锁文件名要加进硬拒表，需与那个分区对齐命名
  - 'full' 档下走卡类写入仍会静默放行，因为 kind 仍是 file-write。不过 full 档本来就放行任意 shell，这张卡在 full 下构不成额外边界（见 open_questions）
  - 本项只收紧文件工具。shell 只读白名单（permissions.ts:40-51，readonly=bypass 见 :223）仍能用 Get-Content、type、rg 静默读 minis.db、servers.json、minisd-port.json；不加引号的 $env:APPDATA 路径也能通过 readonlyQuotesSafe（permissions.ts:102-113）。所以「读取 minis.db 走卡」对 shell 不成立
  - realpath 让每次文件操作多一次 fs 调用。root 必须同样取 realpath，否则 Linux 的 tmp 链接或 Windows 重定向的 AppData 会让所有路径都被判成根外
  - agent 直写技能（importer.ts:157-170 的设计）会变成每个新文件一张卡，因为「本会话允许」只按精确路径记忆（permissions.ts:314）
  - Chromium profile 与数据根重合只是推断。即使不重合也不影响规则，这些文件会落进「其余」分支

## W1b-killtree [M]
行为：新建模块 src/minisd/proc/win-exec.ts，名字可议，包含四个函数：
· systemRoot(env)：依次取 env.SystemRoot、env.SYSTEMROOT、env.windir；值必须形如 ^[A-Za-z]:\\，否则回落 'C:\\Windows'。
· system32(name, env)：path.win32.join(systemRoot,'System32',name)。一定要用 path.win32，Linux 测试上才能得到反斜杠。
· powershellPath(env)：path.win32.join(systemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe')。
· killTree(child, {platform, spawnImpl, env, signal})：win32 且有 pid 时，spawnImpl(system32('taskkill.exe'), ['/pid', pid, '/T', '/F'], {stdio:'ignore', windowsHide:true})。只有在 taskkill 触发 'error'、以非 0 退出，或 spawn 同步抛错时，才用 child.kill() 兜底，不再同步先杀根进程，避免 /T 扑空。非 win32 直接 child.kill(signal)。

PersistentShell、ShellManager、TerminalSession、TerminalManager 的构造都加可选注入 {platform?, spawnImpl?, sysEnv?}。win32 下用 powershellPath 的绝对路径启动；非 win32 仍用 'powershell.exe'，保证 Linux 基线上的失败和通过逐例不变。spawn 选项统一加 windowsHide:true。interrupt、超时、dispose 都改为调用 killTree，其余语义不变：立即 this.proc=undefined，interrupt 置 wasReset=true，队列与 wasReset 提示照旧。

mcp/stdio.ts 的 killTree 改为从新模块 re-export，签名兼容，只加一个可选的第 4 参 env，于是 taskkill 也用绝对路径并带 windowsHide。spawnMcpProcess 里的 'cmd.exe' 同样改成 System32 绝对路径加 windowsHide（待拍板）。

可选：bridge/handlers.ts 的 runPowerShell 也改用 powershellPath，超时路径改调 killTree。
改动点：
  - 新增 src/minisd/proc/win-exec.ts，导出 killTree、systemRoot、system32、powershellPath。文件头注明借鉴 pi utils/shell.ts:216-245（MIT），并在 /home/user/Deskminis/THIRD-PARTY-NOTICES.md 登记
  - src/minisd/tools/shell.ts：:1 改 import；:56 构造函数加 opts；:61-64 改 spawn 路径并加 windowsHide；:151 interrupt 与 :156 dispose 改调 killTree；:159-170 ShellManager 透传 opts
  - src/minisd/terminal.ts：:2 改 import；:53 构造函数加 opts；:74-76 改 spawn；:97 dispose 改调 killTree；:105-110 与 :138 TerminalManager 透传 opts
  - src/minisd/mcp/stdio.ts：:89 cmd.exe 改绝对路径并加 windowsHide；:104-122 killTree 改为 re-export 新实现
  - （可选）src/minisd/bridge/handlers.ts:52-55 改用 powershellPath，:67-68 超时改调 killTree
  - src/minisd/index.ts:336-340 的构造处不用改，默认参数就是生产行为
先红：
  - 新建 tests/shell-kill-tree.test.ts，Linux 可跑。假 child 用 EventEmitter，stdin/stdout/stderr 是 PassThrough，带 pid=4242、exitCode=null、killed=false 和一个计数的 kill；假 spawnImpl 记录 {cmd, args, opts}
  - ① new PersistentShell(cwd, undefined, {platform:'win32', spawnImpl, sysEnv:{SystemRoot:'C:\\Windows'}}).run('x')，不 await：calls[0].cmd 应为 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'，path.win32.isAbsolute 为真，opts.windowsHide===true。现在走真 spawn 裸名、假 spawn 没被调用，红
  - ② 接着调用 interrupt()：calls[1] 应为 {cmd:'C:\\Windows\\System32\\taskkill.exe', args:['/pid','4242','/T','/F']}，windowsHide 为 true；child.kill 同步调用 0 次；假 taskkill emit('exit',1) 之后 child.kill 变为 1 次。红
  - ③ dispose()：形态同 ②。红
  - ④ run('x', 50) 超时：50ms 后出现 taskkill 调用，结果 exitCode=124。红
  - ⑤ new TerminalSession(cwd, emit, {}, {platform:'win32', spawnImpl, sysEnv}).attach()：应用 powershell 绝对路径并带 windowsHide；dispose() 应走 taskkill /T /F。红
  - ⑥ killTree(child,'win32',spawnImpl,{SystemRoot:'D:\\Win'})：cmd 应为 'D:\\Win\\System32\\taskkill.exe'。SystemRoot 缺失或不是盘符形式时，应为 'C:\\Windows\\System32\\taskkill.exe'。现在是裸名，红
  - ⑦ taskkill 的 spawn 同步抛错，或 emit('error')：child.kill 兜底 1 次且不抛。现在是先无条件同步 kill，「由 error 触发兜底」的断言会红
  - ⑧ platform='linux'：不起 taskkill，child.kill('SIGKILL') 1 次（守卫）
  - ⑨（若纳入）spawnMcpProcess('npx',[...],{env:{}},'win32',spawnImpl)：cmd 应为 'C:\\Windows\\System32\\cmd.exe'。现在是 'cmd.exe'，红
守卫：
  - tests/mcp-stdio.test.ts:279-290 断言 cmd 是裸名 'taskkill'，且同步 killed===1：要重指为绝对路径加 error/非 0 兜底语义，属有意翻红，提交里申报
  - tests/mcp-stdio.test.ts:217-231 断言 calls[0].cmd==='cmd.exe'：cmd.exe 改绝对路径的话要重指
  - tests/mcp-stdio.test.ts:292-299 非 win32 分支的 child.kill 次数：保持 child.kill 语义就不翻
  - tests/shell.test.ts 全文件（Linux 上 13 败 6 过）：非 win32 保持裸名 spawn，Linux 上的失败和通过集合不变。Windows 真机上要确认 :53-60 超时和 :94-115 interrupt 两例在 taskkill 异步收尾后仍能按时 resolve
  - tests/terminal.test.ts（startMinisd 起真 powershell，Windows-only）：:115-137 删会话后销毁终端，改成异步杀进程树后仍要立即停止 emit
  - tests/workspace-picker.test.ts:75-81 源码守卫要求 shell.ts 与 terminal.ts 仍含 workspaceOf(：不动 cwd 就不翻
  - tests/bridge-handlers.test.ts:250（真 powershell，Windows-only）：若改 runPowerShell，需在真机复跑
风险：
  - windowsHide 也就是 CREATE_NO_WINDOW，在这种模式下驱动脚本里的 [Console]::OutputEncoding 和 chcp 65001 是否正常，需要 Windows 真机确认。bridge/handlers.ts:52-55 已经带 windowsHide 跑同类脚本，可作旁证
  - 不再同步杀根进程以后，taskkill 启动的几百毫秒里旧驱动仍然活着，'close' 事件会晚到。超时路径已先 resolve(124)，interrupt 路径靠 'close' 结算，所以 taskkill 失败时必须兜底 kill，否则可能悬挂
  - close()（index.ts:1214）之后进程立即退出，异步的 taskkill 可能来不及跑。按 libuv 在 Windows 上把非 detached 子进程放进 KILL_ON_JOB_CLOSE 作业的行为（推断），minisd 退出时整棵树会被系统回收，所以退出路径不设 detached
  - 32 位 Electron 跑在 64 位系统上时，System32 会被重定向到 SysWOW64，拿到的是 32 位 powershell，可以接受
  - ShellManager 没有按会话 dispose（shell.ts:159-178）。W1b「删除运行中会话」的分区如果需要释放 shell，得新增 dispose(sessionId)，和本项改同一个文件，需协调

## W1a-zip [S]
行为：office/zip.ts 导出一套共享闸：沿用 ZIP_MAX_ENTRIES=2000 与 ZIP_MAX_TOTAL=64MB（:14-15），新增单文件上限 ZIP_MAX_ENTRY，并提供 createZipBudget(limits)，负责条目数、单条目声明尺寸与累计总量、流式实际字节三类检查。readZip 改用这套预算，office 的单文件上限取总量值 64MB，行为不变。

unzipToMemory(buf, limits = SKILL_ZIP_LIMITS)，技能的默认值建议是 2000 条、64MB 总量、32MB 单文件，按以下顺序把关：
① openZip 之后先看 zf.entryCount，超过上限直接拒绝，一个条目都不读。
② 在 'entry' 回调里、openReadStream 之前：条目计数（含目录项）超限、entry.uncompressedSize 超过单文件上限、累计 uncompressedSize 超过总量上限，任一成立就 settle(reject)。
③ 在 readEntry 里逐块累加实际字节，超过该条目的声明值、单文件上限或剩余总额时，先 rs.destroy() 再 reject。这是 yauzl validateEntrySizes 之外的第二道闸。

文案：
· 「技能包条目过多（超过 2000 个），已拒绝导入」
· 「技能包解压后总大小超过 64MB，已拒绝导入」
· 「技能包内文件 <name> 解压后超过 32MB，已拒绝导入」

market/install.ts:369 的 planSkill 和 importZip 自动受保护，调用点不用改。包装目录剥离、zip-slip 丢弃，以及遇到穿越项时的硬停吞错（importer.ts:94-97）都不变。
改动点：
  - src/minisd/office/zip.ts:14-15：常量改为导出，新增 ZIP_MAX_ENTRY 与 createZipBudget；:105-118 readZip 改用预算，逻辑与原来等价
  - src/minisd/skills/importer.ts：:51-53 openZip 返回后检查 zf.entryCount；:55-63 readEntry 加字节预算，超限时先 rs.destroy() 再 reject；:69 签名加 limits 参数；:79-89 entry 回调里在 openReadStream 之前加三道闸
  - src/minisd/market/install.ts 不用改：:369 和 :431-438 走的都是同一个函数
先红：
  - 新建 tests/skill-zip-bomb.test.ts。用 office/zip.ts 的 writeZip 造 deflate 包，注入小的 limits，避免真的吃内存；用 vi.spyOn(yauzl.ZipFile.prototype,'openReadStream') 断言拒绝发生在 inflate 之前
  - ① limits.maxEntries=3，包里 4 个 1 字节条目：应 reject，文案含「条目过多」，openReadStream 调用 0 次。现在 resolve，红
  - ② limits.maxTotal=1MB，包里 3 个 400KB 全零条目：应 reject，文案含「总大小」，openReadStream 调用不超过 2 次，第三个在打开前就被拒。现在 resolve，红
  - ③ limits.maxEntry=512KB，包里 1 个 600KB 条目：应 reject，文案含「解压后超过」，openReadStream 调用 0 次。红
  - ④ 用 writeZip 造正常包，再把中央目录的 uncompressedSize（偏移 +24）改成 2^31：应以我们的上限文案拒绝，而不是 yauzl 的「not enough bytes」。现在 yauzl 在读流时报的是另一句，红
  - ⑤ 默认值守卫：SKILL_ZIP_LIMITS 的条目数与总量等于 office 导出的常量（2000 与 64MB）
  - ⑥ 端到端：SkillImporter.startImport('zip', 超条目包)：任务 state='failed'，error 含「条目过多」，skillsRoot 下没有新目录。红
  - ⑦ 流式二道闸：声明 10 字节、实际 1MB 的 deflate 条目应被拒。现在 yauzl 已经会拒，现状即绿，申报非先红
守卫：
  - tests/skills-import.test.ts:204-245 的 zip 导入 4 例：都是小的 store-only 包，不翻红
  - tests/market-install.test.ts、tests/market-rpc.test.ts、tests/market-update.test.ts 里 buildZip 造的小包：不翻红
  - tests/office-ooxml.test.ts:13-29 的 readZip 往返与坏包例：readZip 重构后必须仍然全绿
风险：
  - zf.entryCount 来自 EOCD，可以被伪造得比实际小，所以回调里的计数不能省
  - 计数包含目录项时，带大量空目录的技能包可能被误拒；2000 的余量足够
  - reject 时 settle 会调用 zf.close()（importer.ts:76）。流式拒绝要先 rs.destroy() 再 close，避免读流进行中关闭报错
  - GitHub 导入（importer.ts:242-254）逐文件用 arrayBuffer 读，也没有上限，不在本项范围

## open_questions
- Q: 'full' 档下，写 mcp-servers/、skills/、memory/ 和其它会话桶这些「走卡」类操作，是否仍要强制询问？
  推荐: 跟随档位：full 档 bypass；硬拒类（providers.json、minis.db* 与凭据文件）在 dataGate 里直接拒，不受档位影响
  理由: kind 保持 file-write 改动最小。full 档本来就放行任意 shell，写卡在 full 下构不成真实边界。若要强制询问，就得新增 kind，并改 permissions.ts:217-284 的类目与预设表、lib/perm/copy.ts 的标题和对应守卫
- Q: 数据根内的读取，除 minis.db* 和其它会话桶外，mcp-servers/servers.json（明文 env 密钥）、minisd-port.json（authToken）以及其余根层文件是否也走卡？
  推荐: 用白名单：只对当前会话桶、shared、skills、memory 和绑定工作区免审，数据根内其余读取一律走卡，不硬拒
  理由: roadmap 只点了 minis.db 和其它会话，但 servers.json 和 minisd-port.json 是同一类凭据外泄面。数据根里还混着 Chromium profile 等文件，枚举黑名单容易漏，白名单不会
- Q: 是否在 W1b 就做路径规范化（对最近存在的祖先取 realpath，win32 下转小写、剥 ADS、剥尾部的点和空格）？
  推荐: 做，放进 dataGate
  理由: 不做的话，C:\\...\\DESKMI~1\\PROVID~1.JSO、providers.json.、providers.json::$DATA、junction 都能绕过硬拒；在 full 档下这就是真正的静默改配置。roadmap 把 realpath 列成了独立缺陷，但没有排进任何波次
- Q: file_list、file_glob、file_grep 的基准目录是数据根的祖先时（例如工作区绑到用户主目录），怎么处理？
  推荐: walkDir 跳过数据根子树，并在尾注里说明；不弹卡
  理由: 否则 grep 会顺带读到 servers.json 和其它会话的文件，绕过「读取其它会话走卡」；若改为弹卡，工作区绑定主目录的用户每次搜索都会被打断
- Q: shell 只读白名单可以静默读数据根（Get-Content、type、rg 加 $env:APPDATA 路径），要不要在 W1b 一并堵上？
  推荐: 0.3.0 前加一条最小规则：只读判定命中、但命令文本含 'deskminis'（不区分大小写）或含未加引号的 '$' 时，回落为 gated。其余留给 W7b
  理由: 否则「读取 minis.db 走卡」只对文件工具成立。这条改动在 permissions.ts，可能属于别的分区，需要主会话分配
- Q: file_edit 是否顺带拒绝非 UTF-8 文件（解码后往返字节不等就拒）？
  推荐: 纳入 W1a-edit
  理由: 它和 $ 缺陷同属「静默改坏用户文件」。Windows 上 GBK 文件，以及 PowerShell 5 重定向产生的 UTF-16LE 文件都很常见；实现只需一次 Buffer 比较
- Q: file_edit 的唯一性是否把重叠出现也算进去？
  推荐: 算
  理由: 在 "aaa" 里改 "aa" 现在会静默替换第 0 位，属于有歧义的编辑；收紧后影响面极小
- Q: 技能 zip 的单文件上限取多少？office 的 readZip 要不要同步加单文件上限？
  推荐: 技能取 32MB，与市场下载上限（install.ts:35）和 MAX_OFFICE（office.ts:18）一致；office 的单文件上限取 64MB，也就是等于总量，行为不变
  理由: roadmap 说要复用 office 的「三道闸」，但 office/zip.ts 实际只有两道；止血波不宜改变 office 的行为
- Q: killTree 是否取消「起 taskkill 后立即同步 child.kill()」？
  推荐: 取消，只在 taskkill 出错或以非 0 退出时兜底 kill
  理由: 同步杀根会让 taskkill /T 找不到父进程 pid，孙进程仍会残留（推断）。代价是 mcp-stdio.test.ts:279-290 有意翻红。还需在 Windows 真机验证一例：在 shell 里起 ping -t 之类的孙进程，interrupt 后用 tasklist 确认没有残留
- Q: 同类裸名 spawn 要不要一起改：mcp/stdio.ts:89 的 cmd.exe（cwd 来自配置）、bridge/handlers.ts:52 的 powershell.exe，以及 bridge/server.ts:64、market/install.ts:256 的 where.exe？
  推荐: cmd.exe 和 runPowerShell 一起改（共用同一个 helper，规模 S），where.exe 留到以后
  理由: cmd.exe 的 spawn 带 cwd，和 shell 属于同一个 cwd 劫持面；where.exe 不带 cwd，风险低
- Q: W1b 之后 agent 直写技能会变成每个新文件一张卡，是否接受？
  推荐: 0.3.0 接受，同步更新设计 §5.1 与 e2e-m2c 脚本的注释；「本会话允许」按目录前缀授权留给 W7b
  理由: 止血波不改网关的授权模型（permissions.ts:314 只按精确路径记忆）

## files
- src/minisd/tools/files.ts
- src/minisd/tools/types.ts
- src/minisd/paths.ts
- src/minisd/tools/search.ts
- src/renderer/src/stores/chat.ts
- src/renderer/src/ui/PermCard.vue
- src/minisd/proc/win-exec.ts（新增）
- src/minisd/tools/shell.ts
- src/minisd/terminal.ts
- src/minisd/mcp/stdio.ts
- src/minisd/bridge/handlers.ts（可选）
- src/minisd/skills/importer.ts
- src/minisd/office/zip.ts
- src/minisd/tools/permissions.ts（仅在 open_questions 第 5 条拍板时改）
- scripts/e2e-m2c-acceptance.mjs
- tests/file-edit-dollar.test.ts（新增）
- tests/data-root-write-gate.test.ts（新增）
- tests/shell-kill-tree.test.ts（新增）
- tests/skill-zip-bomb.test.ts（新增）
- tests/renderer-permcard.test.ts
- tests/mcp-stdio.test.ts
- /home/user/Deskminis/THIRD-PARTY-NOTICES.md

## xvfb
- PermCard 新增的 note 行：用 file_write 写 /var/minis/mcp-servers/servers.json 触发权限卡，确认路径区之后显示「将修改应用配置：MCP 配置里的命令会在下次连接时执行」，窄列（分栏态 .stage.narrow）下整句换行、不出现省略号，亮色和暗色主题下警示色都清晰可读
- 读取数据根下 minis.db 时的 file-read 卡：note「将读取 DeskMinis 会话数据库（含全部会话内容）」可见，且与无 note 的普通读卡在视觉上能区分