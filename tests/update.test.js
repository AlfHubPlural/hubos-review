/**
 * Integration tests for `hubos-review update`.
 *
 * Story: CICD-002-E (AC-7, AC-8, AC-9, AC-10, AC-11, AC-13, AC-14).
 *
 * Strategy: same as status.test.js — fresh tmp git repo per test, run
 * `install` to seed, then exercise `update({...})` with injected TTY +
 * registry. All file I/O is real so we can assert `.aiox/cicd-version` is
 * rewritten correctly post-update.
 *
 * The bundle ships only `v1` today, so to exercise "outdated" paths we
 * tamper with the `.aiox/cicd-version` record (simulating an older install
 * whose hashes don't match the current bundle), or tamper with on-disk
 * files (simulating local modifications).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

import { install } from '../src/commands/install.js';
import { update } from '../src/commands/update.js';

function makeTempGitRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'hubos-review-update-test-'));
  mkdirSync(join(dir, '.git'), { recursive: true });
  return dir;
}

function makeFakeTty({ interactive = false, answer = true } = {}) {
  return {
    isInteractive: () => interactive,
    promptYesNo: vi.fn(async () => answer),
  };
}

// makeFakeRegistry helper intentionally not exported — every test that
// touches the registry path injects an inline vi.fn() so we can assert
// call counts directly. Kept as a comment for documentation purposes.

/** Read the parsed lock file from a target dir. */
function readCicd(target) {
  return JSON.parse(readFileSync(join(target, '.aiox', 'cicd-version'), 'utf8'));
}

/**
 * Simulate a clean "older install": rewrite each of the 3 installed files
 * on disk with a deterministic placeholder content, then update
 * .aiox/cicd-version to record the matching sha256 for that content.
 *
 * The result is an install where disk == installed-record (so `MODIFIED`
 * does NOT fire) but bundle != installed-record (so `OUTDATED` fires).
 * This is the canonical "update available" scenario.
 */
function pretendOlderInstall(target) {
  const cicd = readCicd(target);
  // Overwrite each tracked file with a placeholder, compute its sha, and
  // record the new hash in the lock file. The result: status = OUTDATED.
  const newFiles = cicd.gates['codex-gate'].files.map((f) => {
    const placeholder = `# older v0 placeholder for ${f.name}\n`;
    const fullPath = join(target, f.targetPath);
    writeFileSync(fullPath, placeholder, 'utf8');
    // Compute sha synchronously via Node's createHash via require dance avoided
    // by reusing the already-imported createHash from node:crypto at the top
    // of the file (see import).
    const sha = 'sha256:' + createHash('sha256').update(placeholder).digest('hex');
    return { ...f, sha256: sha };
  });
  cicd.gates['codex-gate'].files = newFiles;
  cicd.gates['codex-gate'].sourceHash = Object.fromEntries(
    newFiles.map((f) => [f.name, f.sha256]),
  );
  cicd.gates['codex-gate'].bundleVersion = 'v0';
  writeFileSync(
    join(target, '.aiox', 'cicd-version'),
    JSON.stringify(cicd, null, 2) + '\n',
    'utf8',
  );
  return cicd;
}

