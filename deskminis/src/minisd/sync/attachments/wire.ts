/**
 * F11A 附件协议第 1 版：线格式、常量、严格解析、错误码。
 *
 * 只走现有加密通道上的 JSON-RPC（sync.att.manifest / get / put），数据块是 base64。
 * 线上只有逻辑名（单层文件名）与内容身份（sha256 + 长度），没有任何路径字段：
 * 接收端的落点永远由它自己用本机数据根拼出来，对端给的字符串不参与路径计算。
 * 本文件不碰文件系统；所有解析器的输入都来自网络，按 unknown 处理。
 */
import { SESSION_ID_RE, SHA256_HEX_RE, validateAttachmentName } from '../../../shared/attachments';

/** 附件协议第 1 版的常量。两端必须一致，改任何一个都要换能力位名字（SYNC_CAP.ATTACHMENTS）。 */
export const ATT_PROTO = Object.freeze({
  VERSION: 1,
  /** 块界固定：offset 恒为 CHUNK_BYTES 的整数倍，每块恰为 min(CHUNK_BYTES, size - offset) 字节。 */
  CHUNK_BYTES: 256 * 1024,
  /** 单个附件上限，与 office.read 的解析上限同值。 */
  MAX_FILE_BYTES: 32 * 1024 * 1024,
  /** 一次清单最多几条，也是每会话同步的附件数上限。 */
  LIST_MAX: 512,
});

/** 清单的一条：逻辑名 → 内容。 */
export interface WireAttachment { name: string; size: number; sha256: string; mimeType: string }

export interface AttManifestRequest { v: 1; sessionId: string; entries: WireAttachment[] }

/** 前五个重发同一份清单结果不会变；后五个是应答方那边之后可能变的状态，请求方收到后这一轮不记收敛。
 *  busy：别的传输正在写同一份内容，或应答方本机同名文件还没登记完。 */
export type AttRejectCode =
  | 'bad_entry' | 'bad_name' | 'too_large' | 'quota' | 'name_conflict'
  | 'session_unknown' | 'not_referenced' | 'held' | 'failed' | 'busy';

const REJECT_CODES: ReadonlySet<string> = new Set<AttRejectCode>([
  'bad_entry', 'bad_name', 'too_large', 'quota', 'name_conflict',
  'session_unknown', 'not_referenced', 'held', 'failed', 'busy',
]);

export interface AttManifestResponse {
  v: 1;
  /** 应答方本机 present 的清单（与请求里逐项相同的那些不重复列出）。 */
  entries: WireAttachment[];
  /** 应答方要、且请求方在本次请求里列出的内容；offset 是续传起点（块长的整数倍）。 */
  want: Array<{ name: string; sha256: string; offset: number }>;
  /** 请求里没被接受的条目：index 是它在请求 entries 里的下标。不回显对端给的字符串。 */
  rejected: Array<{ index: number; code: AttRejectCode }>;
  /** 应答方还在给本机文件算哈希，过几秒再来。预算内没登记完时 entries / want / rejected 三个都是空的。 */
  indexing: boolean;
}
export interface AttGetRequest { v: 1; sessionId: string; name: string; sha256: string; offset: number }
export interface AttGetResponse { v: 1; offset: number; size: number; data: string }
export interface AttPutRequest { v: 1; sessionId: string; name: string; sha256: string; offset: number; data: string }
export interface AttPutResponse { v: 1; offset: number; done: boolean }

export type AttErrorCode =
  | 'ATT_CHANNEL_REQUIRED'  // 不是加密通道上的 remote 连接
  | 'ATT_CAP_REQUIRED'      // 对端没在 sync.hello 里声明 attachments
  | 'ATT_PAUSED'            // 本端已暂停同步
  | 'ATT_STOPPING'
  | 'ATT_BAD_REQUEST'       // 信封、sessionId、名字、sha256、offset、data 的形状不合规
  | 'ATT_NOT_FOUND'         // 取不到（不存在、未引用、内容对不上，一律这一个码）
  | 'ATT_NO_TRANSFER'       // put 之前没有对应的 want，或该传输已不归这个对端
  | 'ATT_BUSY'              // 同一内容正由别的传输写入
  | 'ATT_OFFSET'            // message 为 'ATT_OFFSET expected=<n>'
  | 'ATT_BAD_CHUNK' | 'ATT_HASH' | 'ATT_CANCELLED' | 'ATT_IO';

const ERROR_CODES: ReadonlySet<string> = new Set<AttErrorCode>([
  'ATT_CHANNEL_REQUIRED', 'ATT_CAP_REQUIRED', 'ATT_PAUSED', 'ATT_STOPPING', 'ATT_BAD_REQUEST', 'ATT_NOT_FOUND',
  'ATT_NO_TRANSFER', 'ATT_BUSY', 'ATT_OFFSET', 'ATT_BAD_CHUNK', 'ATT_HASH', 'ATT_CANCELLED', 'ATT_IO',
]);

