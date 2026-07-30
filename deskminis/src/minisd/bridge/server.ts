import { createServer, type Server, type Socket } from 'node:net';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeFrame, FrameDecoder } from './frame';
import { errEnvelope, type BridgeEnvelope, type BridgeRequest } from './handlers';

/** 管道名：数据根哈希防多实例冲突（架构决策 8）。小写归一 = Windows 路径大小写不敏感语义。 */
export function bridgePipePath(dataRootAbs: string): string {
  const h = createHash('sha256').update(resolve(dataRootAbs).toLowerCase()).digest('hex').slice(0, 8);
  return '\\\\.\\pipe\\deskminis-' + h;
}

/** 会话 shell 的桥环境变量（模型调桥的全部上下文；桥不可用时 PIPE/CLI 为空串，stub 会给出明确报错）。 */
export function makeBridgeEnv(sessionId: string, pipePath: string | undefined, cliPath: string | undefined, execPath: string): Record<string, string> {
  return {
    MINIS_CHAT_SESSION_ID: sessionId,
    MINIS_BRIDGE_PIPE: pipePath ?? '',
    MINIS_BRIDGE_CLI: cliPath ?? '',
    MINIS_BRIDGE_NODE: execPath,
  };
}

/** 定位 bridge-cli.mjs：① vitest/ts 直跑时在 minisd 入口目录（src/minisd/，stub 与主入口同级）；
 *  ② electron-vite 产物在 out/main/，回溯到 src 布局。
 *  M4 打包为 SEA exe 后此函数整体退役（届时 stub 进安装目录/PATH）。 */
export function resolveBridgeCliPath(): string | undefined {
  const here = fileURLToPath(new URL('.', import.meta.url));
  const candidates = [
    join(here, '..', 'bridge-cli.mjs'), // dev：src/minisd/bridge/ → src/minisd/bridge-cli.mjs
    join(here, 'bridge-cli.mjs'),        // 兼容：stub 与 server 同目录的布局
    resolve(here, '..', '..', 'src', 'minisd', 'bridge-cli.mjs'), // prod：out/main/bridge/ → src/minisd/bridge-cli.mjs
  ];
  return candidates.find(p => existsSync(p));
}

const READ_TIMEOUT_MS = 30000;

/** 命名管道桥服务：每连接一帧请求 → dispatch → 一帧信封 → 关（one-shot，免粘包/复用歧义）。 */
export class BridgeServer {
  private server: Server | undefined;
  private sockets = new Set<Socket>();

  constructor(private dispatch: (req: BridgeRequest) => Promise<BridgeEnvelope>) {}

  listen(pipePath: string): Promise<void> {
    return new Promise((resolvePromise, reject) => {
      const server = createServer(socket => this.onConnection(socket));
      server.on('error', reject); // 占管(EADDRINUSE)等：reject 给装配层降级
      server.listen(pipePath, () => { this.server = server; resolvePromise(); });
    });
  }

  private onConnection(socket: Socket): void {
    this.sockets.add(socket);
    socket.on('close', () => this.sockets.delete(socket));
    socket.on('error', () => { /* 客户端中断：close 事件负责清理 */ });
    const decoder = new FrameDecoder();
    let answered = false;
    const timer = setTimeout(() => socket.destroy(), READ_TIMEOUT_MS);
    socket.on('data', async (chunk: Buffer) => {
      if (answered) return; // one-shot：首帧之后的字节一律忽略
      let frames: Buffer[];
      try {
        frames = decoder.push(chunk);
      } catch (e) {
        answered = true;
        clearTimeout(timer);
        socket.end(encodeFrame(errEnvelope('', '', 'INVALID_REQUEST', (e as Error).message)));
        return;
      }
      if (frames.length === 0) return;
      answered = true;
      clearTimeout(timer);
      const respond = (env: BridgeEnvelope) => socket.end(encodeFrame(env));
      let req: BridgeRequest;
      try {
        req = JSON.parse(frames[0].toString('utf8')) as BridgeRequest;
      } catch {
        respond(errEnvelope('', '', 'INVALID_REQUEST', '请求帧不是合法 JSON'));
        return;
      }
      try {
        respond(await this.dispatch(req));
      } catch (e) {
        // dispatch 正常不该抛（分发器内部全兜成信封）；这里是最后防线
        respond(errEnvelope(req?.tool ?? '', req?.action ?? '', 'INTERNAL_ERROR', e instanceof Error ? e.message : String(e)));
      }
    });
  }

  async close(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    this.sockets.clear();
    const server = this.server;
    if (!server) return;
    this.server = undefined;
    await new Promise<void>(res => server.close(() => res()));
  }
}
