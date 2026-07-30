import net from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeFrame, FrameDecoder } from '../src/minisd/bridge/frame';
import { BridgeServer, bridgePipePath } from '../src/minisd/bridge/server';
import { okEnvelope, type BridgeEnvelope } from '../src/minisd/bridge/handlers';

/** 一次性管道客户端：发一帧请求，等一帧信封响应（与 stub 同协议的最小实现）。 */
export function pipeRequest(pipePath: string, req: unknown, timeoutMs = 15000): Promise<BridgeEnvelope> {
  return new Promise((resolvePromise, reject) => {
    const socket = net.connect(pipePath);
    const decoder = new FrameDecoder();
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('管道响应超时')); }, timeoutMs);
    socket.on('error', e => { clearTimeout(timer); reject(e); });
    socket.on('connect', () => socket.write(encodeFrame(req)));
    socket.on('data', (chunk: Buffer) => {
      let frames: Buffer[];
      try { frames = decoder.push(chunk); } catch (e) { clearTimeout(timer); socket.destroy(); reject(e); return; }
      if (frames.length === 0) return;
      clearTimeout(timer);
      socket.end();
      resolvePromise(JSON.parse(frames[0].toString('utf8')) as BridgeEnvelope);
    });
  });
}

export function uniquePipePath(): string {
  return bridgePipePath(mkdtempSync(join(tmpdir(), 'dm-pipe-')));
}

/** echo 服务：把请求原样塞进 data.echo 返回（验证线协议保真度）。 */
export async function startEchoServer(): Promise<{ pipePath: string; close: () => Promise<void> }> {
  const pipePath = uniquePipePath();
  const server = new BridgeServer(async req => okEnvelope(req.tool, req.action, { echo: req }));
  await server.listen(pipePath);
  return { pipePath, close: () => server.close() };
}
