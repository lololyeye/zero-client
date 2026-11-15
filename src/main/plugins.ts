import { promises as fs } from 'node:fs';
import path from 'node:path';
import { lintCustomCss } from '../shared/theme';
import { validateManifest, type PluginInfo, type Permission } from '../shared/plugin';

const MAX_STYLE_BYTES = 100_000;

export interface LoadedPlugins {
  infos: PluginInfo[];
  /** css by plugin id (only for plugins that are enabled, granted ui.css and valid) */
  css: Map<string, string>;
}

/**
 * Discovers declarative plugins in <dir>/<id>/plugin.json. One broken plugin never affects the others
 * or startup: every failure is captured into that plugin's info.error.
 */
export async function loadPlugins(
  dir: string,
  state: { enabled: Record<string, boolean>; granted: Record<string, string[]> },
  safeMode: boolean,
  platform: 'win32' | 'linux' = process.platform === 'linux' ? 'linux' : 'win32',
): Promise<LoadedPlugins> {
  const infos: PluginInfo[] = [];
  const css = new Map<string, string>();
  let entries: string[] = [];
  try { entries = await fs.readdir(dir); } catch { return { infos, css }; }
  for (const name of entries) {
    const pdir = path.join(dir, name);
    try {
      if (!(await fs.stat(pdir)).isDirectory()) continue;
      const manifest = validateManifest(JSON.parse(await fs.readFile(path.join(pdir, 'plugin.json'), 'utf8')));
      if (manifest.id !== name) throw new Error(`folder name "${name}" must equal plugin id "${manifest.id}"`);
      const granted = new Set(state.granted[manifest.id] ?? []);
      const missing = manifest.permissions.filter((p) => !granted.has(p)) as Permission[];
      const wanted = state.enabled[manifest.id] === true && !safeMode;
      const info: PluginInfo = { manifest, status: wanted ? 'enabled' : 'disabled', missingPermissions: missing };
      if (wanted && missing.length) info.status = 'needs-permission';
      // A plugin made for another system is listed but never started.
      if (manifest.platforms && !manifest.platforms.includes(platform)) {
        infos.push({ ...info, status: 'incompatible', error: `Made for ${manifest.platforms.map((p) => (p === 'win32' ? 'Windows' : 'Linux')).join(' and ')} only.` });
        continue;
      }
      if (info.status === 'enabled' && manifest.styles && manifest.permissions.includes('ui.css')) {
        try {
          const file = path.resolve(pdir, manifest.styles);
          if (!file.startsWith(path.resolve(pdir) + path.sep)) throw new Error('styles path escapes the plugin folder');
          const st = await fs.stat(file);
          if (st.size > MAX_STYLE_BYTES) throw new Error('stylesheet too large');
          const text = await fs.readFile(file, 'utf8');
          const errors = lintCustomCss(text).filter((i) => i.level === 'error');
          if (errors.length) throw new Error(errors.map((e) => e.message).join(' '));
          css.set(manifest.id, text);
        } catch (err) {
          info.status = 'error';
          info.error = (err as Error).message;
        }
      }
      infos.push(info);
    } catch (err) {
      const msg = (err as Error).message;
      infos.push({
        manifest: { id: name, name, version: '0.0.0', description: 'Invalid plugin', author: 'unknown', apiVersion: 0, permissions: [] },
        status: /apiVersion/.test(msg) ? 'incompatible' : 'error', error: msg, missingPermissions: [],
      });
    }
  }
  return { infos, css };
}
