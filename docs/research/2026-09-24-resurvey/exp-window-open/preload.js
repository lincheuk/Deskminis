const { contextBridge } = require('electron');
contextBridge.exposeInMainWorld('marker', { secret: () => 'TOKEN-LEAK' });
