/**
 * Unit + integration tests for `hubos-review install`.
 *
 * Strategy: each test gets its own temporary git repo under
 * `os.tmpdir()/hubos-review-install-<rand>`. Tests exercise the public
 * `install({...})` function directly (no subprocess) and assert on:
 *   - return code (AC-1, AC-2, AC-3, AC-4, AC-9)
 *   - filesystem state (files copied, .aiox/cicd-version structure)
 *   - SHA-256 stamping (AC-7)
 *   - idempotence + --force + --dry-run interactions
 *   - defensive abort on bundle integrity mismatch
 *
 * Coverage maps to Story CICD-002-B AC-1, AC-2, AC-3, AC-4, AC-7, AC-8, AC-9, AC-10, AC-11.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

import { install } from '../src/commands/install.js';
import { loadBundleManifest, packageRoot } from '../src/lib/bundle.js';

function sha256(buf) {
  return 'sha256:' + createHash('sha256').update(buf).digest('hex');
}

/**
 * Create a fresh temp directory and (optionally) make it look like a git repo
 * by adding an empty `.git/` directory. Returns the absolute path.
 */
function makeTempDir({ asGitRepo = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'hubos-review-install-'));
  if (asGitRepo) {
    mkdirSync(join(dir, '.git'), { recursive: true });
  }
  return dir;
}

