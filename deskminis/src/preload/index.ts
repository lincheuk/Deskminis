import { contextBridge, ipcRenderer } from 'electron';
contextBridge.exposeInMainWorld('deskminis', {
  minisdPort: (): Promise<number> => ipcRenderer.invoke('minisd:port'),
});
