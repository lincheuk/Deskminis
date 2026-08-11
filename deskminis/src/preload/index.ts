import { contextBridge, ipcRenderer } from 'electron';

export interface MinisdInfo { port: number; token: string }

contextBridge.exposeInMainWorld('deskminis', {
  // 旧接口保留：只给端口，连不上带 token 认证的 minisd（仅作兼容/降级用）
  minisdPort: (): Promise<number> => ipcRenderer.invoke('minisd:port'),
  // 新接口：端口 + per-run token。主进程需提供 ipcMain.handle('minisd:info', ...)
  minisdInfo: (): Promise<MinisdInfo> => ipcRenderer.invoke('minisd:info'),
  // 工作区目录选择器：取消返回 null（不是空串——空串会被当成「清空工作区」）
  pickFolder: (): Promise<string | null> => ipcRenderer.invoke('dialog:pickFolder'),
  // 自动更新：开关归主进程管（它才是做检查的那一方），渲染端只读写与手动触发
  getUpdatePrefs: (): Promise<{ autoCheck: boolean; version: string; state: { status: string; version?: string; error?: string } }> =>
    ipcRenderer.invoke('update:getPrefs'),
  setUpdateEnabled: (on: boolean): Promise<{ autoCheck: boolean }> => ipcRenderer.invoke('update:setEnabled', on),
  checkForUpdates: (): Promise<{ status: string; version?: string; error?: string }> => ipcRenderer.invoke('update:check'),
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
  // MU2b Task 6：图片粘贴/拖拽附件落盘（main 白名单一处 handler 的渲染端入口；返回会话相对路径）。
  saveAttachment: (sessionId: string, dataUrl: string): Promise<string> =>
    ipcRenderer.invoke('attachments:save', sessionId, dataUrl),
});
