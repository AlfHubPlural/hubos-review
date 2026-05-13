/**
 * Unit tests for src/lib/registry.js.
 *
 * Story: CICD-002-E (AC-14 — registry coverage).
 *
 * Strategy: every test injects a fake execFn so the real `npm view` is
 * never invoked. Tests assert on the structured `{ status, version }` return
 * shape + cache behavior + graceful offline handling.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  createRegistryClient,
  compareVersions,
  parseSemver,
} from '../src/lib/registry.js';

function fakeExecOk(version) {
  return vi.fn(async () => ({
    ok: true,
    stdout: JSON.stringify(version),
    stderr: '',
    exitCode: 0,
  }));
}

function fakeExecFail({ stderr = '', exitCode = 1, timedOut = false } = {}) {
  return vi.fn(async () => ({
    ok: false,
    stdout: '',
    stderr,
    exitCode,
    timedOut,
  }));
}

function fakeExecThrow(message = 'spawn ENOENT') {
  return vi.fn(async () => {
    throw new Error(message);
  });
}

describe('createRegistryClient', () => {
  it('returns { status: online, version } when npm view succeeds with a string', async () => {
    const reg = createRegistryClient({ execFn: fakeExecOk('0.4.0') });
    const result = await reg.getLatestVersion('@hubplural/hubos-review');
    expect(result.status).toBe('online');
    expect(result.version).toBe('0.4.0');
  });

  it('returns { status: offline, version: null } when npm view fails with non-zero exit', async () => {
    const reg = createRegistryClient({
      execFn: fakeExecFail({ stderr: 'npm ERR! 404 Not Found', exitCode: 1 }),
    });
    const result = await reg.getLatestVersion('@hubplural/hubos-review');
    expect(result.status).toBe('offline');
    expect(result.version).toBeNull();
    expect(result.error).toContain('npm ERR');
  });

  it('returns offline when execFn throws (spawn ENOENT)', async () => {
    const reg = createRegistryClient({ execFn: fakeExecThrow() });
    const result = await reg.getLatestVersion('@hubplural/hubos-review');
    expect(result.status).toBe('offline');
    expect(result.version).toBeNull();
    expect(result.error).toContain('spawn ENOENT');
  });

  it('returns offline immediately when called with { offline: true } (no exec invoked)', async () => {
    const execSpy = fakeExecOk('99.99.99');
    const reg = createRegistryClient({ execFn: execSpy });
    const result = await reg.getLatestVersion('@hubplural/hubos-review', { offline: true });
    expect(result.status).toBe('offline');
    expect(result.version).toBeNull();
    expect(execSpy).not.toHaveBeenCalled();
  });

  it('caches per-package within a session — second call uses cached result', async () => {
    const execSpy = fakeExecOk('0.4.0');
    const reg = createRegistryClient({ execFn: execSpy });
    const first = await reg.getLatestVersion('@hubplural/hubos-review');
    const second = await reg.getLatestVersion('@hubplural/hubos-review');
    expect(first).toEqual(second);
    expect(execSpy).toHaveBeenCalledTimes(1);
  });

  it('clearCache() forces a re-fetch on the next call', async () => {
    const execSpy = fakeExecOk('0.4.0');
    const reg = createRegistryClient({ execFn: execSpy });
    await reg.getLatestVersion('@hubplural/hubos-review');
    reg.clearCache();
    await reg.getLatestVersion('@hubplural/hubos-review');
    expect(execSpy).toHaveBeenCalledTimes(2);
  });

  it('returns offline when stdout is empty (some npm errors emit empty stdout)', async () => {
    const reg = createRegistryClient({
      execFn: vi.fn(async () => ({ ok: true, stdout: '   ', stderr: '', exitCode: 0 })),
    });
    const result = await reg.getLatestVersion('@hubplural/hubos-review');
    expect(result.status).toBe('offline');
    expect(result.error).toContain('empty');
  });

  it('handles object shape from npm view (parsed.latest)', async () => {
    const reg = createRegistryClient({
      execFn: vi.fn(async () => ({
        ok: true,
        stdout: JSON.stringify({ latest: '0.5.0' }),
        stderr: '',
        exitCode: 0,
      })),
    });
    const result = await reg.getLatestVersion('@hubplural/hubos-review');
    expect(result.status).toBe('online');
    expect(result.version).toBe('0.5.0');
  });

  it('returns offline on malformed JSON output', async () => {
    const reg = createRegistryClient({
      execFn: vi.fn(async () => ({
        ok: true,
        stdout: 'not-json{{{',
        stderr: '',
        exitCode: 0,
      })),
    });
    const result = await reg.getLatestVersion('@hubplural/hubos-review');
    expect(result.status).toBe('offline');
    expect(result.error).toMatch(/invalid JSON/i);
  });

  it('returns offline when execFn signals timeout', async () => {
    const reg = createRegistryClient({
      execFn: fakeExecFail({ timedOut: true }),
    });
    const result = await reg.getLatestVersion('@hubplural/hubos-review');
    expect(result.status).toBe('offline');
    expect(result.error).toMatch(/timeout/i);
  });
});

describe('compareVersions', () => {
  it('returns 0 for identical versions', () => {
    expect(compareVersions('0.3.0', '0.3.0')).toBe(0);
  });
  it('returns -1 when a < b on patch', () => {
    expect(compareVersions('0.3.0', '0.3.1')).toBe(-1);
  });
  it('returns 1 when a > b on minor', () => {
    expect(compareVersions('0.4.0', '0.3.99')).toBe(1);
  });
  it('returns -1 when a < b on major', () => {
    expect(compareVersions('0.9.9', '1.0.0')).toBe(-1);
  });
  it('returns 0 on unparseable inputs (defensive)', () => {
    expect(compareVersions('garbage', '0.3.0')).toBe(0);
  });
  it('strips pre-release suffixes before compare', () => {
    expect(compareVersions('0.3.0-beta.1', '0.3.0')).toBe(0);
  });
});

describe('parseSemver', () => {
  it('parses major.minor.patch correctly', () => {
    expect(parseSemver('1.2.3')).toEqual([1, 2, 3]);
  });
  it('returns null on non-string inputs', () => {
    expect(parseSemver(null)).toBeNull();
    expect(parseSemver(123)).toBeNull();
  });
  it('returns null on incomplete semver (e.g. 1.2)', () => {
    expect(parseSemver('1.2')).toBeNull();
  });
  it('strips pre-release and build metadata', () => {
    expect(parseSemver('1.2.3-beta.1+build.45')).toEqual([1, 2, 3]);
  });
});
