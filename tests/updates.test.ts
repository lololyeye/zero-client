import { describe, expect, it } from 'vitest';
import { compareVersions, etaSeconds, formatBytes, friendlyError, isNetworkError, resolvePending, shouldPrompt, staleFiles } from '../src/main/updates';

describe('compareVersions', () => {
  it('orders dotted versions and pre-releases', () => {
    expect(compareVersions('0.10.0', '0.9.9')).toBe(1);
    expect(compareVersions('v0.2.2', '0.2.2')).toBe(0);
    expect(compareVersions('0.3.0-beta.1', '0.3.0')).toBe(-1);
    expect(compareVersions('0.2.1', '0.2.2')).toBe(-1);
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
    expect(friendlyError('sha512 checksum mismatch')).toMatch(/discarded. Nothing was changed/);
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

describe('update files', () => {
  it('formats sizes and keeps only what is in use', () => {
    expect(formatBytes(655_360)).toBe('640 KB');
    expect(formatBytes(121_560_981)).toBe('116 MB');
    expect(formatBytes(1_468_006)).toBe('1.4 MB');
    expect(staleFiles(['boot.json', 'ZERO-app-0.6.0.asar', 'ZERO-app-0.6.1.asar', 'ZERO-app-0.6.2.asar.part', 'ZERO-Setup-0.7.0.exe', 'notes.txt'], ['ZERO-app-0.6.1.asar', null]))
      .toEqual(['ZERO-app-0.6.0.asar', 'ZERO-app-0.6.2.asar.part', 'ZERO-Setup-0.7.0.exe']);
  });
});
