import { contextBridge, ipcRenderer } from 'electron';
import { createThemeController, type ApplyPayload } from './controller';
import { createLauncher } from './launcher';
import { zeroRuntime } from './runtime';
import { customActivity, type SettingValue } from '../shared/builtins';

interface BuiltinsPayload { plugins: Record<string, Record<string, SettingValue>>; game: { id: string; name: string; start: number } | null }

/**
 * Preload for the Discord window. Runs in an isolated world: it shares the DOM with Discord but exposes nothing
 * to Discord's JavaScript (no contextBridge), and it never reads page content, storage, cookies or tokens.
 * It receives stylesheet updates from ZERO's main process, manages its own <style> element, and adds the
 * ZERO button to the user panel.
 */
// Screen share with sound: ask Chromium to leave this page's own audio (the voice call) out of the captured
// system audio, so viewers don't hear the call echoed through the stream. This is the only thing ZERO runs in
// Discord's page world: it adds one standard constraint to getDisplayMedia and exposes nothing.
try {
  contextBridge.executeInMainWorld({
    func: () => {
      const proto = MediaDevices.prototype;
      const original = proto.getDisplayMedia;
      if (typeof original !== 'function') return;
      Object.defineProperty(proto, 'getDisplayMedia', {
        configurable: true, writable: true,
        value: function getDisplayMedia(this: MediaDevices, constraints?: DisplayMediaStreamOptions) {
          const c: any = constraints && typeof constraints === 'object' ? { ...constraints } : {};
          if (c.audio) { c.audio = { ...(typeof c.audio === 'object' ? c.audio : {}), restrictOwnAudio: true }; c.systemAudio ??= 'include'; }
          return original.call(this, c);
        },
      });
    },
  });
} catch { /* older runtime: sharing still works, without the echo filter */ }

// Built-in plugins (Settings > Plugins). The runtime gets only the enabled plugins as a JSON string event and can
// only ask for a reload; see runtime.ts. Nothing runs while every plugin is off.
try { contextBridge.executeInMainWorld({ func: zeroRuntime }); } catch { /* plugins unavailable on this runtime */ }
let rpcStart = 0;
function sendBuiltins(p: BuiltinsPayload | undefined): void {
  if (!p) return;
  const plugins: Record<string, Record<string, unknown>> = { ...p.plugins };
  if (plugins.customRpc) {
    rpcStart ||= Date.now();
    plugins.customRpc = { activity: customActivity(p.plugins.customRpc!, rpcStart) };
  } else rpcStart = 0;
  document.dispatchEvent(new CustomEvent('zero:cfg', { detail: JSON.stringify({ plugins, game: p.game }) }));
}
document.addEventListener('zero:crash', () => ipcRenderer.send('zero:crash'));
ipcRenderer.on('zero:builtins', (_e, p: BuiltinsPayload) => sendBuiltins(p));

// ZERO's logo on Discord's home button (top of the server list), for every theme.
const LOGO = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256"><rect width="256" height="256" fill="#15171c"/><path d="M84 52h88c22.1 0 40 17.9 40 40v58c0 22.1-17.9 40-40 40h-52l-34.6 25.4c-3.3 2.4-7.9 0-7.9-4.1V188.6C62.4 184.2 44 169.4 44 150V92c0-22.1 17.9-40 40-40z" fill="#7c8cff"/><path d="M92 86h74v15.5l-50.5 50H166V168H90v-15.5l50.5-50H92z" fill="#15171c"/></svg>';
function addBrand(): void {
  if (document.getElementById('zero-brand')) return;
  const st = document.createElement('style');
  st.id = 'zero-brand';
  const home = '[data-list-item-id="guildsnav___home"]';
  const box = `${home}[class*="childWrapper_"],${home} [class*="childWrapper_"]`;
  st.textContent = `${box}{background:#15171c url("data:image/svg+xml,${encodeURIComponent(LOGO)}") center/cover no-repeat!important}`
    + `${home}[class*="childWrapper_"] svg,${home} [class*="childWrapper_"] svg{visibility:hidden!important}`;
  (document.head ?? document.documentElement).appendChild(st);
}
if (document.documentElement) addBrand(); else document.addEventListener('DOMContentLoaded', addBrand, { once: true });

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
ipcRenderer.invoke('zero:init').then((p: (ApplyPayload & { route: string; hint: boolean; builtins?: BuiltinsPayload }) | null) => {
  if (!p) return;
  controller.setRoute(p.route);
  controller.apply(p);
  launcher.setHint(p.hint);
  sendBuiltins(p.builtins);
}).catch(() => { /* main process unavailable: Discord keeps its default look */ });
