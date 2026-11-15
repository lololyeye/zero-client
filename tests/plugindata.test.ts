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

describe('page runtime', () => {
  it('has no block function named like a runtime-level one (sloppy-mode hoisting would replace it)', async () => {
    const fs = await import('node:fs/promises');
    const src = await fs.readFile('src/preload/runtime.ts', 'utf8');
    const top = new Set<string>(); const block: string[] = [];
    for (const l of src.split('\n')) {
      const m = /^( +)(?:async )?function (\w+)/.exec(l);
      if (!m) continue;
      if (m[1]!.length === 2) top.add(m[2]!); else block.push(m[2]!);
    }
    expect(top.has('apply')).toBe(true);
    expect(block.filter((n) => top.has(n))).toEqual([]);
  });
});

describe('voice and stream plugin data', () => {
  it('call summaries keep numbers and server regions only', () => {
    const v = sanitizeData('voiceAnalytics', { calls: [
      { id: 'c1', start: 1000, end: 61_000, place: 'Server › General', pingAvg: 42.4, pingMax: 9e9, lossAvg: 150, servers: ['rotterdam', '10.0.0.1', 'US-East'], disconnects: 2, reconnects: 1, participants: ['x'] },
      { id: 'c2', start: 5000, end: 1000 },
    ] });
    expect(v.calls).toHaveLength(1);
    expect(v.calls[0]).toEqual({ id: 'c1', start: 1000, end: 61_000, place: 'Server › General', pingAvg: 42, pingMax: null, lossAvg: null, lossMax: null, servers: ['rotterdam'], disconnects: 2, reconnects: 1 });
  });
  it('mic profiles are clamped to valid Discord values', () => {
    const m = sanitizeData('micStudio', { profiles: [{ id: 'p1', name: 'Gaming', inputVolume: 999, threshold: 50, mode: 'HACK', noiseCancellation: true }] });
    expect(m.profiles[0]).toMatchObject({ inputVolume: 200, threshold: 0, mode: 'VOICE_ACTIVITY', noiseCancellation: true, inputDeviceId: 'default' });
  });
  it('the page cannot write stream presets', () => {
    expect(isDataPlugin('streamPresets')).toBe(false);
    expect(isDataPlugin('voiceAnalytics')).toBe(true);
    const s = sanitizeData('streamPresets', { presets: [{ id: 'a', name: 'Game', kind: 'window', source: 'Roblox', audio: true }, { id: 'b', name: 'x', kind: 'tab', source: 'y' }], last: { kind: 'screen', source: 'Screen 1', audio: 'yes' } });
    expect(s.presets.map((p) => p.name)).toEqual(['Game']);
    expect(s.last).toEqual({ kind: 'screen', source: 'Screen 1', audio: false });
  });
  it('a preset can only be made from a source the picker listed', async () => {
    const { presetFrom } = await import('../src/main/capture');
    const listed = new Map([['screen:0:0', 'Screen 1'], ['window:42:0', 'Roblox']]);
    expect(presetFrom(listed, 'window:99:0', 'x', true, 'id1')).toBeNull();
    expect(presetFrom(listed, 'window:42:0', '   ', true, 'id1')).toBeNull();
    expect(presetFrom(listed, 'window:42:0', ' Game\u0007 night ', 1, 'id1')).toEqual({ id: 'id1', name: 'Game night', kind: 'window', source: 'Roblox', audio: false });
    expect(presetFrom(listed, 'screen:0:0', 'Desk', true, 'id2')?.kind).toBe('screen');
  });
});
