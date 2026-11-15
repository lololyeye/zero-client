import { contextBridge, ipcRenderer } from 'electron';

// The voice overlay page can only receive the list it draws. It sends nothing.
contextBridge.exposeInMainWorld('overlay', {
  onData: (cb: (d: unknown) => void) => { ipcRenderer.on('overlay:data', (_e, d) => cb(d)); },
});
