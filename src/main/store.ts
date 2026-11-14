import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ConfigTooNewError, defaultConfig, migrateConfig, type Config } from '../shared/config';

export interface LoadReport {
  config: Config;
  /** human-readable events: migration, restored backup, corrupt file preserved */
  notes: string[];
}

const MAX_BACKUPS = 8;

/**
 * Settings persistence: atomic writes, rolling backups, corruption recovery.
 * Never silently overwrites: a config that cannot be read is preserved as *.corrupt-<time> and
 * the latest good backup is used; a migration always takes a backup first.
 */
export class ConfigStore {
  private readonly file: string;
  private readonly backupDir: string;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(private readonly dir: string, private readonly backupIntervalMs = 10 * 60_000) {
    this.file = path.join(dir, 'config.json');
    this.backupDir = path.join(dir, 'backups');
  }

  async load(): Promise<LoadReport> {
    await fs.mkdir(this.backupDir, { recursive: true });
    const notes: string[] = [];
    let text: string | null = null;
    try { text = await fs.readFile(this.file, 'utf8'); } catch { /* first run */ }
    if (text === null) {
      const config = defaultConfig();
      await this.save(config, false);
      return { config, notes: ['Created default configuration.'] };
    }
    try {
      const raw = JSON.parse(text);
      const { config, migratedFrom } = migrateConfig(raw);
      if (migratedFrom !== null) {
        await this.backup(text, `pre-migration-v${migratedFrom}`);
        await this.save(config, false);
        notes.push(`Settings migrated from version ${migratedFrom}. A backup of the old file was kept.`);
      }
      return { config, notes };
    } catch (err) {
      if (err instanceof ConfigTooNewError) throw err; // never downgrade over newer data
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      await fs.rename(this.file, `${this.file}.corrupt-${stamp}`).catch(() => undefined);
      notes.push(`Settings file was unreadable and has been preserved as config.json.corrupt-${stamp}.`);
      for (const b of await this.listBackups()) {
        try {
          const { config } = migrateConfig(JSON.parse(await fs.readFile(path.join(this.backupDir, b), 'utf8')));
          await this.save(config, false);
          notes.push(`Restored from backup ${b}.`);
          return { config, notes };
        } catch { /* try older backup */ }
      }
      const config = defaultConfig();
      await this.save(config, false);
      notes.push('No usable backup found; defaults were restored.');
      return { config, notes };
    }
  }

  private lastAutoBackup = 0;

  /**
   * Serialised, atomic write (tmp + rename). With rotate, the previous content is backed up, at most once per
   * backupIntervalMs: live editing saves often, and a backup per slider tick would push useful snapshots out.
   */
  save(config: Config, rotate = true): Promise<void> {
    const run = async () => {
      if (rotate && Date.now() - this.lastAutoBackup >= this.backupIntervalMs) {
        try { await this.backup(await fs.readFile(this.file, 'utf8'), 'auto'); this.lastAutoBackup = Date.now(); } catch { /* nothing to back up */ }
      }
      const tmp = `${this.file}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(config, null, 2), 'utf8');
      await fs.rename(tmp, this.file);
    };
    this.writeChain = this.writeChain.then(run, run);
    return this.writeChain;
  }

  async listBackups(): Promise<string[]> {
    try { return (await fs.readdir(this.backupDir)).filter((f) => f.endsWith('.json')).sort().reverse(); } catch { return []; }
  }

  private async backup(content: string, label: string): Promise<void> {
    await fs.mkdir(this.backupDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    await fs.writeFile(path.join(this.backupDir, `${stamp}-${label}.json`), content, 'utf8');
    const all = await this.listBackups();
    for (const old of all.slice(MAX_BACKUPS)) await fs.unlink(path.join(this.backupDir, old)).catch(() => undefined);
  }

  async restoreBackup(name: string): Promise<Config> {
    if (!/^[\w.-]+\.json$/.test(name)) throw new Error('Invalid backup name');
    const text = await fs.readFile(path.join(this.backupDir, name), 'utf8');
    const { config } = migrateConfig(JSON.parse(text));
    this.lastAutoBackup = 0; // always keep the state we are replacing
    await this.save(config, true);
    return config;
  }
}
