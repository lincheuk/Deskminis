export async function* parseSse(body: ReadableStream<Uint8Array>): AsyncGenerator<{ event?: string; data: string }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
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
