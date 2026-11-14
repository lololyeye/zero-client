import { describe, expect, it } from 'vitest';
import { activeBuiltins, BUILTINS, buildDetectableIndex, customActivity, matchGame, parseTasklist, sanitizeBuiltins } from '../src/shared/builtins';
import { defaultConfig, sanitizeConfig } from '../src/shared/config';

describe('built-in plugin settings', () => {
  it('are all off by default and survive config sanitizing', () => {
    const c = defaultConfig();
    expect(Object.keys(c.builtins).sort()).toEqual(BUILTINS.map((b) => b.id).sort());
    expect(Object.values(c.builtins).every((b) => !b.enabled)).toBe(true);
    const back = sanitizeConfig({ ...c, builtins: { ...c.builtins, messageLogger: { enabled: true, settings: { ignoreSelf: false } } } });
    expect(back.builtins.messageLogger).toEqual({ enabled: true, settings: { ignoreSelf: false, ignoreBots: false, logEdits: true } });
  });
  it('drop invalid values and unknown plugins', () => {
    const s = sanitizeBuiltins({
      callTimer: { enabled: 'yes', settings: { format: 'bogus' } },
      customRpc: { enabled: true, settings: { name: 'x'.repeat(500), type: '9' } },
      ignoreActivities: { enabled: true, settings: { ignored: ['  Valorant ', 3, ''] } },
      evil: { enabled: true },
    });
    expect(s.callTimer).toEqual({ enabled: false, settings: { format: 'stopwatch' } });
    expect((s.customRpc!.settings.name as string).length).toBe(128);
    expect(s.customRpc!.settings.type).toBe('0');
    expect(s.ignoreActivities!.settings.ignored).toEqual(['Valorant']);
    expect('evil' in s).toBe(false);
  });
  it('sends nothing to Discord while plugins are off or in safe mode', () => {
    const s = sanitizeBuiltins({ platformIndicators: { enabled: true } });
    expect(Object.keys(activeBuiltins(s, false))).toEqual(['platformIndicators']);
    expect(activeBuiltins(s, true)).toEqual({});
    expect(activeBuiltins(sanitizeBuiltins({}), false)).toEqual({});
  });
});

describe('CustomRPC activity', () => {
  it('builds a valid activity and ignores unusable fields', () => {
    expect(customActivity({ name: ' ', type: '0' }, 1)).toBeNull();
    expect(customActivity({ name: 'Chilling', type: '3', details: 'a', state: '', appId: 'abc', largeImage: 'logo', elapsed: true }, 42))
      .toEqual({ name: 'Chilling', type: 3, flags: 1, details: 'a', timestamps: { start: 42 } });
    expect(customActivity({ name: 'X', type: '0', appId: '123456789012345678', largeImage: 'logo', elapsed: false }, 1))
      .toEqual({ name: 'X', type: 0, flags: 1, application_id: '123456789012345678', assets: { large_image: 'logo' } });
  });
});

describe('GameDetection matching', () => {
  const list = [
    { id: '1', name: 'VALORANT', executables: [{ os: 'win32', name: 'win64/valorant-win64-shipping.exe' }, { os: 'darwin', name: 'valorant' }] },
    { id: '2', name: 'Generic', executables: [{ os: 'win32', name: 'launcher.exe' }] },
    { id: '3', name: 'Some Launcher', executables: [{ os: 'win32', name: 'somelauncher.exe', is_launcher: true }] },
    { bad: true },
  ];
  const idx = buildDetectableIndex(list);
  it('indexes Windows executables by file name, skipping generic names and launchers', () => {
    expect([...idx.keys()]).toEqual(['valorant-win64-shipping.exe']);
  });
  it('matches running processes and honours IgnoreActivities', () => {
    const procs = parseTasklist('"System Idle Process","0","Services","0","8 K"\r\n"VALORANT-Win64-Shipping.exe","4242","Console","1","900 000 K"\r\n');
    expect(procs).toEqual(['System Idle Process', 'VALORANT-Win64-Shipping.exe']);
    expect(matchGame(procs, idx, [])?.name).toBe('VALORANT');
    expect(matchGame(procs, idx, ['valorant'])).toBeNull();
    expect(matchGame(['notepad.exe'], idx, [])).toBeNull();
  });
});
