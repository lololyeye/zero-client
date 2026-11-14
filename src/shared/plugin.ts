/**
 * Plugin manifest + permission model.
 * Plugins run in an isolated, sandboxed context (never in Discord's page, never in the main process).
 * They declare permissions; the user grants them. No permission ever exposes credentials.
 */
export const PLUGIN_API_VERSION = 1;

export const PERMISSIONS = {
  'ui.css': 'Inject extra styles into the Discord window',
  'ui.panel': 'Show an additional panel in ZERO settings',
  'storage.local': 'Store its own settings locally',
  'theme.read': 'Read the active theme colors',
  'shortcuts': 'Register keyboard shortcuts inside ZERO',
} as const;
export type Permission = keyof typeof PERMISSIONS;

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  description: string;
  author: string;
  apiVersion: number;
  permissions: Permission[];
  /** reserved for a scripted runtime (not loaded in v1; v1 plugins are declarative) */
  entry?: string;
  styles?: string;
}

export class PluginManifestError extends Error {
  constructor(public readonly issues: string[]) { super(`Invalid plugin manifest: ${issues.join('; ')}`); }
}

const SEMVER = /^\d+\.\d+\.\d+$/;
const PID = /^[a-z0-9][a-z0-9-]{1,48}$/;
const REL = /^(?!.*\.\.)(?![\\/])(?![a-z]:)[\w./-]{1,120}$/i;

export function validateManifest(input: unknown): PluginManifest {
  const issues: string[] = [];
  const m = (typeof input === 'object' && input !== null ? input : {}) as Record<string, any>;
  if (typeof m.id !== 'string' || !PID.test(m.id)) issues.push('id must be lowercase letters, digits, dashes');
  for (const k of ['name', 'description', 'author']) {
    if (typeof m[k] !== 'string' || !m[k].trim() || m[k].length > 200) issues.push(`${k} is required (max 200 chars)`);
  }
  if (typeof m.version !== 'string' || !SEMVER.test(m.version)) issues.push('version must be semver x.y.z');
  if (m.apiVersion !== PLUGIN_API_VERSION) issues.push(`apiVersion must be ${PLUGIN_API_VERSION}`);
  const perms: Permission[] = [];
  if (!Array.isArray(m.permissions)) issues.push('permissions must be an array');
  else for (const p of m.permissions) {
    if (typeof p === 'string' && p in PERMISSIONS) perms.push(p as Permission);
    else issues.push(`unknown permission ${String(p)}`);
  }
  if (m.entry !== undefined && (typeof m.entry !== 'string' || !REL.test(m.entry) || !/\.(m?js)$/i.test(m.entry))) issues.push('entry must be a relative .js path');
  if (m.styles !== undefined && (typeof m.styles !== 'string' || !REL.test(m.styles) || !/\.css$/i.test(m.styles))) issues.push('styles must be a relative .css path');
  if (issues.length) throw new PluginManifestError(issues);
  return { id: m.id, name: m.name.trim(), version: m.version, description: m.description.trim(), author: m.author.trim(), apiVersion: m.apiVersion, permissions: perms, entry: m.entry, styles: m.styles };
}

export type PluginStatus = 'enabled' | 'disabled' | 'error' | 'incompatible' | 'needs-permission';

export interface PluginInfo {
  manifest: PluginManifest;
  status: PluginStatus;
  error?: string;
  missingPermissions: Permission[];
}
