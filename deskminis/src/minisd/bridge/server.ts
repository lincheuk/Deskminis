import { createServer, type Server, type Socket } from 'node:net';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve, join, basename, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
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

/**
 * 打包态资源目录：electron-builder extraResources 把桥 stub / 垫片拷到安装目录 resources/。
 * 从 dirname(process.execPath)（安装根）回溯 resources 最稳——打包后所有代码在 app.asar 内，
 * 但不能用 import.meta.url 相对 resources（asar 是虚拟归档，相对回溯到不了安装根）。
 */
function packedResourcesDir(): string {
  return resolve(dirname(process.execPath), 'resources');
}

/** 定位 bridge-cli.mjs：① vitest/ts 直跑时在 minisd 入口目录（src/minisd/，stub 与主入口同级）；
 *  ② electron-vite 产物在 out/main/，回溯到 src 布局；
 *  ③ M5 打包态：extraResources 拷到安装目录 resources/bridge-cli.mjs（见 packedResourcesDir）。
 *  传参 resourcesDir 供测试注入临时目录；缺省用打包态/开发布局的自然回溯。 */
export function resolveBridgeCliPath(resourcesDir?: string): string | undefined {
  const here = fileURLToPath(new URL('.', import.meta.url));
  const candidates = [
    join(resourcesDir ?? packedResourcesDir(), 'bridge-cli.mjs'), // M5 打包态/显式注入优先：resources/bridge-cli.mjs
    join(here, '..', 'bridge-cli.mjs'), // dev：src/minisd/bridge/ → src/minisd/bridge-cli.mjs
    join(here, 'bridge-cli.mjs'),        // 兼容：stub 与 server 同目录的布局
    resolve(here, '..', '..', 'src', 'minisd', 'bridge-cli.mjs'), // prod：out/main/bridge/ → src/minisd/bridge-cli.mjs
  ];
  return candidates.find(p => existsSync(p));
}

/** 定位真 node.exe：electron.exe 是 GUI 子系统 PE（IMAGE_SUBSYSTEM_WINDOWS_GUI=2），
 *  PowerShell 对 GUI 程序的 `&` 调用**不等待、不接管 stdout**（已三方实证：& 直调输出空且 $LASTEXITCODE 不设；
 *  Process.Start 显式重定向正常；cmd /c 包裹正常；node 直调正常）。ELECTRON_RUN_AS_NODE 只改运行时，不改 PE 子系统标志。
 *
 *  策略：M5 打包态优先返回随包 `.cmd` 垫片（resources/bridge-node.cmd，ELECTRON_RUN_AS_NODE 复用 DeskMinis.exe）；
 *  否则 `where.exe node` 取第一个存在的路径（PATH 里的真 node.exe，CONSOLE 子系统）；找不到则回退 process.execPath（electron）。
 *  开发期必有 node（跑得起本项目即有）。M5 打包后此函数不再退役——打包态见决策点 2-3/2-7/2-8（垫片复用 Electron 运行时）。
 *  传参 resourcesDir 供测试注入临时目录；缺省用打包态/开发布局的自然回溯。 */
export function resolveBridgeNode(resourcesDir?: string): string {
  try {
    // M5 打包态优先：随包 resources/bridge-node.cmd 垫片（ELECTRON_RUN_AS_NODE 复用应用自带 DeskMinis.exe）
    const shim = join(resourcesDir ?? packedResourcesDir(), 'bridge-node.cmd');
    if (existsSync(shim)) return shim;
    // 否则走 where.exe node
    const wh = spawnSync('where.exe', ['node'], { encoding: 'utf8', windowsHide: true, timeout: 3000 });
    if (wh.status === 0 && typeof wh.stdout === 'string') {
      const first = wh.stdout.split(/\r?\n/).map(s => s.trim()).find(s => s && existsSync(s));
      if (first) {
        // 兜底：确保不是 electron 伪装的 node（electron 有时也被放进 PATH 的 node.exe 符号链接/拷贝）
        // basename 等于 node.exe 即认；若 basename 是 electron.exe 则跳过
        if (basename(first).toLowerCase() === 'node.exe') return first;
      }
    }
  } catch { /* where.exe 不存在（非 Windows）或超时：走 fallback */ }
  return process.execPath;
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
