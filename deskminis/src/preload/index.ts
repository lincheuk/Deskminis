import { contextBridge, ipcRenderer } from 'electron';

export interface MinisdInfo { port: number; token: string }

contextBridge.exposeInMainWorld('deskminis', {
  // 旧接口保留：只给端口，连不上带 token 认证的 minisd（仅作兼容/降级用）
  minisdPort: (): Promise<number> => ipcRenderer.invoke('minisd:port'),
  // 新接口：端口 + per-run token。主进程需提供 ipcMain.handle('minisd:info', ...)
  minisdInfo: (): Promise<MinisdInfo> => ipcRenderer.invoke('minisd:info'),
  // MU2b Task 5：托盘菜单死通道接通（main 已在 menu:open-settings / menu:toggle-right 上 send，本 Task 仅追加订阅）。
  // 返回取消订阅函数（removeListener 对称移除同一 listener 引用）。
  onMenuOpenSettings: (cb: () => void): (() => void) => {
    const listener = (): void => { cb(); };
    ipcRenderer.on('menu:open-settings', listener);
    return () => { ipcRenderer.removeListener('menu:open-settings', listener); };
  },
  onMenuToggleRight: (cb: () => void): (() => void) => {
    const listener = (): void => { cb(); };
    ipcRenderer.on('menu:toggle-right', listener);
    return () => { ipcRenderer.removeListener('menu:toggle-right', listener); };
  },
});
