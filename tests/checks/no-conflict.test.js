/**
 * Unit tests for `src/checks/no-conflict.js` (C5b).
 *
 * These tests use real filesystem fixtures inside an isolated tmpdir, so the
 * bundle integrity helpers (loadBundleManifest, sha256File) are exercised
 * end-to-end against the actual codex-gate v1 bundle shipped in this repo.
 */

import { describe, it, expect, afterEach } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  copyFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import checkNoConflict from '../../src/checks/no-conflict.js';
import { bundleDir, loadBundleManifest } from '../../src/lib/bundle.js';

const TARGET_PATH = '.github/workflows/codex-gate.yml';
const CICD_PATH = '.aiox/cicd-version';

/** @type {string[]} */
const dirs = [];

function tmpDir() {
  const d = mkdtempSync(join(tmpdir(), 'hubos-review-no-conflict-'));
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

describe('checkNoConflict (C5b)', () => {
  it('PASS when no pre-existing workflow file', async () => {
    const targetDir = tmpDir();
    const r = await checkNoConflict({ targetDir });
    expect(r.id).toBe('C5b');
    expect(r.severity).toBe('HIGH');
    expect(r.status).toBe('PASS');
    expect(r.details).toMatch(/no pre-existing/);
  });

  it('PASS when pre-existing workflow hash matches bundle', async () => {
    const targetDir = tmpDir();
    // Copy the canonical bundle file to the target's workflow path.
    const manifest = loadBundleManifest('codex-gate', 'v1');
    const wfEntry = manifest.files.find((f) => f.targetPath === TARGET_PATH);
    mkdirSync(join(targetDir, '.github', 'workflows'), { recursive: true });
    copyFileSync(
      join(bundleDir('codex-gate', 'v1'), wfEntry.bundlePath),
      join(targetDir, TARGET_PATH),
    );
    const r = await checkNoConflict({ targetDir });
    expect(r.status).toBe('PASS');
    expect(r.details).toMatch(/matches bundle/);
  });

  it('FAIL when workflow file differs from bundle AND no cicd-version present', async () => {
    const targetDir = tmpDir();
    mkdirSync(join(targetDir, '.github', 'workflows'), { recursive: true });
    writeFileSync(join(targetDir, TARGET_PATH), 'user-customized workflow\n');
    const r = await checkNoConflict({ targetDir });
    expect(r.status).toBe('FAIL');
    expect(r.blocking).toBe(true);
    expect(r.remediation).toMatch(/--force/);
  });

  it('WARN when workflow differs but cicd-version tracks a different bundle version', async () => {
    const targetDir = tmpDir();
    mkdirSync(join(targetDir, '.github', 'workflows'), { recursive: true });
    writeFileSync(join(targetDir, TARGET_PATH), 'old bundle content\n');
    mkdirSync(join(targetDir, '.aiox'), { recursive: true });
    writeFileSync(
      join(targetDir, CICD_PATH),
      JSON.stringify(
        {
          gates: {
            'codex-gate': { bundleVersion: 'v0', installedAt: '2024-01-01' },
          },
        },
        null,
        2,
      ),
    );
    const r = await checkNoConflict({ targetDir });
    expect(r.status).toBe('WARN');
    expect(r.blocking).toBe(false);
    expect(r.details).toMatch(/v0/);
  });

  it('FAIL when cicd-version is malformed (treated as no prior install)', async () => {
    const targetDir = tmpDir();
    mkdirSync(join(targetDir, '.github', 'workflows'), { recursive: true });
    writeFileSync(join(targetDir, TARGET_PATH), 'custom content\n');
    mkdirSync(join(targetDir, '.aiox'), { recursive: true });
    writeFileSync(join(targetDir, CICD_PATH), 'not json');
    const r = await checkNoConflict({ targetDir });
    expect(r.status).toBe('FAIL');
  });

  it('WARN when bundle is unavailable (defensive)', async () => {
    const targetDir = tmpDir();
    mkdirSync(join(targetDir, '.github', 'workflows'), { recursive: true });
    writeFileSync(join(targetDir, TARGET_PATH), 'whatever\n');
    const r = await checkNoConflict({
      targetDir,
      gateName: 'nonexistent-gate',
      bundleVersion: 'v1',
    });
    expect(r.status).toBe('WARN');
    expect(r.blocking).toBe(false);
  });
});