/** message 恒为 `${code}` 或 `${code} ${detail}`；detail 只有数字与等号，不含路径与对端自报的内容。
 *  RpcServer 只回传 message，码靠前缀带到对端。 */
export class AttError extends Error {
  readonly code: AttErrorCode;
  constructor(code: AttErrorCode, detail?: string) {
    super(detail === undefined || detail === '' ? code : `${code} ${detail}`);
    this.name = 'AttError';
    this.code = code;
  }
}

/** 从对端回来的错误消息里取码；不是本协议的码返回 undefined。 */
export function attErrorCodeOf(message: unknown): AttErrorCode | undefined {
  const text = message instanceof Error ? message.message : message;
  if (typeof text !== 'string') return undefined;
  const head = text.split(' ', 1)[0];
  return ERROR_CODES.has(head) ? head as AttErrorCode : undefined;
}

/** 'ATT_OFFSET expected=<n>' → n；其它一律 undefined。 */
export function attOffsetExpected(message: unknown): number | undefined {
  const text = message instanceof Error ? message.message : message;
  if (typeof text !== 'string') return undefined;
  const m = /^ATT_OFFSET expected=(\d{1,16})$/.exec(text);
  if (!m) return undefined;
  const n = Number(m[1]);
  return Number.isSafeInteger(n) ? n : undefined;
}

const MIME_RE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,62}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,62}$/;
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function bad(): never { throw new AttError('ATT_BAD_REQUEST'); }

/** 线路上的 mimeType 不参与任何判断：不合规就当成通用二进制，不因此拒条目。 */
export function normalizeMime(raw: unknown): string {
  if (typeof raw !== 'string') return 'application/octet-stream';
  const lower = raw.toLowerCase();
  return MIME_RE.test(lower) ? lower : 'application/octet-stream';
}

function isOffset(v: unknown, chunkBytes: number): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v % chunkBytes === 0;
}

/** 标准 base64 的一块：字符集、长度、规范性（解码后再编码等于原串）、解码长度 1…chunkBytes。不合规返回 undefined。 */
function decodeChunk(raw: unknown, chunkBytes: number): Buffer | undefined {
  if (typeof raw !== 'string') return undefined;
  if (raw.length === 0 || raw.length % 4 !== 0 || raw.length > Math.ceil(chunkBytes / 3) * 4) return undefined;
  if (!BASE64_RE.test(raw)) return undefined;
  const bytes = Buffer.from(raw, 'base64');
  if (bytes.length < 1 || bytes.length > chunkBytes) return undefined;
  if (bytes.toString('base64') !== raw) return undefined;
  return bytes;
}

export function parseWireAttachment(raw: unknown): { ok: true; value: WireAttachment } | { ok: false; code: 'bad_entry' | 'bad_name' } {
  if (!isRecord(raw)) return { ok: false, code: 'bad_entry' };
  const name = validateAttachmentName(raw.name);
  if (name === undefined) return { ok: false, code: 'bad_name' };
  const { sha256, size } = raw;
  if (typeof sha256 !== 'string' || !SHA256_HEX_RE.test(sha256)) return { ok: false, code: 'bad_entry' };
  // 超过 MAX_FILE_BYTES 形状仍合规，由存储层判 too_large
  if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 1) return { ok: false, code: 'bad_entry' };
  return { ok: true, value: { name, size, sha256, mimeType: normalizeMime(raw.mimeType) } };
}

function envelope(raw: unknown): Record<string, unknown> {
  if (!isRecord(raw) || raw.v !== ATT_PROTO.VERSION) bad();
  return raw as Record<string, unknown>;
}

function sessionIdOf(raw: Record<string, unknown>): string {
  const sid = raw.sessionId;
  if (typeof sid !== 'string' || !SESSION_ID_RE.test(sid)) bad();
  return sid as string;
}

/** 信封不合规、entries 不是数组或超过 LIST_MAX 条 → 整条 ATT_BAD_REQUEST；单条不合规只记在那一条上。 */
export function parseManifestRequest(raw: unknown): { sessionId: string; entries: Array<ReturnType<typeof parseWireAttachment>> } {
  const env = envelope(raw);
  const sessionId = sessionIdOf(env);
  const list = env.entries;
  if (!Array.isArray(list) || list.length > ATT_PROTO.LIST_MAX) bad();
  return { sessionId, entries: (list as unknown[]).map(parseWireAttachment) };
}

