import { describe, expect, it } from 'vitest';
import { chromeUserAgent, resolveChoice } from '../src/main/capture';

describe('chromeUserAgent', () => {
  it('is a plain Chrome UA for the running Chromium major, without Electron or app tokens', () => {
    const ua = chromeUserAgent('156.0.8078.100');
    expect(ua).toBe('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36');
    expect(ua).not.toMatch(/Electron|ZERO/i);
  });
});

describe('resolveChoice', () => {
  const listed = new Map([['screen:0:0', 'Screen 1'], ['window:42:0', 'Game']]);
  it('accepts only listed sources', () => {
    expect(resolveChoice(listed, 'window:42:0', true, true)).toEqual({ id: 'window:42:0', name: 'Game', audio: true });
    expect(resolveChoice(listed, 'window:99:0', true, true)).toBeNull();
    expect(resolveChoice(listed, { id: 'screen:0:0' }, true, true)).toBeNull();
  });
  it('never adds audio the page did not request, and needs a real true', () => {
    expect(resolveChoice(listed, 'screen:0:0', true, false)?.audio).toBe(false);
    expect(resolveChoice(listed, 'screen:0:0', 'yes', true)?.audio).toBe(false);
  });
});
