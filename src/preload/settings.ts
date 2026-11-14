import { contextBridge, ipcRenderer } from 'electron';
import { CHANNELS, type Channel } from '../shared/ipc';

// The settings UI only receives a narrow invoke() over an allowlist. No Node, no fs, no Discord access.
contextBridge.exposeInMainWorld('zero', {
  invoke: (channel: Channel, ...args: unknown[]) => {
    if (!CHANNELS.includes(channel)) return Promise.reject(new Error('Blocked channel'));
    return ipcRenderer.invoke(channel, ...args);
  },
  onState: (cb: (s: unknown) => void) => {
    const h = (_e: unknown, s: unknown) => cb(s);
    ipcRenderer.on('state:changed', h);
    return () => ipcRenderer.removeListener('state:changed', h);
  },
});
