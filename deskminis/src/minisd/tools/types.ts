import type { AgentToolDefinition } from '../../shared/types';
import type { MinisPaths } from '../paths';

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
export type PermissionDecision = 'allow' | 'deny';
export interface PermissionGateway {
  check(req: PermissionRequest): Promise<PermissionDecision>;
  /** M4 Task 2：查询会话是否曾授权过桥（sessionBridgeGrants 或 bridgeOnce 有记录）。用于 systemPrompt 工厂决定注入完整/精简桥段落。 */
  hasBridgeGrant(sessionId: string): boolean;
}

export interface ToolContext {
  sessionId: string; paths: MinisPaths; permissions: PermissionGateway;
  /** file_read 成功读取后的通知钩子（技能 use_count 采集点，M2c）；失败/被拒/超限不触发。 */
  onFileRead?: (absPath: string) => void;
  /** 会话级取消信号（chat.cancel 的 controller.signal）。工具收到后应立即中止：
   *  shell 长命令/文件写入不理会它的话，用户点了停止 UI 已空闲而动作还在跑。 */
  signal?: AbortSignal;
}

export interface ToolExecutor {
  definition: AgentToolDefinition;
  execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutcome>;
}
