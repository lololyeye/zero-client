import { contextBridge, ipcRenderer } from 'electron';

// The screen-share picker can only list capture sources and give one answer. No Node, no other channels.
contextBridge.exposeInMainWorld('picker', {
  load: () => ipcRenderer.invoke('picker:load'),
  choose: (id: string | null, audio: boolean) => ipcRenderer.send('picker:choose', typeof id === 'string' ? id : null, audio === true),
});
