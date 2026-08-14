import { ProviderError } from './types';

export async function* parseSse(
  body: ReadableStream<Uint8Array>,
  // 停滞看门狗：流挂死（连接不关闭也不再发任何字节）时 read() 永不 resolve，
  // 不设超时用户只能手动取消。默认 60s——thinking 长思考也会持续发 delta 帧，
  // 60s 无任何字节即可安全判停滞。三个 provider 调用处不传此参，默认值生效。
  idleTimeoutMs = 60000,
): AsyncGenerator<{ event?: string; data: string }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    while (true) {
      const { done, value } = await readWithStallWatchdog(reader, idleTimeoutMs);
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      // SSE 规范允许 CRLF / 裸 CR 行尾，代理也可能把 LF 归一成 CRLF：只按 '\n\n' 找帧边界的话
      // 这类流一个事件都解析不出来，provider 最后抛「流提前结束」。
      // 每轮对整个缓冲区归一：落在块边界上的孤立 '\r' 会在下一块到达时与 '\n' 配上对，
      // 故用 (?!$) 保留缓冲区末尾的孤立 '\r'（可能是被拆开的 CRLF 前半），只把非末尾的裸 CR 转成 LF。
      buf = buf.replace(/\r\n/g, '\n').replace(/\r(?!$)/g, '\n');
      let idx: number;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const parsed = parseFrame(frame);
        if (parsed) yield parsed;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/** read() 与停滞超时竞速：超时先 cancel 底层流再抛 retryable ProviderError（走既有重试梯——
 *  挂死多为网关/代理半开连接，重试通常可自愈）。必须先 cancel：外层 finally 的
 *  releaseLock 会因 read() 仍挂起而抛 TypeError，把真正的超时错误吞掉；cancel 会让
 *  挂起的 read 以 {done:true} 落定，锁得以正常释放，连接也不至于一直挂着。 */
async function readWithStallWatchdog(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  idleTimeoutMs: number,
) {
  const stall = new ProviderError('SSE 流停滞超时', { retryable: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(stall), idleTimeoutMs); }),
    ]);
  } catch (e) {
    if (e === stall) await reader.cancel().catch(() => {});
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

function parseFrame(frame: string): { event?: string; data: string } | undefined {
  let event: string | undefined;
  const dataLines: string[] = [];
  for (const line of frame.split('\n')) {
    if (line.startsWith(':')) continue;
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
  }
  if (dataLines.length === 0) return undefined;
  return { event, data: dataLines.join('\n') };
}
