import type { ToolExecutor } from './types';

/** 与 files.ts MAX_READ 同值：单次抓取的 body 字节上限（无界内存红线，到限即断开）。 */
const MAX_BODY_BYTES = 1024 * 1024;
/** 与 shell.ts MAX_OUTPUT 同值：最终喂给模型的输出字符上限（超过 20K 由卸载引擎落盘，行为已有）。 */
const MAX_OUTPUT_CHARS = 100 * 1024;
/** 单次抓取硬超时：30 秒足够任何正常页面，再久只是把会话卡死在等一个不会来的响应。 */
const TIMEOUT_MS = 30000;
/** 错误响应体只留前 500 字符（错误页不值得占上下文）；按多字节最多 4 字节/字符放宽读取额度。 */
const ERROR_BODY_CHARS = 500;
const ERROR_BODY_BYTES = ERROR_BODY_CHARS * 4;

/** 命名实体表（够用的保守子集）：nbsp 映射普通空格——映射 \u00A0 会躲过空白折叠。 */
const NAMED_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function fromCodePointSafe(cp: number, fallback: string): string {
  try { return String.fromCodePoint(cp); } catch { return fallback; } // 越界/负值抛 RangeError
}

/** 实体解码：命名 + 十进制 + 十六进制，单趟替换（不重扫结果，&amp;lt; 不会二次展开成 <）。
 *  未知命名实体保留原文——半解码比误删安全。 */
function decodeEntities(s: string): string {
  return s.replace(/&(amp|lt|gt|quot|apos|nbsp|#[0-9]+|#x[0-9a-f]+);/gi, (m, g: string) => {
    const low = g.toLowerCase();
    if (low.startsWith('#x')) return fromCodePointSafe(parseInt(low.slice(2), 16), m);
    if (low.startsWith('#')) return fromCodePointSafe(parseInt(low.slice(1), 10), m);
    return NAMED_ENTITIES[low] ?? m;
  });
}

/** HTML → 纯文本 + 标题。不引解析依赖，正则足够把正文可靠捞出（工具用途是「读」不是「渲染」）。 */
export function htmlToText(html: string): { title: string; text: string } {
  const tm = html.match(/<title[^>]*>([\s\S]*?)<\/title\s*>/i);
  const title = tm ? decodeEntities(tm[1].replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim() : '';
  let t = html.replace(/\r\n?/g, '\n');
  // title 整块移出正文：标题已单列在元信息里，留在正文开头只会重复一遍
  t = t.replace(/<title[^>]*>[\s\S]*?<\/title\s*>/gi, '');
  // script/style/noscript 整块剥除（未闭合的吃到文档尾——否则脚本源码会漏进正文）
  t = t.replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, '');
  // 块级结束标签换行：不换的话 </p></p> 两段会黏成一行，正文段落结构全丢
  t = t.replace(/<br\s*\/?>|<\/(p|li|h[1-6]|tr)\s*>/gi, '\n');
  t = t.replace(/<[^>]*>/g, '');
  t = decodeEntities(t);
  // 空白折叠：水平空白归一、行首尾去空、连续空行折为一（\n{2,} → 恰好一空行）
  t = t.replace(/[ \t]+/g, ' ').replace(/ ?\n ?/g, '\n').replace(/\n{2,}/g, '\n\n');
  return { title, text: t.trim() };
}

/** 编码判定：content-type 头的 charset 优先；缺省时在前 1024 字节嗅 <meta charset>/http-equiv 形式；
 *  都没有返回 undefined（调用方按 utf-8）。多字节区按 utf-8 解码出现的替换符不影响 ASCII 标签段匹配。 */
export function sniffCharset(headerValue: string | null, headBytes: Uint8Array): string | undefined {
  if (headerValue) {
    const m = headerValue.match(/charset\s*=\s*"?([^\s;"]+)"?/i);
    if (m) return m[1];
  }
  const head = new TextDecoder('utf-8').decode(headBytes.slice(0, 1024));
  const meta = head.match(/<meta[^>]*charset\s*=\s*["']?\s*([a-z0-9_.:-]+)/i);
  return meta ? meta[1] : undefined;
}

/** TextDecoder 未知标签会抛 RangeError：包一层回退 utf-8（gbk/gb2312 等在 Electron full-icu 下原生可用）。 */
function decodeWithFallback(bytes: Uint8Array, charset: string): string {
  try { return new TextDecoder(charset).decode(bytes); } catch { return new TextDecoder('utf-8').decode(bytes); }
}

/** 流式读 body 到字节上限：到限即 cancel 断开，绝不先整读再截断（无界内存红线）。
 *  最后一块恰好装满时也判截断：流上无法区分「正好到限」与「还有后续」，宁可多标一次。 */
async function readBodyCapped(body: ReadableStream<Uint8Array> | null, capBytes: number): Promise<{ buf: Uint8Array; truncated: boolean }> {
  if (!body) return { buf: new Uint8Array(0), truncated: false };
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    const room = capBytes - total;
    if (value.length >= room) {
      if (room > 0) chunks.push(value.slice(0, room));
      total = capBytes;
      truncated = true;
      await reader.cancel(); // 服务端可能还在推，主动断开而不是任由它灌满管道
      break;
    }
    chunks.push(value);
    total += value.length;
  }
  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { buf.set(c, off); off += c.length; }
  return { buf, truncated };
}

