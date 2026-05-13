/**
 * Integration tests for installWithProtection — Story CICD-002-D.
 *
 * These tests exercise the full async flow: synchronous install + TTY
 * decision + branch-protection API + .aiox/cicd-version stamping. The gh
 * CLI is always mocked via the `ghCli` option to keep the suite hermetic.
 *
 * AC coverage:
 *   - AC-1 (TTY matrix) — interactive prompts vs non-TTY auto-apply vs flags
 *   - AC-3 (merge not replace) — surfaced via integration with hub-os fixture
 *   - AC-4 (graceful 403) — install still succeeds (exit 0) when PUT 403s
 *   - AC-5 (--skip-protection) — bundle installs, no API call
 *   - AC-6 (--branch) — propagates through to gh api
 *   - AC-9 (cicd-version stamp) — .aiox/cicd-version gets branchProtection block
 *   - AC-10 (smoke) — covered by manual smoke (Dev Notes); these tests mock the API
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { installWithProtection } from '../src/commands/install.js';

function makeTempGitRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'hubos-review-installprot-'));
  mkdirSync(join(dir, '.git'), { recursive: true });
  return dir;
}

function makeFakeGhCli({ getResponse, putResponse }) {
  const calls = { get: [], put: [] };
  return {
    calls,
    async getProtection(owner, repo, branch) {
      calls.get.push({ owner, repo, branch });
      return getResponse ?? { ok: true, status: 200, body: emptyProt() };
    },
    async putProtection(owner, repo, branch, body) {
      calls.put.push({ owner, repo, branch, body });
      return putResponse ?? { ok: true, body: null, status: 200 };
    },
  };
}

function emptyProt() {
  return {
    required_status_checks: { strict: true, contexts: [] },
    enforce_admins: { enabled: false },
    required_pull_request_reviews: null,
    restrictions: null,
  };
}

function makeFakeTty({ interactive, answer = true }) {
  return {
    isInteractive: () => interactive,
    promptYesNo: vi.fn(async () => answer),
  };
}

function fakeDetectFn(ownerRepo) {
  return async () => ownerRepo;
}

describe('installWithProtection (Story D integration)', () => {
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

  it('AC-5: --skip-protection installs bundle, no gh api call, exit 0', async () => {
    const target = tmp();
    const ghCli = makeFakeGhCli({});
    const rc = await installWithProtection({
      gate: 'codex-gate',
      target,
      skipProtection: true,
      ghCli,
      tty: makeFakeTty({ interactive: true }),
      detectOwnerRepoFn: fakeDetectFn({ owner: 'foo', repo: 'bar' }),
    });
    expect(rc).toBe(0);
    // Bundle was installed.
    expect(existsSync(join(target, '.github', 'workflows', 'codex-gate.yml'))).toBe(true);
    // No gh api call.
    expect(ghCli.calls.get).toHaveLength(0);
    expect(ghCli.calls.put).toHaveLength(0);
    // .aiox/cicd-version exists but has NO branchProtection block (skipped).
    const cicd = JSON.parse(readFileSync(join(target, '.aiox', 'cicd-version'), 'utf8'));
    expect(cicd.gates['codex-gate'].branchProtection).toBeUndefined();
  });

  it('AC-1: --auto-protect (non-TTY) installs + applies + stamps cicd-version', async () => {
    const target = tmp();
    const ghCli = makeFakeGhCli({
      getResponse: { ok: true, status: 200, body: emptyProt() },
      putResponse: { ok: true, body: null, status: 200 },
    });
    const rc = await installWithProtection({
      gate: 'codex-gate',
      target,
      autoProtect: true,
      ghCli,
      tty: makeFakeTty({ interactive: false }),
      detectOwnerRepoFn: fakeDetectFn({ owner: 'AlfHubPlural', repo: 'cobaia' }),
      now: () => '2026-05-13T10:00:00.000Z',
    });
    expect(rc).toBe(0);
    expect(ghCli.calls.put).toHaveLength(1);
    // Stamp present.
    const cicd = JSON.parse(readFileSync(join(target, '.aiox', 'cicd-version'), 'utf8'));
    expect(cicd.gates['codex-gate'].branchProtection).toMatchObject({
      configured: true,
      checkName: 'codex-review-gate',
      branch: 'main',
      configuredAt: '2026-05-13T10:00:00.000Z',
    });
    expect(cicd.gates['codex-gate'].branchProtection.mergedContexts).toEqual(['codex-review-gate']);
  });

  it('AC-1: --auto-protect + --skip-protection → exit 2 (conflict)', async () => {
    const target = tmp();
    const ghCli = makeFakeGhCli({});
    const rc = await installWithProtection({
      gate: 'codex-gate',
      target,
      autoProtect: true,
      skipProtection: true,
      ghCli,
      tty: makeFakeTty({ interactive: false }),
      detectOwnerRepoFn: fakeDetectFn({ owner: 'foo', repo: 'bar' }),
    });
    expect(rc).toBe(2);
    // Bundle WAS still installed (install ran before flag conflict was detected
    // — Story B's install is synchronous and idempotent, so this is fine).
    expect(existsSync(join(target, '.github', 'workflows', 'codex-gate.yml'))).toBe(true);
    // But no PUT happened.
    expect(ghCli.calls.put).toHaveLength(0);
  });

  it('AC-3: merges into hub-os fixture WITHOUT removing existing 4 checks', async () => {
    const target = tmp();
    const hubOs = {
      required_status_checks: {
        strict: true,
        contexts: [
          'gitleaks scan',
          'npm audit (critical gate)',
          'Vercel Preview Comments',
          'Run unit tests',
        ],
      },
      enforce_admins: { enabled: false },
      required_pull_request_reviews: null,
      restrictions: null,
    };
    const ghCli = makeFakeGhCli({
      getResponse: { ok: true, status: 200, body: hubOs },
      putResponse: { ok: true, body: null, status: 200 },
    });
    const rc = await installWithProtection({
      gate: 'codex-gate',
      target,
      autoProtect: true,
      ghCli,
      tty: makeFakeTty({ interactive: false }),
      detectOwnerRepoFn: fakeDetectFn({ owner: 'AlfHubPlural', repo: 'hub-os' }),
    });
    expect(rc).toBe(0);
    expect(ghCli.calls.put).toHaveLength(1);
    expect(ghCli.calls.put[0].body.required_status_checks.contexts).toEqual([
      'gitleaks scan',
      'npm audit (critical gate)',
      'Vercel Preview Comments',
      'Run unit tests',
      'codex-review-gate',
    ]);
    // strict/enforce_admins preserved (boolean form for PUT).
    expect(ghCli.calls.put[0].body.required_status_checks.strict).toBe(true);
    expect(ghCli.calls.put[0].body.enforce_admins).toBe(false);
  });

  it('AC-4: 403 from PUT → bundle installed, exit 0, no stamp', async () => {
    const target = tmp();
    const ghCli = makeFakeGhCli({
      getResponse: { ok: true, status: 200, body: emptyProt() },
      putResponse: { ok: false, status: 403, stderr: 'HTTP 403' },
    });
    const errs = [];
    console.error.mockImplementation((s) => errs.push(String(s)));
    const rc = await installWithProtection({
      gate: 'codex-gate',
      target,
      autoProtect: true,
      ghCli,
      tty: makeFakeTty({ interactive: false }),
      detectOwnerRepoFn: fakeDetectFn({ owner: 'someorg', repo: 'restricted' }),
    });
    expect(rc).toBe(0);
    // Bundle installed.
    expect(existsSync(join(target, '.github', 'workflows', 'codex-gate.yml'))).toBe(true);
    // Manual command was logged.
    expect(errs.join('\n')).toMatch(/gh api -X PUT/);
    expect(errs.join('\n')).toMatch(/codex-review-gate/);
    // No branchProtection stamp (because nothing was applied).
    const cicd = JSON.parse(readFileSync(join(target, '.aiox', 'cicd-version'), 'utf8'));
    expect(cicd.gates['codex-gate'].branchProtection).toBeUndefined();
  });

  it('AC-6: --branch=develop propagates through', async () => {
    const target = tmp();
    const ghCli = makeFakeGhCli({});
    await installWithProtection({
      gate: 'codex-gate',
      target,
      autoProtect: true,
      branch: 'develop',
      ghCli,
      tty: makeFakeTty({ interactive: false }),
      detectOwnerRepoFn: fakeDetectFn({ owner: 'foo', repo: 'bar' }),
    });
    expect(ghCli.calls.get[0].branch).toBe('develop');
    expect(ghCli.calls.put[0].branch).toBe('develop');
  });

  it('AC-1 prompt path: TTY + user says yes → applies', async () => {
    const target = tmp();
    const ghCli = makeFakeGhCli({});
    const tty = makeFakeTty({ interactive: true, answer: true });
    const rc = await installWithProtection({
      gate: 'codex-gate',
      target,
      ghCli,
      tty,
      detectOwnerRepoFn: fakeDetectFn({ owner: 'foo', repo: 'bar' }),
    });
    expect(rc).toBe(0);
    expect(tty.promptYesNo).toHaveBeenCalledTimes(1);
    expect(ghCli.calls.put).toHaveLength(1);
  });

  it('AC-1 prompt path: TTY + user says no → skipped, bundle still installed', async () => {
    const target = tmp();
    const ghCli = makeFakeGhCli({});
    const tty = makeFakeTty({ interactive: true, answer: false });
    const rc = await installWithProtection({
      gate: 'codex-gate',
      target,
      ghCli,
      tty,
      detectOwnerRepoFn: fakeDetectFn({ owner: 'foo', repo: 'bar' }),
    });
    expect(rc).toBe(0);
    expect(tty.promptYesNo).toHaveBeenCalledTimes(1);
    expect(ghCli.calls.put).toHaveLength(0);
    // Bundle still installed.
    expect(existsSync(join(target, '.github', 'workflows', 'codex-gate.yml'))).toBe(true);
  });

  it('No origin remote → install succeeds, protection step gracefully skipped', async () => {
    const target = tmp();
    const ghCli = makeFakeGhCli({});
    const errs = [];
    console.error.mockImplementation((s) => errs.push(String(s)));
    const rc = await installWithProtection({
      gate: 'codex-gate',
      target,
      autoProtect: true,
      ghCli,
      tty: makeFakeTty({ interactive: false }),
      detectOwnerRepoFn: async () => null, // simulate "no remote detected"
    });
    expect(rc).toBe(0);
    expect(ghCli.calls.put).toHaveLength(0);
    expect(errs.join('\n')).toMatch(/Could not determine GitHub owner\/repo/);
    // Bundle still installed.
    expect(existsSync(join(target, '.github', 'workflows', 'codex-gate.yml'))).toBe(true);
  });

  it('No origin remote + --skip-protection → exit 0 silently', async () => {
    const target = tmp();
    const ghCli = makeFakeGhCli({});
    const rc = await installWithProtection({
      gate: 'codex-gate',
      target,
      skipProtection: true,
      ghCli,
      tty: makeFakeTty({ interactive: false }),
      detectOwnerRepoFn: async () => null,
    });
    expect(rc).toBe(0);
    expect(ghCli.calls.put).toHaveLength(0);
  });

  it('No origin remote + flag conflict → exit 2', async () => {
    const target = tmp();
    const ghCli = makeFakeGhCli({});
    const rc = await installWithProtection({
      gate: 'codex-gate',
      target,
      autoProtect: true,
      skipProtection: true,
      ghCli,
      tty: makeFakeTty({ interactive: false }),
      detectOwnerRepoFn: async () => null,
    });
    expect(rc).toBe(2);
  });

  it('install failure (non-git target) short-circuits — never tries protection', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hubos-review-nongit-'));
    dirs.push(dir);
    // No .git subdir → not a git repo.
    const ghCli = makeFakeGhCli({});
    const rc = await installWithProtection({
      gate: 'codex-gate',
      target: dir,
      autoProtect: true,
      ghCli,
      tty: makeFakeTty({ interactive: false }),
      detectOwnerRepoFn: fakeDetectFn({ owner: 'foo', repo: 'bar' }),
    });
    expect(rc).toBe(1);
    // No API call.
    expect(ghCli.calls.get).toHaveLength(0);
    expect(ghCli.calls.put).toHaveLength(0);
  });

  it('idempotent: re-running install (already installed) still evaluates protection', async () => {
    const target = tmp();
    const ghCli = makeFakeGhCli({});
    // First run.
    await installWithProtection({
      gate: 'codex-gate',
      target,
      skipProtection: true,
      ghCli,
      tty: makeFakeTty({ interactive: false }),
      detectOwnerRepoFn: fakeDetectFn({ owner: 'foo', repo: 'bar' }),
    });
    // Second run with --auto-protect: install will exit 0 (already installed)
    // but protection should still be evaluated and applied.
    const rc = await installWithProtection({
      gate: 'codex-gate',
      target,
      autoProtect: true,
      ghCli,
      tty: makeFakeTty({ interactive: false }),
      detectOwnerRepoFn: fakeDetectFn({ owner: 'foo', repo: 'bar' }),
    });
    expect(rc).toBe(0);
    expect(ghCli.calls.put).toHaveLength(1);
  });

  it('AC-11: cicd-version is malformed → install fails gracefully (does not crash)', async () => {
    const target = tmp();
    const ghCli = makeFakeGhCli({});
    // Pre-existing install + corrupt cicd-version.
    await installWithProtection({
      gate: 'codex-gate',
      target,
      skipProtection: true,
      ghCli,
      tty: makeFakeTty({ interactive: false }),
      detectOwnerRepoFn: fakeDetectFn({ owner: 'foo', repo: 'bar' }),
    });
    writeFileSync(join(target, '.aiox', 'cicd-version'), 'not-json', 'utf8');
    // Re-run with --auto-protect + --force.
    const rc = await installWithProtection({
      gate: 'codex-gate',
      target,
      force: true,
      autoProtect: true,
      ghCli,
      tty: makeFakeTty({ interactive: false }),
      detectOwnerRepoFn: fakeDetectFn({ owner: 'foo', repo: 'bar' }),
    });
    expect(rc).toBe(0);
    // Now valid again + has branchProtection.
    const cicd = JSON.parse(readFileSync(join(target, '.aiox', 'cicd-version'), 'utf8'));
    expect(cicd.gates['codex-gate'].branchProtection?.configured).toBe(true);
  });
});
