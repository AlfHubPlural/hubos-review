/**
 * Unit tests for `src/checks/bundle-outdated.js` (C6).
 */

import { describe, it, expect, afterEach } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import checkBundleOutdated, {
  parseVersionNumber,
} from '../../src/checks/bundle-outdated.js';

/** @type {string[]} */
const dirs = [];
function tmpDir() {
  const d = mkdtempSync(join(tmpdir(), 'hubos-review-bundle-outdated-'));
  dirs.push(d);
  return d;
}

afterEach(() => {
  while (dirs.length > 0) {
    try {
      rmSync(dirs.pop(), { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
});

describe('checkBundleOutdated (C6)', () => {
  it('PASS when no cicd-version present (no prior install)', async () => {
    const targetDir = tmpDir();
    const r = await checkBundleOutdated({ targetDir });
    expect(r.id).toBe('C6');
    expect(r.severity).toBe('MEDIUM');
    expect(r.status).toBe('PASS');
    expect(r.blocking).toBe(false);
  });

  it('PASS when installed version matches latest', async () => {
    const targetDir = tmpDir();
    mkdirSync(join(targetDir, '.aiox'), { recursive: true });
    writeFileSync(
      join(targetDir, '.aiox', 'cicd-version'),
      JSON.stringify({
        gates: { 'codex-gate': { bundleVersion: 'v1' } },
      }),
    );
    const r = await checkBundleOutdated({ targetDir });
    expect(r.status).toBe('PASS');
    expect(r.details).toMatch(/v1.*current/);
  });

  it('WARN when installed version is older', async () => {
    const targetDir = tmpDir();
    mkdirSync(join(targetDir, '.aiox'), { recursive: true });
    writeFileSync(
      join(targetDir, '.aiox', 'cicd-version'),
      JSON.stringify({
        gates: { 'codex-gate': { bundleVersion: 'v0' } },
      }),
    );
    // Pretend we're shipping v1 (real state of MVP).
    const r = await checkBundleOutdated({
      targetDir,
      bundleVersion: 'v1',
    });
    expect(r.status).toBe('WARN');
    expect(r.blocking).toBe(false);
    expect(r.details).toMatch(/older than current v1/);
  });

  it('WARN when cicd-version is malformed', async () => {
    const targetDir = tmpDir();
    mkdirSync(join(targetDir, '.aiox'), { recursive: true });
    writeFileSync(join(targetDir, '.aiox', 'cicd-version'), 'not json');
    const r = await checkBundleOutdated({ targetDir });
    expect(r.status).toBe('WARN');
  });

  it('PASS when cicd-version exists but has no record for the gate', async () => {
    const targetDir = tmpDir();
    mkdirSync(join(targetDir, '.aiox'), { recursive: true });
    writeFileSync(
      join(targetDir, '.aiox', 'cicd-version'),
      JSON.stringify({ gates: { 'other-gate': { bundleVersion: 'v1' } } }),
    );
    const r = await checkBundleOutdated({ targetDir });
    expect(r.status).toBe('PASS');
  });

  it('parseVersionNumber handles v1, v23, garbage', () => {
    expect(parseVersionNumber('v1')).toBe(1);
    expect(parseVersionNumber('v23')).toBe(23);
    expect(parseVersionNumber('1')).toBe(null);
    expect(parseVersionNumber('v1.2')).toBe(null);
    expect(parseVersionNumber(null)).toBe(null);
    expect(parseVersionNumber(undefined)).toBe(null);
  });
});
