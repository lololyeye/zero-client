import { describe, expect, it } from 'vitest';
import { compareVersions, etaSeconds, friendlyError, isNetworkError, notesToLines, resolvePending, shouldPrompt } from '../src/main/updates';

describe('compareVersions', () => {
  it('orders dotted versions and pre-releases', () => {
    expect(compareVersions('0.10.0', '0.9.9')).toBe(1);
    expect(compareVersions('v0.2.2', '0.2.2')).toBe(0);
    expect(compareVersions('0.3.0-beta.1', '0.3.0')).toBe(-1);
    expect(compareVersions('0.2.1', '0.2.2')).toBe(-1);
  });
});

describe('notesToLines', () => {
  it('turns GitHub HTML notes into plain lines, never markup', () => {
    const html = '<p><strong>Streaming works.</strong></p><ul><li>Go Live &amp; watching</li><li><a href="x">Picker</a> <img src=x onerror=alert(1)></li></ul><p>Download <strong>ZERO-Setup-0.2.2.exe</strong> below.</p>';
    expect(notesToLines(html)).toEqual(['Streaming works.', 'Go Live & watching', 'Picker']);
  });
  it('handles markdown, note arrays, empty input and long lines', () => {
    expect(notesToLines('## Fixes\n- **Faster** start\n* [Docs](https://x)')).toEqual(['Fixes', 'Faster start', 'Docs']);
    expect(notesToLines([{ version: '1', note: 'One' }, { version: '2', note: 'Two' }])).toEqual(['One', 'Two']);
    expect(notesToLines(null)).toEqual([]);
    expect(notesToLines('x'.repeat(300))[0]!.length).toBe(158);
    expect(notesToLines(Array.from({ length: 20 }, (_, i) => `- ${i}`).join('\n'))).toHaveLength(8);
  });
});

describe('progress and errors', () => {
  it('computes time left from real speed only', () => {
    expect(etaSeconds(50, 150, 10)).toBe(10);
    expect(etaSeconds(50, 150, 0)).toBeNull();
    expect(etaSeconds(0, 0, 10)).toBeNull();
  });
  it('retries network failures, not checksum failures', () => {
    expect(isNetworkError('net::ERR_CONNECTION_RESET')).toBe(true);
    expect(isNetworkError('socket hang up')).toBe(true);
    expect(isNetworkError('sha512 checksum mismatch, expected abc, got def')).toBe(false);
    expect(friendlyError('sha512 checksum mismatch')).toMatch(/discarded. Nothing was installed/);
    expect(friendlyError('ECONNRESET')).toMatch(/connection was lost/);
  });
});

describe('prompting and post-update verification', () => {
  const now = 1_000_000;
  it('respects "Remind me later" for that version only, until it expires', () => {
    expect(shouldPrompt('0.3.0', '0.2.2', null, now)).toBe(true);
    expect(shouldPrompt('0.3.0', '0.2.2', { version: '0.3.0', until: now + 1 }, now)).toBe(false);
    expect(shouldPrompt('0.3.1', '0.2.2', { version: '0.3.0', until: now + 1 }, now)).toBe(true);
    expect(shouldPrompt('0.3.0', '0.2.2', { version: '0.3.0', until: now - 1 }, now)).toBe(true);
    expect(shouldPrompt('0.2.2', '0.2.2', null, now)).toBe(false);
  });
  it('reports whether the update the previous run started took effect', () => {
    expect(resolvePending({ target: '0.3.0' }, '0.3.0')).toEqual({ justUpdated: '0.3.0', failedTo: null });
    expect(resolvePending({ target: '0.3.0' }, '0.2.2')).toEqual({ justUpdated: null, failedTo: '0.3.0' });
    expect(resolvePending(null, '0.2.2')).toEqual({ justUpdated: null, failedTo: null });
  });
});
