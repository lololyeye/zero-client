import { describe, expect, it } from 'vitest';
import { DATA_PLUGINS, expandSnippet, isDataPlugin, reminderDue, sanitizeAllData, sanitizeData } from '../src/shared/pluginData';
import { BUILTINS } from '../src/shared/builtins';
import { zeroRuntime } from '../src/preload/runtime';

const ref = { channelId: '123456789012345678', messageId: '223456789012345678', guildId: '323456789012345678', author: 'Ann', authorId: '423456789012345678', content: 'hi', at: 1 };

describe('plugin data', () => {
  it('only the four data plugins can store anything, and each is a built-in', () => {
    expect(isDataPlugin('quickNotes')).toBe(true);
    expect(isDataPlugin('messageLogger')).toBe(false);
    expect(isDataPlugin('__proto__')).toBe(false);
    for (const k of DATA_PLUGINS) expect(BUILTINS.some((b) => b.id === k)).toBe(true);
    expect(Object.keys(sanitizeAllData({ evil: { x: 1 }, quickNotes: { notes: [] } })).sort()).toEqual([...DATA_PLUGINS].sort());
  });

  it('keeps fixed fields only and drops invalid entries', () => {
    const r = sanitizeData('messageReminder', { reminders: [
      { ...ref, id: 'a1', due: 5, note: 'x'.repeat(999), token: 'secret', extra: { a: 1 } },
      { ...ref, id: 'bad id!', due: 5 },
      { ...ref, channelId: '../../etc', id: 'a2', due: 5 },
      { ...ref, id: 'a3', due: -1 },
      { ...ref, id: 'a1', due: 6 },
    ] });
    expect(r.reminders).toHaveLength(1);
    expect(r.reminders[0]).not.toHaveProperty('token');
    expect(r.reminders[0]).not.toHaveProperty('extra');
    expect(r.reminders[0]!.note).toHaveLength(300);
  });

  it('keeps only Discord CDN attachment links and http(s) links', () => {
    const b = sanitizeData('smartBookmarks', { collections: ['Work', 'Work', ''], items: [{
      ...ref, id: 'b1', collection: 'Nope',
      attachments: [
        { name: 'a.png', url: 'https://cdn.discordapp.com/attachments/1/2/a.png?ex=1', kind: 'image' },
        { name: 'x', url: 'https://evil.example/x.png', kind: 'image' },
        { name: 'y', url: 'javascript:alert(1)', kind: 'file' },
      ],
      links: ['https://example.com/a', 'javascript:alert(1)', 'file:///C:/x'],
    }] });
    expect(b.collections).toEqual(['Saved', 'Work']);
    expect(b.items[0]!.collection).toBe('Saved');
    expect(b.items[0]!.attachments.map((a) => a.name)).toEqual(['a.png']);
    expect(b.items[0]!.links).toEqual(['https://example.com/a']);
  });

  it('caps sizes', () => {
    const notes = Array.from({ length: 500 }, (_, i) => ({ id: 'n' + i, text: 'x'.repeat(30_000), updated: 1 }));
    const n = sanitizeData('quickNotes', { notes });
    expect(n.notes).toHaveLength(200);
    expect(n.notes[0]!.text).toHaveLength(20_000);
    const done = Array.from({ length: 200 }, (_, i) => ({ ...ref, id: 'd' + i, due: i + 1, done: true }));
    expect(sanitizeData('messageReminder', { reminders: done }).reminders).toHaveLength(50);
  });

  it('snippet names are a single word and variables expand', () => {
    const s = sanitizeData('smartText', { snippets: [{ id: 's1', name: ' Sup Port!', text: 'Hi {user}, {ME} here {nope}' }, { id: 's2', name: '***', text: 'x' }] });
    expect(s.snippets.map((x) => x.name)).toEqual(['support']);
    expect(expandSnippet(s.snippets[0]!.text, { user: 'Bob', me: 'Ann' })).toBe('Hi Bob, Ann here {nope}');
    expect(expandSnippet('{constructor}', {})).toBe('{constructor}');
  });

  it('reminder presets', () => {
    const now = new Date(2026, 10, 15, 22, 30); // a Sunday
    expect(reminderDue('10m', now)).toBe(now.getTime() + 600_000);
    expect(new Date(reminderDue('tomorrow', now)!).getDate()).toBe(16);
    expect(new Date(reminderDue('tomorrow', now)!).getHours()).toBe(9);
    expect(new Date(reminderDue('monday', now)!).getDay()).toBe(1);
    expect(new Date(reminderDue('monday', new Date(2026, 10, 16, 8))!).getDate()).toBe(23);
    expect(reminderDue('0m', now)).toBeNull();
    expect(reminderDue('soon', now)).toBeNull();
  });

  it('the page runtime stays self-contained and has the new plugins', () => {
    const src = String(zeroRuntime);
    for (const id of ['messageReminder', 'smartBookmarks', 'quickNotes', 'smartText', 'privacyMode']) expect(src).toContain('plugins.' + id);
    expect(src).not.toMatch(/\brequire\(|\bipcRenderer\b|localStorage|document\.cookie/);
  });
});

describe('plugin data file', () => {
  it('saves, reloads, refuses oversize or broken JSON, and survives a corrupt file', async () => {
    const { PluginDataStore } = await import('../src/main/pluginData');
    const fs = await import('node:fs/promises'); const os = await import('node:os'); const path = await import('node:path');
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'zero-pd-'));
    const a = new PluginDataStore(dir);
    expect(a.setFromPage('quickNotes', JSON.stringify({ notes: [{ id: 'n1', text: 'hello', updated: 5 }] }))).toBe(true);
    expect(a.setFromPage('quickNotes', '{nope')).toBe(false);
    expect(a.setFromPage('quickNotes', 'x'.repeat(2_000_000))).toBe(false);
    await a.flush();
    const b = new PluginDataStore(dir); await b.load();
    expect(b.get('quickNotes').notes[0]!.text).toBe('hello');
    b.setFromPage('quickNotes', JSON.stringify({ notes: [{ id: 'n2', text: 'second', updated: 6 }] }));
    await b.flush();
    await fs.writeFile(path.join(dir, 'plugin-data.json'), '{corrupt');
    const c = new PluginDataStore(dir); await c.load();
    expect(c.get('quickNotes').notes[0]!.text).toBe('hello'); // previous copy
    expect((await fs.readdir(dir)).some((f) => f.includes('.corrupt-'))).toBe(true);
    await fs.rm(dir, { recursive: true, force: true });
  });
});