/** 应答来自对端：entries 只取前 LIST_MAX 条、不合规的丢弃；want / rejected 里不合规的项丢弃。 */
export function parseManifestResponse(raw: unknown, chunkBytes: number = ATT_PROTO.CHUNK_BYTES): AttManifestResponse {
  const env = envelope(raw);
  if (!Array.isArray(env.entries) || !Array.isArray(env.want) || !Array.isArray(env.rejected) || typeof env.indexing !== 'boolean') bad();
  const entries: WireAttachment[] = [];
  for (const e of (env.entries as unknown[]).slice(0, ATT_PROTO.LIST_MAX)) {
    const r = parseWireAttachment(e);
    if (r.ok) entries.push(r.value);
  }
  const want: AttManifestResponse['want'] = [];
  for (const w of (env.want as unknown[]).slice(0, ATT_PROTO.LIST_MAX)) {
    if (!isRecord(w)) continue;
    const name = validateAttachmentName(w.name);
    if (name === undefined) continue;
    if (typeof w.sha256 !== 'string' || !SHA256_HEX_RE.test(w.sha256)) continue;
    if (!isOffset(w.offset, chunkBytes)) continue;
    want.push({ name, sha256: w.sha256, offset: w.offset });
  }
  const rejected: AttManifestResponse['rejected'] = [];
  for (const r of (env.rejected as unknown[]).slice(0, ATT_PROTO.LIST_MAX)) {
    if (!isRecord(r)) continue;
    const { index, code } = r;
    if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= ATT_PROTO.LIST_MAX) continue;
    if (typeof code !== 'string' || !REJECT_CODES.has(code)) continue;
    rejected.push({ index, code: code as AttRejectCode });
  }
  return { v: 1, entries, want, rejected, indexing: env.indexing as boolean };
}

function nameShaOffset(env: Record<string, unknown>, chunkBytes: number): { sessionId: string; name: string; sha256: string; offset: number } {
  const sessionId = sessionIdOf(env);
  const name = validateAttachmentName(env.name);
  if (name === undefined) bad();
  const sha256 = env.sha256;
  if (typeof sha256 !== 'string' || !SHA256_HEX_RE.test(sha256)) bad();
  if (!isOffset(env.offset, chunkBytes)) bad();
  return { sessionId, name: name as string, sha256: sha256 as string, offset: env.offset as number };
}

export function parseGetRequest(raw: unknown, chunkBytes: number = ATT_PROTO.CHUNK_BYTES): AttGetRequest {
  return { v: 1, ...nameShaOffset(envelope(raw), chunkBytes) };
}

/** 应答必须正是请求的那一块：offset、size 与请求相符，解码长度恰为 min(块长, size - offset)。不符抛 ATT_BAD_CHUNK。 */
export function parseGetResponse(raw: unknown, expect: { offset: number; size: number }, chunkBytes: number = ATT_PROTO.CHUNK_BYTES): Buffer {
  const fail = (): never => { throw new AttError('ATT_BAD_CHUNK'); };
  if (!isRecord(raw) || raw.v !== ATT_PROTO.VERSION) fail();
  const r = raw as Record<string, unknown>;
  if (r.offset !== expect.offset || r.size !== expect.size) fail();
  const bytes = decodeChunk(r.data, chunkBytes);
  if (bytes === undefined || bytes.length !== Math.min(chunkBytes, expect.size - expect.offset)) fail();
  return bytes as Buffer;
}

export function parsePutRequest(raw: unknown, chunkBytes: number = ATT_PROTO.CHUNK_BYTES): { sessionId: string; name: string; sha256: string; offset: number; bytes: Buffer } {
  const env = envelope(raw);
  const head = nameShaOffset(env, chunkBytes);
  const bytes = decodeChunk(env.data, chunkBytes);
  if (bytes === undefined) bad();
  return { ...head, bytes: bytes as Buffer };
}

/** put 的应答：offset 是下一块的起点（块界，或恰为 size），done 是严格布尔。不合规抛 ATT_BAD_REQUEST。 */
export function parsePutResponse(raw: unknown, size: number, chunkBytes: number = ATT_PROTO.CHUNK_BYTES): AttPutResponse {
  const env = envelope(raw);
  const { offset, done } = env;
  if (typeof done !== 'boolean') bad();
  if (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0 || offset > size) bad();
  if (offset !== size && (offset as number) % chunkBytes !== 0) bad();
  return { v: 1, offset: offset as number, done: done as boolean };
}

export function toWire(row: { name: string; size: number; sha256: string; mimeType: string }): WireAttachment {
  return { name: row.name, size: row.size, sha256: row.sha256, mimeType: normalizeMime(row.mimeType) };
}