describe('install command', () => {
  /** @type {string[]} */
  const dirsToCleanup = [];

  function tmp({ asGitRepo = true } = {}) {
    const dir = makeTempDir({ asGitRepo });
    dirsToCleanup.push(dir);
    return dir;
  }

  beforeEach(() => {
    // Silence command stdout/stderr — tests assert on return values + fs state.
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    while (dirsToCleanup.length > 0) {
      const dir = dirsToCleanup.pop();
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
    }
  });

  describe('AC-1 — basic install in clean repo', () => {
    it('copies 3 files and writes .aiox/cicd-version (JSON)', () => {
      const target = tmp();
      const rc = install({ gate: 'codex-gate', target });
      expect(rc).toBe(0);

      const manifest = loadBundleManifest('codex-gate', 'v1');
      for (const file of manifest.files) {
        const dst = join(target, file.targetPath);
        expect(existsSync(dst), `${file.targetPath} should exist`).toBe(true);
        const actual = sha256(readFileSync(dst));
        expect(actual).toBe(file.sha256);
      }

      const cicdPath = join(target, '.aiox', 'cicd-version');
      expect(existsSync(cicdPath)).toBe(true);
      const cicd = JSON.parse(readFileSync(cicdPath, 'utf8'));
      expect(cicd.package).toBe('@hubplural/hubos-review');
      expect(typeof cicd.version).toBe('string');
      expect(cicd.installedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(cicd.gates['codex-gate'].bundleVersion).toBe('v1');
      expect(cicd.gates['codex-gate'].sourceHash['codex-gate.yml']).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(Object.keys(cicd.gates['codex-gate'].sourceHash).sort()).toEqual(
        ['bot-review-integration.md', 'codex-gate.yml', 'qa-bot-loop.md'],
      );
    });

    it('creates intermediate directories that did not exist', () => {
      const target = tmp();
      install({ gate: 'codex-gate', target });
      expect(existsSync(join(target, '.github', 'workflows'))).toBe(true);
      expect(existsSync(join(target, '.aiox-core', 'development', 'tasks'))).toBe(true);
      expect(existsSync(join(target, '.claude', 'rules'))).toBe(true);
      expect(existsSync(join(target, '.aiox'))).toBe(true);
    });
  });

  describe('AC-2 — idempotence without --force', () => {
    it('second run aborts with exit 0 and does not change files', () => {
      const target = tmp();
      const rc1 = install({ gate: 'codex-gate', target });
      expect(rc1).toBe(0);

      // Capture file mtimes / contents.
      const cicdPath = join(target, '.aiox', 'cicd-version');
      const cicdBefore = readFileSync(cicdPath, 'utf8');
      const wfBefore = readFileSync(join(target, '.github', 'workflows', 'codex-gate.yml'));

      // Spy on stderr to confirm message.
      const errs = [];
      console.error.mockImplementation((s) => errs.push(String(s)));

      const rc2 = install({ gate: 'codex-gate', target });
      expect(rc2).toBe(0);
      // Files unchanged.
      expect(readFileSync(cicdPath, 'utf8')).toBe(cicdBefore);
      expect(readFileSync(join(target, '.github', 'workflows', 'codex-gate.yml'))).toEqual(wfBefore);
      // Message present.
      expect(errs.join('\n')).toMatch(/already installed/i);
      expect(errs.join('\n')).toMatch(/--force/);
    });
  });

  describe('AC-3 — --force overwrites existing install', () => {
    it('reinstalls and updates cicd-version timestamp', () => {
      const target = tmp();
      install({ gate: 'codex-gate', target, now: () => '2026-01-01T00:00:00.000Z' });
      const cicdBefore = JSON.parse(
        readFileSync(join(target, '.aiox', 'cicd-version'), 'utf8'),
      );

      const rc = install({
        gate: 'codex-gate',
        target,
        force: true,
        now: () => '2026-12-31T23:59:59.000Z',
      });
      expect(rc).toBe(0);

      const cicdAfter = JSON.parse(
        readFileSync(join(target, '.aiox', 'cicd-version'), 'utf8'),
      );
      expect(cicdAfter.installedAt).toBe('2026-12-31T23:59:59.000Z');
      expect(cicdAfter.installedAt).not.toBe(cicdBefore.installedAt);
      expect(cicdAfter.gates['codex-gate'].installedAt).toBe('2026-12-31T23:59:59.000Z');
    });

    it('clobbers existing artifact even if user modified it', () => {
      const target = tmp();
      install({ gate: 'codex-gate', target });
      const wfPath = join(target, '.github', 'workflows', 'codex-gate.yml');
      writeFileSync(wfPath, 'user-customized content\n');
      expect(sha256(readFileSync(wfPath))).not.toMatch(/^sha256:14ad66b1/);

      install({ gate: 'codex-gate', target, force: true });
      // Hash should be back to the canonical bundle hash.
      expect(sha256(readFileSync(wfPath))).toBe(
        'sha256:14ad66b19a5ce552a2569f66b48b2b926cbba74bc6d9c26ef5dd076e45eb207f',
      );
    });
  });

  describe('AC-4 — --dry-run lists but writes nothing', () => {
    it('returns 0 and does not create any file in a clean target', () => {
      const target = tmp();
      const rc = install({ gate: 'codex-gate', target, dryRun: true });
      expect(rc).toBe(0);
      expect(existsSync(join(target, '.github'))).toBe(false);
      expect(existsSync(join(target, '.aiox-core'))).toBe(false);
      expect(existsSync(join(target, '.claude'))).toBe(false);
      expect(existsSync(join(target, '.aiox'))).toBe(false);
    });

    it('lists every bundle file in stdout', () => {
      const target = tmp();
      const logs = [];
      console.log.mockImplementation((s) => logs.push(String(s)));
      install({ gate: 'codex-gate', target, dryRun: true });
      const out = logs.join('\n');
      expect(out).toMatch(/DRY RUN/);
      expect(out).toContain('codex-gate.yml');
      expect(out).toContain('qa-bot-loop.md');
      expect(out).toContain('bot-review-integration.md');
      expect(out).toContain('.aiox/cicd-version');
      expect(out).toMatch(/No filesystem changes were made/);
    });

    it('does not abort on existing install — reports would-overwrite and notes --force', () => {
      const target = tmp();
      install({ gate: 'codex-gate', target });
      const logs = [];
      console.log.mockImplementation((s) => logs.push(String(s)));
      const rc = install({ gate: 'codex-gate', target, dryRun: true });
      expect(rc).toBe(0);
      const out = logs.join('\n');
      expect(out).toMatch(/DRY RUN/);
      expect(out).toMatch(/already exists/);
      // Real install items still listed with OVERWRITES marker.
      expect(out).toMatch(/OVERWRITES existing/);
    });
  });

  describe('AC-9 — refuse non-git target', () => {
    it('exits 1 when target is not a git repo', () => {
      const target = tmp({ asGitRepo: false });
      const errs = [];
      console.error.mockImplementation((s) => errs.push(String(s)));
      const rc = install({ gate: 'codex-gate', target });
      expect(rc).toBe(1);
      expect(errs.join('\n')).toMatch(/not a git repository/);
      // No writes happened.
      expect(existsSync(join(target, '.github'))).toBe(false);
      expect(existsSync(join(target, '.aiox'))).toBe(false);
    });

    it('exits 1 when target does not exist', () => {
      const target = join(tmpdir(), 'definitely-does-not-exist-' + Math.random().toString(36).slice(2));
      const rc = install({ gate: 'codex-gate', target });
      expect(rc).toBe(1);
    });
  });

  describe('AC-10 — --target operates on alternate directory', () => {
    it('install in --target leaves CWD untouched', () => {
      const target = tmp();
      const cwdTarget = tmp(); // separate from `target`
      install({ gate: 'codex-gate', target, cwd: cwdTarget });
      expect(existsSync(join(target, '.github', 'workflows', 'codex-gate.yml'))).toBe(true);
      expect(existsSync(join(cwdTarget, '.github'))).toBe(false);
      expect(existsSync(join(cwdTarget, '.aiox'))).toBe(false);
    });

    it('without --target, install uses cwd option (test injection)', () => {
      const cwdTarget = tmp();
      install({ gate: 'codex-gate', cwd: cwdTarget });
      expect(existsSync(join(cwdTarget, '.github', 'workflows', 'codex-gate.yml'))).toBe(true);
    });
  });

  describe('AC-7 — SHA-256 in cicd-version matches bundle content', () => {
    it('every file hash in .aiox/cicd-version matches the bytes on disk', () => {
      const target = tmp();
      install({ gate: 'codex-gate', target });
      const cicd = JSON.parse(readFileSync(join(target, '.aiox', 'cicd-version'), 'utf8'));
      for (const f of cicd.gates['codex-gate'].files) {
        const actual = sha256(readFileSync(join(target, f.targetPath)));
        expect(actual).toBe(f.sha256);
      }
    });
  });

  describe('AC-5 — bundle integrity (defensive)', () => {
    it('throws clear error when bundle does not exist', () => {
      const target = tmp();
      const errs = [];
      console.error.mockImplementation((s) => errs.push(String(s)));
      const rc = install({ gate: 'nonexistent-gate', target });
      expect(rc).toBe(1);
      expect(errs.join('\n')).toMatch(/Bundle not found/);
      expect(existsSync(join(target, '.github'))).toBe(false);
    });
  });

  describe('AC-8 — success banner and next-steps', () => {
    it('prints next-steps hint mentioning verify and Story D', () => {
      const target = tmp();
      const logs = [];
      console.log.mockImplementation((s) => logs.push(String(s)));
      install({ gate: 'codex-gate', target });
      const out = logs.join('\n');
      expect(out).toMatch(/installed successfully/);
      expect(out).toMatch(/\.aiox\/cicd-version/);
      expect(out).toMatch(/git add and commit/);
      expect(out).toMatch(/hubos-review verify/);
    });
  });

  describe('idempotence with malformed existing state', () => {
    it('aborts without --force even when cicd-version is unparseable JSON', () => {
      const target = tmp();
      // Pre-existing install puts something at .aiox/cicd-version. Corrupt it.
      install({ gate: 'codex-gate', target });
      writeFileSync(join(target, '.aiox', 'cicd-version'), 'not-valid-json', 'utf8');
      const errs = [];
      console.error.mockImplementation((s) => errs.push(String(s)));
      const rc = install({ gate: 'codex-gate', target });
      expect(rc).toBe(0);
      expect(errs.join('\n')).toMatch(/already installed/i);
      // File still corrupted (not overwritten) because --force was not passed.
      expect(readFileSync(join(target, '.aiox', 'cicd-version'), 'utf8')).toBe('not-valid-json');
    });

    it('recovers cleanly with --force even if cicd-version was malformed', () => {
      const target = tmp();
      install({ gate: 'codex-gate', target });
      writeFileSync(join(target, '.aiox', 'cicd-version'), 'not-valid-json', 'utf8');
      const rc = install({ gate: 'codex-gate', target, force: true });
      expect(rc).toBe(0);
      // Now parseable JSON again.
      const cicd = JSON.parse(readFileSync(join(target, '.aiox', 'cicd-version'), 'utf8'));
      expect(cicd.gates['codex-gate'].bundleVersion).toBe('v1');
    });
  });

  describe('packageRoot resolves correctly', () => {
    it('points to the directory containing package.json + bundles/', () => {
      const root = packageRoot();
      expect(existsSync(join(root, 'package.json'))).toBe(true);
      expect(existsSync(join(root, 'bundles', 'codex-gate', 'v1', 'manifest.json'))).toBe(true);
    });
  });

  // ─── Story CICD-002-E AC-12 — Fix OBS-D-1 (early-exit) ─────────────────
  // The fix lives in installWithProtection() (src/commands/install.js).
  // This test stays in install.test.js because it asserts that the SYNC
  // install() function continues to behave correctly when called directly —
  // i.e. the early-exit is a wrapper-level concern that does NOT regress
  // any of the Story B/Story D scenarios that exercise install() in isolation.
  describe('install() (sync) regression after Story E OBS-D-1 fix', () => {
    it('synchronous install() is unaffected by Story E early-exit fix', () => {
      const target = tmp();
      // The install() function does not know about --auto-protect /
      // --skip-protection flags; those are wrapper-level concerns. Story
      // E's early-exit fix lives in installWithProtection() and does NOT
      // change install() itself. We assert the canonical happy path
      // (install → 3 files + lock file) still works to detect regressions.
      const rc = install({ gate: 'codex-gate', target });
      expect(rc).toBe(0);
      expect(existsSync(join(target, '.github', 'workflows', 'codex-gate.yml'))).toBe(true);
      expect(existsSync(join(target, '.aiox', 'cicd-version'))).toBe(true);
    });
  });
});
