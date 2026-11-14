import { ipcRenderer } from 'electron';
import { createThemeController, type ApplyPayload } from './controller';

/**
 * Preload for the Discord window. Runs in an isolated world: it shares the DOM with Discord but exposes nothing
 * to Discord's JavaScript (no contextBridge), and it never reads page content, storage, cookies or tokens.
 * It only receives stylesheet updates from ZERO's main process and manages its own <style> element.
 */
const controller = createThemeController(document);

ipcRenderer.on('zero:apply', (_e, p: ApplyPayload) => controller.apply(p));
ipcRenderer.on('zero:route', (_e, route: string) => controller.setRoute(route));

window.addEventListener('focus', () => controller.setFocused(true));
window.addEventListener('blur', () => controller.setFocused(false));

// Initial state on every (re)load of the document: the theme is restored before Discord finishes rendering.
ipcRenderer.invoke('zero:init').then((p: (ApplyPayload & { route: string }) | null) => {
  if (!p) return;
  controller.setRoute(p.route);
  controller.apply(p);
}).catch(() => { /* main process unavailable: Discord keeps its default look */ });
