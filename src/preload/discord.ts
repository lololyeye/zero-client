import { ipcRenderer } from 'electron';
import { createThemeController, type ApplyPayload } from './controller';
import { createLauncher } from './launcher';

/**
 * Preload for the Discord window. Runs in an isolated world: it shares the DOM with Discord but exposes nothing
 * to Discord's JavaScript (no contextBridge), and it never reads page content, storage, cookies or tokens.
 * It receives stylesheet updates from ZERO's main process, manages its own <style> element, and adds the
 * ZERO button to the user panel.
 */
const controller = createThemeController(document);
const launcher = createLauncher(document, {
  open: () => ipcRenderer.send('zero:openSettings'),
  hintDone: () => ipcRenderer.send('zero:hintDone'),
});

ipcRenderer.on('zero:apply', (_e, p: ApplyPayload) => controller.apply(p));
ipcRenderer.on('zero:route', (_e, route: string) => controller.setRoute(route));
ipcRenderer.on('zero:hint', (_e, show: boolean) => launcher.setHint(show));

window.addEventListener('focus', () => controller.setFocused(true));
window.addEventListener('blur', () => controller.setFocused(false));

// Initial state on every (re)load of the document: the theme is restored before Discord finishes rendering.
ipcRenderer.invoke('zero:init').then((p: (ApplyPayload & { route: string; hint: boolean }) | null) => {
  if (!p) return;
  controller.setRoute(p.route);
  controller.apply(p);
  launcher.setHint(p.hint);
}).catch(() => { /* main process unavailable: Discord keeps its default look */ });
