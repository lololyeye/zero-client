import { promises as fs } from 'node:fs';
import path from 'node:path';
import { emptyData, MAX_DOC_CHARS, sanitizeAllData, sanitizeData, type DataPlugin, type PluginData } from '../shared/pluginData';

/**
 * plugin-data.json: what MessageReminder, SmartBookmarks, QuickNotes and SmartText keep across restarts.
 * Atomic writes (temp file + rename), one previous copy kept, a corrupt file is set aside instead of overwritten.
 */
export class PluginDataStore {
  private data: PluginData = sanitizeAllData({});
  private readonly file: string;
  private timer: NodeJS.Timeout | undefined;
  private chain: Promise<void> = Promise.resolve();

  constructor(dir: string, private readonly onError: (err: unknown) => void = () => {}) {
    this.file = path.join(dir, 'plugin-data.json');
  }

  async load(): Promise<void> {
    for (const f of [this.file, this.file + '.bak']) {
      let text: string;
      try { text = await fs.readFile(f, 'utf8'); } catch { continue; }
      try { this.data = sanitizeAllData(JSON.parse(text)); return; } catch {
        await fs.rename(f, `${f}.corrupt-${Date.now()}`).catch(() => undefined);
      }
    }
  }

  get<K extends DataPlugin>(k: K): PluginData[K] { return this.data[k] ?? emptyData(k); }

  /** From ZERO itself (already typed); still passed through the schema. */
  set<K extends DataPlugin>(k: K, value: PluginData[K]): void {
    this.data = { ...this.data, [k]: sanitizeData(k, value) };
    this.saveSoon();
  }

  /** From the Discord page: a JSON string, validated and trimmed to the schema. Returns false when refused. */
  setFromPage(k: DataPlugin, json: string): boolean {
    if (json.length > MAX_DOC_CHARS) return false;
    let raw: unknown;
    try { raw = JSON.parse(json); } catch { return false; }
    this.data = { ...this.data, [k]: sanitizeData(k, raw) };
    this.saveSoon();
    return true;
  }

  saveSoon(delay = 1000): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), delay);
  }

  flush(): Promise<void> {
    clearTimeout(this.timer);
    const text = JSON.stringify(this.data);
    this.chain = this.chain.then(async () => {
      const tmp = this.file + '.tmp';
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      await fs.writeFile(tmp, text, 'utf8');
      await fs.copyFile(this.file, this.file + '.bak').catch(() => undefined);
      await fs.rename(tmp, this.file);
    }).catch(this.onError);
    return this.chain;
  }
}
