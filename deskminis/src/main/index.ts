import { app, BrowserWindow, dialog, ipcMain, utilityProcess, type UtilityProcess } from 'electron';
import { join } from 'node:path';

let minisd: UtilityProcess | undefined;
let minisdPort = 0;
// per-run token：从握手行里接住并经 minisd:info 通道交给渲染进程；
// 没有它渲染进程连 RPC 会被 401 拒绝（RpcServer 要求 ?token=<authToken>），应用只能开一个空窗口。
let minisdToken = '';

/** 子进程未在此时限内上报端口就判定启动失败——否则挂死的子进程会让主进程永远停在白屏前。 */
const MINISD_START_TIMEOUT_MS = 30_000;

/** 一行文本是不是握手行 `{"minisdPort":<n>,"authToken":"<uuid>"}`；不是就返回 undefined（调用方把它当普通日志转发）。
 *  必须同时拿到 port 和 token 才算握手——只有 port 没有 token 的行不是握手行，转发它、继续等。 */
export function parseHandshake(line: string): { port: number; token: string } | undefined {
  try {
    const o = JSON.parse(line) as { minisdPort?: unknown; authToken?: unknown } | null;
    const port = o?.minisdPort;
    const token = o?.authToken;
    if (typeof port === 'number' && Number.isFinite(port) && typeof token === 'string' && token.length > 0) {
      return { port, token };
    }
  } catch { /* not the handshake line */ }
  return undefined;
}

function startMinisdProcess(): Promise<number> {
  return new Promise((resolve, reject) => {
    minisd = utilityProcess.fork(join(__dirname, 'minisd.js'), [], { env: { ...process.env, DESKMINIS_STANDALONE: '1' }, stdio: 'pipe' });

    let settled = false;
    const settle = (fn: () => void): void => { if (settled) return; settled = true; clearTimeout(timer); fn(); };
    const timer = setTimeout(() => settle(() => {
      minisd?.kill();
      reject(new Error(`minisd 启动超时：${MINISD_START_TIMEOUT_MS / 1000}s 内没有上报端口（子进程可能卡在 DB / 密钥库初始化）`));
    }), MINISD_START_TIMEOUT_MS);

    // 按「完整行」扫描，而不是只看第一个换行符之前的内容：
    // 子进程只要在握手行之前打印过任何一行日志，旧写法就会把那一行当成 JSON 解析失败，
    // 且 buf 永不推进 —— 端口永远解析不出来，启动永久卡死。现在非握手行一律转发到 stderr。
    let buf = '';
    minisd.stdout?.on('data', (d: Buffer) => {
      buf += d.toString();
      for (let nl = buf.indexOf('\n'); nl >= 0; nl = buf.indexOf('\n')) {
        const line = buf.slice(0, nl).replace(/\r$/, '');
        buf = buf.slice(nl + 1);
        if (line.trim() === '') continue;
        const hs = parseHandshake(line);
        if (hs !== undefined && minisdPort === 0) {
          minisdPort = hs.port;
          minisdToken = hs.token;
          settle(() => resolve(hs.port));
        } else {
          process.stderr.write('[minisd] ' + line + '\n');
        }
      }
    });
    // 转发子进程 stderr：启动失败时这里才是真正的原因所在
    minisd.stderr?.on('data', (d: Buffer) => process.stderr.write('[minisd] ' + d.toString()));
    minisd.on('exit', code => { if (minisdPort === 0) settle(() => reject(new Error(`minisd 退出 code=${code}`))); });
  });
}

async function createWindow(): Promise<void> {
  const win = new BrowserWindow({
    width: 1280, height: 800, minWidth: 900, minHeight: 600,
    // 无边框 + 自绘标题栏（设计 §4.0）：DOM 里不画窗口控制，
    // titleBarOverlay 让系统在右上角绘制原生 min/max/close（透明底、符号色随明暗）。
    frame: false,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#00000000', symbolColor: '#808080', height: 40 },
    webPreferences: { preload: join(__dirname, '../preload/index.cjs') },
  });
  if (process.env.ELECTRON_RENDERER_URL) await win.loadURL(process.env.ELECTRON_RENDERER_URL);
  else await win.loadFile(join(__dirname, '../renderer/index.html'));
}

// 旧通道保留（无害；渲染层重写后会弃用）：只给端口，连不上带 token 认证的 minisd。
ipcMain.handle('minisd:port', () => minisdPort);
// 新通道：端口 + per-run token。preload 的 minisdInfo() invoke 的就是这个通道——
// 少了它，渲染层调用命中一个未注册的通道、静默失败、每个 WS 连接被 401，应用连不上 minisd。
ipcMain.handle('minisd:info', () => ({ port: minisdPort, token: minisdToken }));

app.whenReady().then(async () => {
  // 不 catch 的话：minisd 起不来 → 这里抛出 → createWindow 永远不执行 →
  // 应用「启动了但什么都不显示」，用户和开发者都拿不到任何线索。
  try {
    await startMinisdProcess();
    await createWindow();
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) void createWindow(); });
  } catch (e) {
    const message = e instanceof Error ? (e.stack ?? e.message) : String(e);
    process.stderr.write('DeskMinis 启动失败: ' + message + '\n');
    dialog.showErrorBox('DeskMinis 启动失败', message);
    minisd?.kill();
    app.quit();
  }
});
app.on('window-all-closed', () => { /* 关窗不杀 minisd：托盘常驻在 M2 补，M1 直接退出 */ if (process.platform !== 'darwin') { minisd?.kill(); app.quit(); } });
