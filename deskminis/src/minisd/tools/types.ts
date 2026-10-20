import type { AgentToolDefinition } from '../../shared/types';
import type { PermissionAllowed, PermissionDenied, PermissionOutcome } from '../../shared/permission';
import type { MinisPaths } from '../paths';
import type { FileIo } from '../checkpoints/fs';
import type { DataGateOptions } from './data-gate';

export type { PermissionOutcome, PermissionAllowed, PermissionDenied, PermissionDenyReason, PermissionDenyCause } from '../../shared/permission';

/** file_read 分段读取（W1b-2d）实际返回的范围：按 UTF-16 码元从 0 计，start 含、end 不含，total 为全文长度。 */
export interface ReadRange { start: number; end: number; total: number }

/** readRange 只有 file_read 的分段读取会带：output 是「片段 + 换行 + 范围注记」，loop 读回卸载文件时
 *  （agent/offload.ts clampReadBack）要知道片段在哪结束、在文件里的坐标，才能封顶并给出正确的下一段 offset。
 *  用结构化字段而不从 output 里解析注记：卸载文件的内容本身就可能是一次分段读的结果，末行长得和注记一模一样。 */
export interface ToolOutcome { output: string; success: boolean; readRange?: ReadRange }

/** windows-* 桥的能力类目：kind 即权限类目（与 file-write/file-read 同款 1:1 路由）。 */
export type BridgePermissionKind =
  | 'bridge-notify'
  | 'bridge-clipboard-read'
  | 'bridge-clipboard-write'
  | 'bridge-open'
  | 'bridge-speak'
  | 'bridge-screenshot'
  | 'bridge-device';

/** 审批前变更预览（仅 file-write 类请求携带）：把 ToolLine 执行后的 diff 能力前移到批准时刻，
 *  写文件不再是盲批。可选字段：shell/桥类请求的信息已由 detail 完整表达，不构造 preview。
 *  注意：preview 只进权限卡广播，不进审计落盘（审计只记有无布尔，见 minisd/index.ts）。 */
export interface PermPreview { oldText: string; newText: string }

/** note（W1b-2，止血设计稿 §3 第 6 条）：数据根内走卡的文件操作带一句人话说明，
 *  例如「将修改应用配置：技能…」「将读取其它会话（<id>）的文件」。与 preview 分工：
 *  preview 只放差分正文，note 说明这次动的是什么；note 也不拼进 detail——detail 是逐字的路径，
 *  会话授权键（permissions.ts）与既有断言都按它匹配。kind 不变，档位与标题映射都不用动。
 *  note 进广播也进审计（审计只剔除 preview 全文）。 */
export interface PermissionRequest { kind: 'shell' | 'file-write' | 'file-read' | 'web-fetch' | 'web-search' | 'mcp' | BridgePermissionKind; detail: string; sessionId: string; toolTitle: string; preview?: PermPreview; note?: string }
/** 粗决定（F04 的 SchedulerEvent 用它）。带原因的结果是 PermissionOutcome（F13，shared/permission.ts）。 */
export type PermissionDecision = 'allow' | 'deny';

/** F13：一次询问附带的信息。都不参与会话授权键，也不改变任何判定——只决定「这张卡属于谁、谁不要了」。 */
export interface PermissionAskOptions {
  /** 这次询问属于哪个工具调用（调度器的权限包装层填，工具自己不填）。进卡片 meta 与审计，不参与会话授权键。 */
  toolUseId?: string;
  /** 询问方的取消信号。abort = 询问方不再需要这次许可：卡片当场按 cancelled 了结，之后的答复无效。cause 取 cancelCauseOf(signal)。 */
  signal?: AbortSignal;
  /** 缺省 'tool'。桥分发器传 'bridge'。 */
  origin?: 'tool' | 'bridge';
  /** 卡片建好那一刻同步回报它的 requestId（没弹卡就不调）。抛错被网关吞掉。 */
  onIssued?(requestId: string): void;
}