describe('hubos-review update', () => {
  /** @type {string[]} */
  const dirs = [];

  function tmp() {
    const d = makeTempGitRepo();
    dirs.push(d);
    return d;
  }

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    while (dirs.length > 0) {
      try {
        rmSync(dirs.pop(), { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });

  it('AC-7: already up-to-date → exit 0, no writes', async () => {
    const target = tmp();
    install({ gate: 'codex-gate', target });
    const before = readCicd(target);
    const rc = await update({
      target,
      noRegistryCheck: true,
      tty: makeFakeTty({ interactive: false }),
    });
    expect(rc).toBe(0);
    const after = readCicd(target);
    // Nothing changed in the lock file.
    expect(after.installedAt).toBe(before.installedAt);
  });

  it('AC-8: --dry-run shows changes but does NOT write', async () => {
    const target = tmp();
    install({ gate: 'codex-gate', target });
    pretendOlderInstall(target);
    const before = readCicd(target);
    const rc = await update({
      target,
      dryRun: true,
      noRegistryCheck: true,
      tty: makeFakeTty({ interactive: false }),
    });
    expect(rc).toBe(0);
    const after = readCicd(target);
    // sha256 records still the fake "0000..." (we did not rewrite the lock).
    expect(after.gates['codex-gate'].bundleVersion).toBe('v0');
    expect(after.gates['codex-gate'].files[0].sha256).toBe(before.gates['codex-gate'].files[0].sha256);
  });

  it('AC-9: TTY + prompt accepts (Y) → update applied, exit 0', async () => {
    const target = tmp();
    install({ gate: 'codex-gate', target });
    pretendOlderInstall(target);
    const fakeTty = makeFakeTty({ interactive: true, answer: true });
    const rc = await update({
      target,
      noRegistryCheck: true,
      tty: fakeTty,
    });
    expect(rc).toBe(0);
    expect(fakeTty.promptYesNo).toHaveBeenCalledOnce();
    const after = readCicd(target);
    // bundleVersion bumped back to v1 (the current bundle).
    expect(after.gates['codex-gate'].bundleVersion).toBe('v1');
    // hashes match the bundle's real shas (no more 0000...).
    expect(after.gates['codex-gate'].files[0].sha256).not.toContain('0000000000');
  });

  it('AC-9: TTY + prompt rejects (n) → no writes, exit 0', async () => {
    const target = tmp();
    install({ gate: 'codex-gate', target });
    pretendOlderInstall(target);
    const before = readCicd(target);
    const fakeTty = makeFakeTty({ interactive: true, answer: false });
    const rc = await update({
      target,
      noRegistryCheck: true,
      tty: fakeTty,
    });
    expect(rc).toBe(0);
    const after = readCicd(target);
    expect(after.gates['codex-gate'].bundleVersion).toBe('v0');
    expect(after.gates['codex-gate'].files[0].sha256).toBe(before.gates['codex-gate'].files[0].sha256);
  });

  it('AC-10: --auto-update applies without prompt', async () => {
    const target = tmp();
    install({ gate: 'codex-gate', target });
    pretendOlderInstall(target);
    const fakeTty = makeFakeTty({ interactive: true, answer: false });
    const rc = await update({
      target,
      autoUpdate: true,
      noRegistryCheck: true,
      tty: fakeTty,
    });
    expect(rc).toBe(0);
    expect(fakeTty.promptYesNo).not.toHaveBeenCalled();
    const after = readCicd(target);
    expect(after.gates['codex-gate'].bundleVersion).toBe('v1');
  });

  it('non-TTY context auto-applies without prompt', async () => {
    const target = tmp();
    install({ gate: 'codex-gate', target });
    pretendOlderInstall(target);
    const fakeTty = makeFakeTty({ interactive: false });
    const rc = await update({
      target,
      noRegistryCheck: true,
      tty: fakeTty,
    });
    expect(rc).toBe(0);
    expect(fakeTty.promptYesNo).not.toHaveBeenCalled();
    const after = readCicd(target);
    expect(after.gates['codex-gate'].bundleVersion).toBe('v1');
  });

  it('AC-11: local modifications WITHOUT --force-update → abort, exit 1', async () => {
    const target = tmp();
    install({ gate: 'codex-gate', target });
    pretendOlderInstall(target);
    // Tamper with one of the installed files (modify on disk).
    const yml = join(target, '.github', 'workflows', 'codex-gate.yml');
    writeFileSync(yml, '# local edit\n', 'utf8');
    const errSpy = vi.spyOn(console, 'error');
    const rc = await update({
      target,
      noRegistryCheck: true,
      tty: makeFakeTty({ interactive: false }),
    });
    expect(rc).toBe(1);
    const messages = errSpy.mock.calls.flat().join('\n');
    expect(messages).toMatch(/locally modified/i);
    expect(messages).toMatch(/--force-update/);
  });

  it('AC-11 inverse: --force-update overwrites local modifications', async () => {
    const target = tmp();
    install({ gate: 'codex-gate', target });
    pretendOlderInstall(target);
    const yml = join(target, '.github', 'workflows', 'codex-gate.yml');
    writeFileSync(yml, '# my custom edit\n', 'utf8');
    const rc = await update({
      target,
      forceUpdate: true,
      autoUpdate: true,
      noRegistryCheck: true,
      tty: makeFakeTty({ interactive: false }),
    });
    expect(rc).toBe(0);
    // File was clobbered with the bundle version (not '# my custom edit').
    const content = readFileSync(yml, 'utf8');
    expect(content).not.toBe('# my custom edit\n');
    expect(content.length).toBeGreaterThan(100); // real workflow is >15KB
  });

  it('AC-13: post-update .aiox/cicd-version reflects new hashes + timestamps', async () => {
    const target = tmp();
    install({ gate: 'codex-gate', target });
    pretendOlderInstall(target);
    const before = readCicd(target);
    const fakeNow = '2030-01-01T00:00:00.000Z';
    const rc = await update({
      target,
      autoUpdate: true,
      noRegistryCheck: true,
      now: () => fakeNow,
      tty: makeFakeTty({ interactive: false }),
    });
    expect(rc).toBe(0);
    const after = readCicd(target);
    expect(after.installedAt).toBe(fakeNow);
    expect(after.gates['codex-gate'].installedAt).toBe(fakeNow);
    expect(after.gates['codex-gate'].bundleVersion).toBe('v1');
    expect(after.gates['codex-gate'].files).toHaveLength(3);
    // sha256 values changed from "0000..." to real bundle hashes.
    for (const f of after.gates['codex-gate'].files) {
      expect(f.sha256).toMatch(/^sha256:[0-9a-f]+$/);
      expect(f.sha256).not.toMatch(/^sha256:0+$/);
    }
    // installedAt changed (was the install time, now the update time).
    expect(after.installedAt).not.toBe(before.installedAt);
  });

  it('AC-13: branchProtection block is preserved across update', async () => {
    const target = tmp();
    install({ gate: 'codex-gate', target });
    // Manually inject a branchProtection block (as install --auto-protect would).
    const cicd = readCicd(target);
    cicd.gates['codex-gate'].branchProtection = {
      configured: true,
      checkName: 'codex-review-gate',
      branch: 'main',
      configuredAt: '2026-05-13T10:00:00.000Z',
      mergedContexts: ['codex-review-gate'],
    };
    writeFileSync(
      join(target, '.aiox', 'cicd-version'),
      JSON.stringify(cicd, null, 2) + '\n',
      'utf8',
    );
    pretendOlderInstall(target);
    // Re-inject branchProtection after pretendOlderInstall (which writes a clean record).
    const cicd2 = readCicd(target);
    cicd2.gates['codex-gate'].branchProtection = {
      configured: true,
      checkName: 'codex-review-gate',
      branch: 'main',
      configuredAt: '2026-05-13T10:00:00.000Z',
      mergedContexts: ['codex-review-gate'],
    };
    writeFileSync(
      join(target, '.aiox', 'cicd-version'),
      JSON.stringify(cicd2, null, 2) + '\n',
      'utf8',
    );

    const rc = await update({
      target,
      autoUpdate: true,
      noRegistryCheck: true,
      tty: makeFakeTty({ interactive: false }),
    });
    expect(rc).toBe(0);
    const after = readCicd(target);
    expect(after.gates['codex-gate'].branchProtection).toMatchObject({
      configured: true,
      checkName: 'codex-review-gate',
      branch: 'main',
    });
  });

  it('no gate installed → exit 1 with remediation', async () => {
    const target = tmp();
    const errSpy = vi.spyOn(console, 'error');
    const rc = await update({
      target,
      noRegistryCheck: true,
      tty: makeFakeTty({ interactive: false }),
    });
    expect(rc).toBe(1);
    expect(errSpy.mock.calls.flat().join('\n')).toMatch(/no gate installed/i);
  });

  it('non-existent target → exit 2 (USAGE error)', async () => {
    const rc = await update({
      target: '/this/path/should/never/exist',
      noRegistryCheck: true,
      tty: makeFakeTty({ interactive: false }),
    });
    expect(rc).toBe(2);
  });

  it('malformed .aiox/cicd-version → exit 1 with remediation', async () => {
    const target = tmp();
    mkdirSync(join(target, '.aiox'), { recursive: true });
    writeFileSync(join(target, '.aiox', 'cicd-version'), 'not-json{{{', 'utf8');
    const errSpy = vi.spyOn(console, 'error');
    const rc = await update({
      target,
      noRegistryCheck: true,
      tty: makeFakeTty({ interactive: false }),
    });
    expect(rc).toBe(1);
    expect(errSpy.mock.calls.flat().join('\n')).toMatch(/not valid JSON/i);
  });

  it('lock file missing the gate record → exit 1', async () => {
    const target = tmp();
    install({ gate: 'codex-gate', target });
    const cicd = readCicd(target);
    delete cicd.gates['codex-gate'];
    writeFileSync(
      join(target, '.aiox', 'cicd-version'),
      JSON.stringify(cicd, null, 2) + '\n',
      'utf8',
    );
    const errSpy = vi.spyOn(console, 'error');
    const rc = await update({
      target,
      noRegistryCheck: true,
      tty: makeFakeTty({ interactive: false }),
    });
    expect(rc).toBe(1);
    expect(errSpy.mock.calls.flat().join('\n')).toMatch(/not recorded/i);
  });

  it('--dry-run + local modifications without --force → still aborts pre-write', async () => {
    const target = tmp();
    install({ gate: 'codex-gate', target });
    pretendOlderInstall(target);
    const yml = join(target, '.github', 'workflows', 'codex-gate.yml');
    writeFileSync(yml, 'local edit\n', 'utf8');
    const before = readCicd(target);
    const rc = await update({
      target,
      dryRun: true,
      noRegistryCheck: true,
      tty: makeFakeTty({ interactive: false }),
    });
    // AC-11 fires before AC-8 dry-run rendering — modifying without
    // --force-update is a hard stop regardless of --dry-run.
    expect(rc).toBe(1);
    // Lock unchanged either way.
    const after = readCicd(target);
    expect(after.gates['codex-gate'].bundleVersion).toBe(before.gates['codex-gate'].bundleVersion);
  });

  it('registry call is skipped when --no-registry-check is set', async () => {
    const target = tmp();
    install({ gate: 'codex-gate', target });
    const registrySpy = {
      getLatestVersion: vi.fn(async () => ({ status: 'online', version: '99.99.99' })),
      clearCache: () => {},
    };
    await update({
      target,
      noRegistryCheck: true,
      registry: registrySpy,
      tty: makeFakeTty({ interactive: false }),
    });
    expect(registrySpy.getLatestVersion).not.toHaveBeenCalled();
  });

  it('registry call happens by default (when --no-registry-check is NOT set)', async () => {
    const target = tmp();
    install({ gate: 'codex-gate', target });
    const registrySpy = {
      getLatestVersion: vi.fn(async () => ({ status: 'online', version: '99.99.99' })),
      clearCache: () => {},
    };
    await update({
      target,
      registry: registrySpy,
      tty: makeFakeTty({ interactive: false }),
    });
    expect(registrySpy.getLatestVersion).toHaveBeenCalledOnce();
  });

  it('AC-13: after update, all 3 bundle files exist with correct sha256', async () => {
    const target = tmp();
    install({ gate: 'codex-gate', target });
    pretendOlderInstall(target);
    await update({
      target,
      autoUpdate: true,
      noRegistryCheck: true,
      tty: makeFakeTty({ interactive: false }),
    });
    // All 3 files present.
    expect(existsSync(join(target, '.github', 'workflows', 'codex-gate.yml'))).toBe(true);
    expect(existsSync(join(target, '.aiox-core', 'development', 'tasks', 'qa-bot-loop.md'))).toBe(true);
    expect(existsSync(join(target, '.claude', 'rules', 'bot-review-integration.md'))).toBe(true);
    // And lock file is internally consistent (sha256 in lock == sha256 of file on disk).
    const after = readCicd(target);
    for (const f of after.gates['codex-gate'].files) {
      const fullPath = join(target, f.targetPath);
      const onDisk = readFileSync(fullPath);
      const expected = createHash('sha256').update(onDisk).digest('hex');
      expect(f.sha256).toBe('sha256:' + expected);
    }
  });
});
