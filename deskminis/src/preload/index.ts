import { contextBridge, ipcRenderer } from 'electron';

export interface MinisdInfo { port: number; token: string }

contextBridge.exposeInMainWorld('deskminis', {
  // 旧接口保留：只给端口，连不上带 token 认证的 minisd（仅作兼容/降级用）
  minisdPort: (): Promise<number> => ipcRenderer.invoke('minisd:port'),
  // 新接口：端口 + per-run token。主进程需提供 ipcMain.handle('minisd:info', ...)
  minisdInfo: (): Promise<MinisdInfo> => ipcRenderer.invoke('minisd:info'),
});
