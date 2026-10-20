/**
 * F11A 附件同步的限额与时限。index.ts 不传，一律用缺省值；只有组件级测试注入小值（两端一起缩）。
 * chunkBytes、maxFileBytes、sessionMaxFiles 是协议常量（见 wire.ts 的 ATT_PROTO）：发布后再改要换能力位名字。
 */
import { ATT_PROTO } from './wire';

export interface AttachmentLimits {
  /** 块长。offset 恒为它的整数倍，每块恰为 min(chunkBytes, size - offset)。 */
  chunkBytes: number;
  /** 单个附件上限。 */
  maxFileBytes: number;
  /** 每会话同步的附件数上限，也是一次清单的条数上限。 */
  sessionMaxFiles: number;
  /** 一个会话的附件总量上限（present 与要取的 missing 之和）。 */
  sessionQuotaBytes: number;
  /** attachments.read 带全文的上限，超过只回路径。 */
  previewMaxBytes: number;
  /** 暂存文件的保留期，过期在启动自检时清掉。 */
  partTtlMs: number;
  /** 整文件校验失败后自动从头再取的次数。 */
  integrityRetries: number;
  /** 清单应答里等本机算哈希的时间预算。 */
  indexBudgetMs: number;
  /** 引擎对每个 sync.att.* 调用的计时。 */
  chunkTimeoutMs: number;
  /** 一张票多久没动静可以被别的传输接管。 */
  recvIdleMs: number;
  /** 对端说「还在登记」或本机同名文件还没登记完时，隔多久再发一轮清单（同一连接周期内每会话最多 5 次）。 */
  indexRetryMs: number;
}

export const DEFAULT_ATTACHMENT_LIMITS: Readonly<AttachmentLimits> = Object.freeze({
  chunkBytes: ATT_PROTO.CHUNK_BYTES,
  maxFileBytes: ATT_PROTO.MAX_FILE_BYTES,
  sessionMaxFiles: ATT_PROTO.LIST_MAX,
  sessionQuotaBytes: 512 * 1024 * 1024,
  previewMaxBytes: 8 * 1024 * 1024,
  partTtlMs: 7 * 24 * 60 * 60 * 1000,
  integrityRetries: 1,
  indexBudgetMs: 4000,
  chunkTimeoutMs: 10_000,
  recvIdleMs: 30_000,
  indexRetryMs: 3000,
});