/** web_fetch 工具：抓取 http(s) URL，HTML 转纯文本。fetchImpl 构造注入（测试路由假 fetch，仓库惯例）。 */
export function makeWebFetchTool(fetchImpl: typeof fetch = fetch): ToolExecutor {
  return {
    definition: {
      name: 'web_fetch',
      description: '抓取 http(s) URL 并把 HTML 转为纯文本（含标题）。正文上限 1MB、输出上限 100KB。',
      parameters: {
        url: { type: 'string', description: '完整 URL，仅支持 http/https' },
        tool_title: { type: 'string', description: '这次调用的 5-10 字用户语言摘要' },
      },
      required: ['url', 'tool_title'],
    },
    async execute(input, ctx) {
      // 已取消（用户点了停止）：立即收场，不再发起权限询问、不再连网
      if (ctx.signal?.aborted) return { output: '[已取消]', success: false };
      const raw = String(input.url ?? '');
      let url: URL;
      try { url = new URL(raw); } catch { return { output: `无效 URL: ${raw}`, success: false }; }
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        return { output: `仅支持 http/https URL: ${url.href}`, success: false };
      }
      // 无「内网豁免」：URL 本身可携带外传数据（查询串即外泄通道），一律按档位过卡
      const decision = await ctx.permissions.check({ kind: 'web-fetch', detail: url.href, sessionId: ctx.sessionId, toolTitle: String(input.tool_title) });
      if (decision === 'deny') return { output: '抓取被用户拒绝（可在设置-权限中调整）', success: false };
      // 同 shell：权限等待可长达 90 秒，已 abort 的 signal 不补发事件，闸后必须重查
      if (ctx.signal?.aborted) return { output: '[已取消]', success: false };

      const signals = [AbortSignal.timeout(TIMEOUT_MS), ctx.signal].filter((s): s is AbortSignal => Boolean(s));
      let res: Response;
      try {
        res = await fetchImpl(url.href, { headers: { 'user-agent': 'DeskMinis' }, signal: AbortSignal.any(signals) });
      } catch (e) {
        // 会话取消优先于超时归类（AbortError 两种来源都有，先看 signal 再看名字）
        if (ctx.signal?.aborted) return { output: '[已取消]', success: false };
        const name = (e as Error)?.name ?? '';
        if (name === 'TimeoutError' || name === 'AbortError') return { output: `抓取超时（${TIMEOUT_MS / 1000} 秒）`, success: false };
        return { output: `抓取失败: ${(e as Error)?.message ?? String(e)}`, success: false };
      }

      if (!res.ok) {
        const { buf } = await readBodyCapped(res.body, ERROR_BODY_BYTES);
        const prefix = new TextDecoder('utf-8').decode(buf).slice(0, ERROR_BODY_CHARS);
        return { output: `HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''}\n${prefix}`, success: false };
      }

      const { buf, truncated } = await readBodyCapped(res.body, MAX_BODY_BYTES);
      const ct = res.headers.get('content-type') ?? '';
      const isHtml = /text\/html/i.test(ct);
      let bodyText: string;
      let title = '';
      if (isHtml) {
        const r = htmlToText(decodeWithFallback(buf, sniffCharset(ct, buf) ?? 'utf-8'));
        title = r.title;
        bodyText = r.text;
      } else if (/^text\//i.test(ct) || /application\/json/i.test(ct)) {
        bodyText = decodeWithFallback(buf, sniffCharset(ct, buf) ?? 'utf-8');
      } else {
        bodyText = `[非文本内容: ${ct || '未知类型'}, ${buf.length} 字节]`;
      }

      const lines = [`URL: ${url.href}`, `状态: ${res.status}${res.statusText ? ` ${res.statusText}` : ''}`];
      if (isHtml && title) lines.push(`标题: ${title}`);
      if (truncated) lines.push(`[内容超过 1MB 已截断（保留前 ${MAX_BODY_BYTES} 字节）]`);
      let output = `${lines.join('\n')}\n\n${bodyText}`;
      if (output.length > MAX_OUTPUT_CHARS) output = output.slice(0, MAX_OUTPUT_CHARS) + '\n[输出超过 100KB 被截断]';
      return { output, success: true };
    },
  };
}
