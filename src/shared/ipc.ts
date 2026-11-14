/** Allowlisted IPC channels between the settings UI and the main process. */
export const CHANNELS = [
  'state:get', 'settings:close', 'update:check', 'update:open', 'theme:update', 'theme:select', 'theme:duplicate', 'theme:rename', 'theme:delete',
  'theme:import', 'theme:export', 'layout:select', 'layout:save', 'layout:delete', 'perf:snapshot',
  'perf:set', 'general:set', 'bg:import', 'bg:list', 'plugins:setEnabled', 'plugins:grant', 'plugins:openFolder', 'plugins:reload',
  'backups:list', 'backups:restore', 'recovery:safeMode', 'compat:check', 'discord:reload', 'logs:open',
] as const;
export type Channel = (typeof CHANNELS)[number];
