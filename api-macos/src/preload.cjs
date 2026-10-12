const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('api', { invoke: (command, values) => ipcRenderer.invoke('api:invoke', command, values) });