export interface PermissionGateway {
  /** 旧式二值结果，恒等于 (await decide(req)).decision。src 里只有 decidePermission 的兼容分支会调它，留给旧替身。 */
  check(req: PermissionRequest): Promise<PermissionDecision>;
  /** F13：带原因的结果。没实现它的网关是「旧式二值网关」，由 decidePermission 归一成「没有说明原因」——不会被说成用户拒绝。 */
  decide?(req: PermissionRequest, opts?: PermissionAskOptions): Promise<PermissionOutcome>;
  /** F13：不经询问就拒掉的操作、批准之后没执行的操作，报给网关记审计。不改变任何判定，不抛。 */
  noteDenied?(req: PermissionRequest, denied: PermissionDenied, opts?: Pick<PermissionAskOptions, 'toolUseId' | 'origin'>): void;
  /** F05：收回一张卡的放行带来的授权（「本会话允许」记下的会话授权、shell 卡带出的桥合并授权）。
   *  只用在一处：批准已收到，却没能落进执行账本，这次放行被改成了拒绝（invalidated / record-failed）。
   *  不收回的话，审计与回给模型的话都说这次批准已失效、会重新询问，授权却一直有效到会话结束——同样的请求下一次不弹卡直接放行。
   *  只会收回、从不放行；没弹卡的放行（档位免审、既有授权）没有东西可收。不抛。没实现它的网关不收回任何东西。 */
  revokeGrant?(req: PermissionRequest, allowed: PermissionAllowed): void;
  /** M4 Task 2：查询会话是否曾授权过桥（sessionBridgeGrants 或 bridgeOnce 有记录）。用于 systemPrompt 工厂决定注入完整/精简桥段落。 */
  hasBridgeGrant(sessionId: string): boolean;
  /** W8：写入入口也要识别只读档，免审路径不能绕过它；旧网关缺省为非只读档。 */
  isPlanMode?(): boolean;
}

/** F08：这次调用在运行账本里的身份。调度器在 journal.begin 之后填。不经调度器直接调工具（单测、旧调用方）时没有。 */
export interface ToolCallIdentity {
  toolUseId: string; index: number; name: string;
  runId?: string; executionId?: string;
  /** 这条宿主路径此刻是否仍落在本次调用持有的路径写锁之内（与锁同一套 pathIdentity）。调度器填。
   *  审批最长等 90 秒：等待期间路径上的链接被改指向时，工具拿着旧路径的锁去写新位置——写入入口据此拒绝。 */
  covers?(abs: string): boolean;
}

/** F08：写前检查点的保存方。实现在 checkpoints/store.ts；工具层只见这个接口。全部同步。 */
export interface FileCheckpointer {
  /** 保存写前状态并登记一条 pending 记录。返回即表示内容与记录都已落盘（内容 fsync、记录 FULL 提交），
   *  且提交前一刻确认过内容文件在盘上、大小相符。
   *  抛 CheckpointError = 没保存成：调用方不得动目标文件。 */
  prepare(p: CheckpointPrepare): PreparedCheckpoint;
  /** 删掉这个路径身份上记录在案、仍残留的临时文件（新建文件时「硬链接成功、删临时文件失败」会让目标带着 nlink=2 留下，
   *  写入入口在按硬链接拒绝之前先调它）。只删库里记的那一条、文件名匹配 TMP_NAME_RE 的普通文件。从不抛。 */
  releaseTemps(pathKey: string): void;
  /** 写入事务用的文件操作与路径规范化选项：与保存方共用同一套——测试注入一处，写入事务、存储、恢复都生效。
   *  不给时写入事务用生产实现。 */
  readonly io?: FileIo;
  readonly pathOptions?: DataGateOptions;
}
export interface CheckpointPrepare {
  sessionId: string; call?: ToolCallIdentity;
  /** requestedPath：工具解析出的宿主绝对路径。path：真实路径（realPathOf）。pathKey：路径身份键（pathKeyOf）。 */
  requestedPath: string; path: string; pathKey: string;
  /** 不传 = 写入前文件不存在。 */
  before?: { bytes: Buffer; hash: string; mode: number };
  afterHash: string; afterSize: number;
  /** 将要用的临时文件（与目标同目录），对账时据此清理。 */
  tmpPath: string;
}
/** 文件 ID：bigint 的十进制文本；取不到（ino 为 0）时整体缺省。 */
export interface FileId { dev: string; ino: string }
export interface PreparedCheckpoint {
  readonly id: string;
  /** 替换完成。path 是替换后再取一次 realpath 的结果。inPlace：这次是原地覆盖回落（行的 detail 记 'in-place'）。
   *  抛错由调用方吞掉（行留在 pending，由对账收口）。 */
  applied(a: { path: string; fileId?: FileId; inPlace?: boolean }): void;
  /** 没有替换，且已确认目标文件未动。 */
  aborted(reason: 'write-failed' | 'changed-during-write', detail?: string): void;
  /** 替换失败后没能确认目标文件的状态。 */
  uncertain(detail: string): void;
  // 三个方法都不无条件清 tmp_path：各自 lstat 一次记录在案的临时文件，确认已不存在才清空该列；还在就留着，由对账重试删除。
}

