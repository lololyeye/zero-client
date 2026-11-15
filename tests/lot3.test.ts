import { describe, expect, it } from 'vitest';
import { BUILTINS, CATEGORIES, sanitizeBuiltins } from '../src/shared/builtins';
import { contrast, contrastIssues, fixContrast, generatePalette, parseColor } from '../src/shared/themeStudio';
import { DEFAULT_THEME } from '../src/shared/theme';
import { isDataPlugin, sanitizeData } from '../src/shared/pluginData';
import { createTranslator, decodeEntities, parseTranslation, translationUrl } from '../src/main/translate';
import { OPENABLE, safeFileName, uniqueName } from '../src/main/downloads';
import { overlayBounds, parseVoice } from '../src/main/voiceOverlay';
import { mainPageCss, SIDE_PATH } from '../src/main/sidePanel';

describe('plugin catalog', () => {
  it('has 31 plugins, each in a known category, all off by default', () => {
    expect(BUILTINS.length).toBe(31);
    for (const d of BUILTINS) expect(Object.keys(CATEGORIES)).toContain(d.category);
    expect(new Set(BUILTINS.map((d) => d.id)).size).toBe(BUILTINS.length);
    expect(Object.values(sanitizeBuiltins({})).every((b) => !b.enabled)).toBe(true);
  });
});

describe('ThemeStudio', () => {
  it('computes WCAG contrast', () => {
    expect(contrast('#000000', '#ffffff')).toBe(21);
    expect(contrast('#777', '#777777')).toBe(1);
    expect(parseColor('rgba(10, 20, 30, .5)')).toEqual([10, 20, 30]);
    expect(parseColor('nope')).toBeNull();
  });
  it('generates readable palettes in every style', () => {
    for (const mode of ['dark', 'dim', 'amoled', 'light'] as const) {
      for (const [base, accent] of [['#7c8cff', '#7c8cff'], ['#ff3355', '#ffee00'], ['#00ff88', '#003311']]) {
        const p = generatePalette(base!, accent!, mode);
        expect(contrastIssues(p), `${mode} ${base} ${accent}`).toEqual([]);
        for (const v of Object.values(p)) expect(parseColor(v) || v === 'rgba(0,0,0,0)').toBeTruthy();
      }
    }
    expect(generatePalette('#123456', '#7c8cff', 'dark', { bubble: '#222222' }).bubble).toBe('#222222');
  });
  it('fixes unreadable text without touching surfaces', () => {
    const bad = { ...DEFAULT_THEME.colors, text: '#222630', textMuted: '#1f2229', button: '#c8d0ff' };
    expect(contrastIssues(bad).length).toBeGreaterThan(0);
    const fixed = fixContrast(bad);
    expect(contrastIssues(fixed)).toEqual([]);
    expect(fixed.surface1).toBe(bad.surface1);
    expect(fixed.channelList).toBe(bad.channelList);
  });
});

describe('new plugin data', () => {
  it('lets the page write statistics, never downloads or workspaces', () => {
    expect(isDataPlugin('messageStats')).toBe(true);
    expect(isDataPlugin('downloadManager')).toBe(false);
    expect(isDataPlugin('workspaceProfiles')).toBe(false);
  });
  it('keeps statistics as numbers, one entry per day, newest first', () => {
    const d = sanitizeData('messageStats', {
      since: 5, days: [{ day: '2026-11-01', sent: 3, dms: -4, mentions: 'x' }, { day: '2026-11-03', sent: 1.6 }, { day: '2026-11-01', sent: 99 }, { day: 'yesterday', sent: 1 }, { day: '2026-11-02', sent: 1, content: 'secret' }],
      channels: [{ id: '123456789012345678', count: 4 }, { id: 'general', count: 9 }, { id: '223456789012345678', count: 7 }],
    });
    expect(d.days.map((x) => x.day)).toEqual(['2026-11-03', '2026-11-02', '2026-11-01']);
    expect(d.days[0]).toEqual({ day: '2026-11-03', sent: 2, dms: 0, mentions: 0 });
    expect(d.days[2]!.dms).toBe(0);
    expect(JSON.stringify(d)).not.toContain('secret');
    expect(d.channels.map((c) => c.count)).toEqual([7, 4]);
  });
  it('validates downloads and workspaces', () => {
    const dl = sanitizeData('downloadManager', { items: [{ id: 'a1', name: 'cat.png', bytes: 10, state: 'weird', at: 1, path: 'C:\\x\\cat.png' }, { id: 'a2', name: 'x' }] });
    expect(dl.items).toEqual([{ id: 'a1', name: 'cat.png', bytes: 10, state: 'done', at: 1, path: 'C:\\x\\cat.png' }]);
    const ws = sanitizeData('workspaceProfiles', { profiles: [
      { id: 'w1', name: 'Gaming', themeId: 'midnight', layoutId: 'gaming', perf: { profile: 'lightweight', custom: { blur: 'no' } }, builtins: { callTimer: { enabled: true }, workspaceProfiles: { enabled: false }, evil: { enabled: true } } },
      { id: 'w2', name: '' },
    ] });
    expect(ws.profiles).toHaveLength(1);
    const p = ws.profiles[0]!;
    expect(p.perf.profile).toBe('performance');
    expect(typeof p.perf.custom.blur).toBe('boolean');
    expect(p.builtins.callTimer!.enabled).toBe(true);
    expect('workspaceProfiles' in p.builtins).toBe(false);
    expect('evil' in p.builtins).toBe(false);
  });
});

