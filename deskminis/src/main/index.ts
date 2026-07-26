import { app, BrowserWindow, ipcMain, utilityProcess, type UtilityProcess } from 'electron';
import { join } from 'node:path';

let minisd: UtilityProcess | undefined;
let minisdPort = 0;

function startMinisdProcess(): Promise<number> {
  return new Promise((resolve, reject) => {
    minisd = utilityProcess.fork(join(__dirname, 'minisd.js'), [], { env: { ...process.env, DESKMINIS_STANDALONE: '1' }, stdio: 'pipe' });
    let buf = '';
    minisd.stdout?.on('data', (d: Buffer) => {
      buf += d.toString();
      const nl = buf.indexOf('\n');
      if (nl >= 0 && minisdPort === 0) {
        try { minisdPort = JSON.parse(buf.slice(0, nl)).minisdPort; resolve(minisdPort); } catch { /* 等更多输出 */ }
      }
    });
    minisd.on('exit', code => { if (minisdPort === 0) reject(new Error(`minisd 退出 code=${code}`)); });
  });
}

async function createWindow(): Promise<void> {
  const win = new BrowserWindow({ width: 1280, height: 800, webPreferences: { preload: join(__dirname, '../preload/index.js') } });
  if (process.env.ELECTRON_RENDERER_URL) await win.loadURL(process.env.ELECTRON_RENDERER_URL);
  else await win.loadFile(join(__dirname, '../renderer/index.html'));
}

ipcMain.handle('minisd:port', () => minisdPort);

app.whenReady().then(async () => {
  await startMinisdProcess();
  await createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { /* 关窗不杀 minisd：托盘常驻在 M2 补，M1 直接退出 */ if (process.platform !== 'darwin') { minisd?.kill(); app.quit(); } });