export interface ToolContext {
  sessionId: string; paths: MinisPaths; permissions: PermissionGateway;
  /** file_read 成功读取后的通知钩子（技能 use_count 采集点，M2c）；失败/被拒/超限不触发。 */
  onFileRead?: (absPath: string) => void;
  /** 会话级取消信号（chat.cancel 的 controller.signal）。工具收到后应立即中止：
   *  shell 长命令/文件写入不理会它的话，用户点了停止 UI 已空闲而动作还在跑。 */
  signal?: AbortSignal;
  /** F08：调度器填。 */
  call?: ToolCallIdentity;
  /** F08：生产由 index.ts 传入。不传时 commitFileWrite 照常原子写入、不建检查点（旧调用方与单测）；
   *  带了 call.executionId 却没有它 = 接线漏了，拒绝写入。 */
  checkpoints?: FileCheckpointer;
}

/** F04：副作用范围。'unknown' = 说不清会动什么（shell、MCP、没声明的工具），调度按 barrier 处理。
 *  'network' = 只向外发请求、不写本地文件。F05 只把 readOnly && sideEffects === 'none' 的调用当作可安全重查。 */
export type SideEffectScope = 'none' | 'local-files' | 'network' | 'unknown';
export type ResourceMode = 'read' | 'write';

/** 一次调用触及的资源（F04）。
 *  path ：宿主绝对路径（不必规范化，调度器负责），覆盖它自己和它之下的整棵子树。
 *  named：进程内命名资源，按名字全等比较（如 `mcp:<server>`）。 */
export type ResourceClaim =
  | { kind: 'path'; path: string; mode: ResourceMode }
  | { kind: 'named'; name: string; mode: ResourceMode };

/** 资源解析只拿得到这两样：类型上就拿不到 permissions 与 signal，解析阶段不可能弹卡或授予权限。 */
export type ToolPlanContext = Pick<ToolContext, 'sessionId' | 'paths'>;

/** 调度元数据（F04）：只决定「什么时候可以开始」，不决定「允不允许」。PermissionGatewayImpl 不读这里的任何字段。
 *  只来自宿主代码里注册的执行器对象：MCP 服务器返回的字段、模型入参里的字段都改不了它。 */
export interface ToolScheduling {
  /** 只读：不改任何本地状态。 */
  readOnly: boolean;
  /** 并发安全：除 resources() 声明的资源外没有共享可变状态，可与资源不冲突的调用同时跑。false = barrier。 */
  concurrencySafe: boolean;
  sideEffects: SideEffectScope;
  /** 解析本次调用触及的资源。同步、无副作用、可重复调用；必须与 execute 用同一个路径解析表达式。
   *  调度器在入队时调一次、拿到锁后再调一次：两次结果不同（等锁期间会话工作区被改等）就不执行。
   *  抛错 = 解析不出，本次按 barrier 排队，随后照常调 execute（由它给出原有的错误文案）。 */
  resources?(input: Record<string, unknown>, ctx: ToolPlanContext): ResourceClaim[];
}

export interface ToolExecutor {
  definition: AgentToolDefinition;
  /** F04：不写 = { readOnly:false, concurrencySafe:false, sideEffects:'unknown' }，即 barrier。 */
  scheduling?: ToolScheduling;
  /** F05 约定：有副作用的工具在权限询问（ctx.permissions）返回之前不得产生任何副作用。
   *  运行账本据此把「停在首次审批上就中断的调用」判成未执行、告诉模型可以重新发起；询问之前就动手的工具，
   *  崩溃后会被误报成没有执行。新增工具要补进 tests/tool-pre-approval-effects.test.ts 的名单。 */
  execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutcome>;
}
