import { contextBridge, ipcRenderer } from 'electron';

const ACTIONS = ['install', 'later', 'retry', 'hide', 'done'] as const;

// The update screen can read the updater state and send one of five actions. Nothing else.
contextBridge.exposeInMainWorld('zeroUpdate', {
  get: () => ipcRenderer.invoke('updater:get'),
  act: (action: string) => { if ((ACTIONS as readonly string[]).includes(action)) ipcRenderer.send('updater:act', action); },
  onState: (cb: (s: unknown) => void) => { ipcRenderer.on('updater:state', (_e, s) => cb(s)); },
});
