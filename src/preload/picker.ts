import { contextBridge, ipcRenderer } from 'electron';

// The screen-share picker can only list capture sources and give one answer. No Node, no other channels.
contextBridge.exposeInMainWorld('picker', {
  load: () => ipcRenderer.invoke('picker:load'),
  choose: (id: string | null, audio: boolean) => ipcRenderer.send('picker:choose', typeof id === 'string' ? id : null, audio === true),
  // StreamPresets (only answered while that plugin is on): save the selected source, or delete a preset.
  savePreset: (id: string, name: string, audio: boolean) => ipcRenderer.invoke('picker:savePreset', String(id), String(name), audio === true),
  deletePreset: (presetId: string) => ipcRenderer.invoke('picker:deletePreset', String(presetId)),
});