describe('InlineTranslator', () => {
  it('builds the request from the text only, at most 500 characters', () => {
    const u = new URL(translationUrl('a&b=c ' + 'x'.repeat(900), 'fr'));
    expect(u.origin).toBe('https://api.mymemory.translated.net');
    expect(u.searchParams.get('q')!.length).toBe(500);
    expect(u.searchParams.get('langpair')).toBe('autodetect|fr');
  });
  it('reads answers and errors', () => {
    expect(parseTranslation({ responseStatus: 200, responseData: { translatedText: 'It&#39;s &amp; ok', detectedLanguage: 'fr' } }, 'en')).toEqual({ text: "It's & ok", from: 'fr' });
    expect(parseTranslation({ responseStatus: 200, responseData: { translatedText: 'hi', detectedLanguage: 'en-GB' } }, 'en')).toHaveProperty('error');
    expect(parseTranslation({ responseStatus: 403, responseDetails: 'PLEASE SELECT TWO DISTINCT LANGUAGES' }, 'en')).toEqual({ error: 'This message is already in that language.' });
    expect(parseTranslation({ responseStatus: 429, quotaFinished: true }, 'en')).toHaveProperty('error');
    expect(parseTranslation(null, 'en')).toHaveProperty('error');
    expect(decodeEntities('&lt;b&gt; &#x1F600; &bogus;')).toBe('<b> 😀 &bogus;');
  });
  it('refuses unknown languages and more than 10 requests a minute', async () => {
    const urls: string[] = [];
    const t = createTranslator(async (u) => { urls.push(u); return new Response(JSON.stringify({ responseStatus: 200, responseData: { translatedText: 'ok', detectedLanguage: 'de' } })); });
    expect(await t('hallo', 'xx')).toHaveProperty('error');
    expect(await t('', 'en')).toHaveProperty('error');
    for (let i = 0; i < 10; i++) expect(await t('hallo', 'en')).toEqual({ text: 'ok', from: 'de' });
    expect(await t('hallo', 'en')).toHaveProperty('error');
    expect(urls).toHaveLength(10);
  });
});

describe('DownloadManager', () => {
  it('opens only media, documents and text', () => {
    for (const ok of ['a.png', 'b.JPG', 'c.mp4', 'd.pdf', 'e.txt']) expect(OPENABLE.test(ok)).toBe(true);
    for (const no of ['a.exe', 'b.bat', 'c.ps1', 'd.lnk', 'e.js', 'f.html', 'g.msi', 'h.scr', 'i.png.exe', 'j.vbs', 'k.cmd']) expect(OPENABLE.test(no)).toBe(false);
  });
  it('makes safe, unique file names', () => {
    expect(safeFileName('..\\..\\evil.png')).toBe('evil.png');
    expect(safeFileName('a<b>:c?.txt')).toBe('a_b__c_.txt');
    expect(safeFileName('CON.txt')).toBe('download');
    expect(safeFileName('name. ')).toBe('name');
    const taken = new Set(['cat.png', 'cat (1).png']);
    expect(uniqueName('cat.png', (n) => taken.has(n))).toBe('cat (2).png');
    expect(uniqueName('dog.png', (n) => taken.has(n))).toBe('dog.png');
  });
});

describe('VoiceOverlay', () => {
  it('keeps names and flags only, capped', () => {
    const v = parseVoice(JSON.stringify({ channel: 'Lobby', users: [...Array(40)].map((_, i) => ({ name: 'u\u0007' + i + 'x'.repeat(50), speaking: i === 0, token: 'nope' })) }));
    expect(v!.users).toHaveLength(25);
    expect(v!.users[0]).toEqual({ name: ('u0' + 'x'.repeat(50)).slice(0, 32), speaking: true, mute: false, deaf: false, me: false });
    expect(JSON.stringify(v)).not.toContain('nope');
    expect(parseVoice('')).toBeNull();
    expect(parseVoice('{bad')).toBeNull();
  });
  it('sits in the chosen corner of the work area', () => {
    const area = { x: 0, y: 0, width: 1920, height: 1040 };
    const b = overlayBounds(area, { corner: 'br', show: 'all', size: 'normal' }, 3);
    expect(b.x + b.width).toBe(1908);
    expect(b.y + b.height).toBe(1028);
    expect(overlayBounds(area, { corner: 'tl', show: 'all', size: 'bogus' }, 1)).toMatchObject({ x: 12, y: 12 });
  });
});

describe('MultiPanel', () => {
  it('opens only Discord channel paths', () => {
    expect(SIDE_PATH.test('/channels/@me/123456789012345678')).toBe(true);
    expect(SIDE_PATH.test('/channels/123456789012345678/223456789012345678')).toBe(true);
    for (const bad of ['/channels/@me', '//evil.com/channels/@me/123456789012345678', '/channels/@me/123456789012345678/../x', 'https://evil.com', '/login']) expect(SIDE_PATH.test(bad)).toBe(false);
    expect(mainPageCss(40)).toContain('width:60vw');
  });
});
