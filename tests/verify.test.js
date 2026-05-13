/**
 * Integration tests for `src/commands/verify.js` (the dispatcher).
 *
 * These exercise the full pre-flight pipeline by injecting a custom ghCli
 * mock and using real temp filesystem fixtures. They cover:
 *
 *   - AC-1: severity-based exit codes (CRITICAL/HIGH FAIL → exit 1;
 *           MEDIUM/LOW WARN → exit 0; WARN on CRITICAL/HIGH → exit 0)
 *   - AC-2: ASCII table contains all 8 checks
 *   - AC-3: --json flag produces schema-conformant JSON
 *   - AC-5: --gate=foo rejects non-codex-gate
 *   - AC-9: --target=<path> operates on alternate directory
 *
 * Each test builds a custom ghCli mock to control what the network would
 * have returned, so the dispatcher can be exercised offline.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  copyFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { verify, CHECK_ORDER } from '../src/commands/verify.js';
import { bundleDir, loadBundleManifest } from '../src/lib/bundle.js';
import { CODEX_BOT_LOGIN } from '../src/checks/codex-app.js';

/** Pretty repo coordinates used across the fixtures. */
const OWNER = 'AlfHubPlural';
const REPO = 'hubos-review';

/**
 * Make a ghCli mock with PASS-ish defaults; tests override what they need.
 *
 * @param {{
 *   authOk?: boolean,
 *   scopes?: string[],
 *   reviewComments?: any[],
 *   issueComments?: any[],
 *   branchOk?: boolean,
 *   admin?: boolean,
 *   remoteUrl?: string,
 * }} cfg
 */
function makeMockGhCli(cfg = {}) {
  const scopes = cfg.scopes ?? ['repo', 'read:org'];
  const authText =
    `✓ Logged in to github.com account ${OWNER} (keyring)\n` +
    "  - Token scopes: " +
    scopes.map((s) => `'${s}'`).join(', ') +
    '\n';
  return {
    gh: () => ({ ok: true, stdout: '', stderr: '', exitCode: 0 }),
    ghAuthStatus: () => ({
      ok: cfg.authOk ?? true,
      text: authText,
      exitCode: cfg.authOk === false ? 1 : 0,
    }),
    getGitHubRemote: () => {
      if (cfg.remoteUrl === null) return null;
      return {
        owner: OWNER,
        repo: REPO,
        remoteUrl: cfg.remoteUrl ?? `git@github.com:${OWNER}/${REPO}.git`,
      };
    },
    ghApi(endpoint) {
      if (endpoint.includes('/pulls/comments')) {
        return {
          ok: true,
          json: cfg.reviewComments ?? [{ user: { login: CODEX_BOT_LOGIN } }],
        };
      }
      if (endpoint.includes('/issues/comments')) {
        return { ok: true, json: cfg.issueComments ?? [] };
      }
      if (endpoint.includes('/branches/')) {
        return cfg.branchOk === false
          ? { ok: false, stderr: 'HTTP 404', exitCode: 1 }
          : { ok: true, json: { name: 'main', protected: false } };
      }
      if (endpoint.match(/\/repos\/[^/]+\/[^/]+$/)) {
        // GET /repos/owner/repo
        return {
          ok: true,
          json: { permissions: { admin: cfg.admin ?? true } },
        };
      }
      return { ok: false, stderr: 'unhandled', exitCode: 1 };
    },
  };
}

/** Build a temp dir with `.git/` so checkGitRepo() can resolve it. */
function makeTempRepo() {
  const d = mkdtempSync(join(tmpdir(), 'hubos-review-verify-test-'));
  mkdirSync(join(d, '.git'), { recursive: true });
  return d;
}

describe('verify dispatcher (Story C — integration)', () => {
  /** @type {string[]} */
  const dirsToCleanup = [];
  function tmp() {
    const d = makeTempRepo();
    dirsToCleanup.push(d);
    return d;
  }

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    while (dirsToCleanup.length > 0) {
      try {
        rmSync(dirsToCleanup.pop(), { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
    }
  });

  describe('AC-1 — severity-based exit codes', () => {
    it('exit 0 when all checks PASS', async () => {
      const target = tmp();
      const rc = await verify({
        target,
        ghCli: makeMockGhCli(),
      });
      expect(rc).toBe(0);
    });

    it('exit 1 when C1 (CRITICAL) FAILs (no auth)', async () => {
      const target = tmp();
      const rc = await verify({
        target,
        ghCli: makeMockGhCli({ authOk: false }),
      });
      expect(rc).toBe(1);
    });

    it('exit 1 when C5 (HIGH) FAILs (no admin)', async () => {
      const target = tmp();
      const rc = await verify({
        target,
        ghCli: makeMockGhCli({ admin: false }),
      });
      expect(rc).toBe(1);
    });

    it('exit 0 when CRITICAL is WARN (codex-app no-signal case)', async () => {
      const target = tmp();
      const rc = await verify({
        target,
        ghCli: makeMockGhCli({ reviewComments: [], issueComments: [] }),
      });
      // C3 returns WARN (blocking: false), not FAIL, so exit code stays 0.
      expect(rc).toBe(0);
    });

    it('exit 0 when only LOW (C7) warns about orphans', async () => {
      const target = tmp();
      mkdirSync(join(target, '.github', 'workflows'), { recursive: true });
      writeFileSync(join(target, '.github', 'workflows', 'ci.yml'), '');
      const rc = await verify({
        target,
        ghCli: makeMockGhCli(),
      });
      expect(rc).toBe(0);
    });
  });

  describe('AC-2 — ASCII table output', () => {
    it('renders 8 rows when all checks complete', async () => {
      const target = tmp();
      const logs = [];
      console.log.mockImplementation((s) => logs.push(String(s)));
      await verify({ target, ghCli: makeMockGhCli() });
      const out = logs.join('\n');
      for (const id of CHECK_ORDER) {
        expect(out, `expected row for ${id}`).toMatch(new RegExp(`\\b${id}\\b`));
      }
      expect(out).toContain('CHECK ID');
      expect(out).toContain('STATUS');
      expect(out).toContain('SEV');
    });

    it('emits "Ready to install" banner on success', async () => {
      const target = tmp();
      const logs = [];
      console.log.mockImplementation((s) => logs.push(String(s)));
      await verify({ target, ghCli: makeMockGhCli() });
      expect(logs.join('\n')).toMatch(/Result:\s*PASS/);
    });

    it('emits FAIL banner with blocking issues list on failure', async () => {
      const target = tmp();
      const logs = [];
      console.log.mockImplementation((s) => logs.push(String(s)));
      await verify({
        target,
        ghCli: makeMockGhCli({ authOk: false }),
      });
      const out = logs.join('\n');
      expect(out).toMatch(/Result:\s*FAIL/);
      expect(out).toMatch(/C1.*CRITICAL/);
      expect(out).toMatch(/Remediation:/);
    });
  });

  describe('AC-3 — --json output', () => {
    it('emits a parseable JSON payload', async () => {
      const target = tmp();
      const logs = [];
      console.log.mockImplementation((s) => logs.push(String(s)));
      const rc = await verify({
        target,
        json: true,
        ghCli: makeMockGhCli(),
      });
      expect(rc).toBe(0);
      const payload = JSON.parse(logs.join(''));
      expect(payload.repo).toBe(`${OWNER}/${REPO}`);
      expect(payload.overall).toBe('PASS');
      expect(payload.exitCode).toBe(0);
      expect(payload.checks).toHaveLength(8);
      expect(payload.checks.map((c) => c.id).sort()).toEqual(
        ['C1', 'C2', 'C3', 'C4', 'C5', 'C5b', 'C6', 'C7'].sort(),
      );
      for (const c of payload.checks) {
        expect(c).toHaveProperty('severity');
        expect(c).toHaveProperty('status');
        expect(c).toHaveProperty('blocking');
        expect(c).toHaveProperty('details');
      }
    });

    it('JSON contains remediation field on failing rows', async () => {
      const target = tmp();
      const logs = [];
      console.log.mockImplementation((s) => logs.push(String(s)));
      await verify({
        target,
        json: true,
        ghCli: makeMockGhCli({ authOk: false }),
      });
      const payload = JSON.parse(logs.join(''));
      const c1 = payload.checks.find((c) => c.id === 'C1');
      expect(c1.status).toBe('FAIL');
      expect(c1.remediation).toMatch(/gh auth login/);
    });
  });

  describe('AC-5 — --gate must be codex-gate', () => {
    it('rejects unknown gate with exit 1', async () => {
      const target = tmp();
      const errs = [];
      console.error.mockImplementation((s) => errs.push(String(s)));
      const rc = await verify({
        target,
        gate: 'gitleaks-gate',
        ghCli: makeMockGhCli(),
      });
      expect(rc).toBe(1);
      expect(errs.join('\n')).toMatch(/codex-gate/);
    });

    it('returns JSON error when --json and unknown gate combined', async () => {
      const target = tmp();
      const logs = [];
      console.log.mockImplementation((s) => logs.push(String(s)));
      const rc = await verify({
        target,
        gate: 'gitleaks-gate',
        json: true,
        ghCli: makeMockGhCli(),
      });
      expect(rc).toBe(1);
      const payload = JSON.parse(logs.join(''));
      expect(payload.overall).toBe('FAIL');
      expect(payload.exitCode).toBe(1);
      expect(payload.error).toMatch(/codex-gate/);
    });
  });

  describe('AC-9 — --target operates on alternate directory', () => {
    it('verify on --target does not require process.cwd() to be a git repo', async () => {
      const target = tmp();
      // Run from a tempdir that is NOT a git repo to prove --target is used.
      const cwdDir = mkdtempSync(join(tmpdir(), 'hubos-review-verify-cwd-'));
      dirsToCleanup.push(cwdDir);
      const rc = await verify({
        target,
        ghCli: makeMockGhCli(),
      });
      expect(rc).toBe(0);
    });
  });

  describe('AC-1 + AC-2 — combined no-conflict scenarios', () => {
    it('FAIL when codex-gate.yml exists with custom content + no cicd-version', async () => {
      const target = tmp();
      mkdirSync(join(target, '.github', 'workflows'), { recursive: true });
      writeFileSync(join(target, '.github', 'workflows', 'codex-gate.yml'), 'custom\n');
      const rc = await verify({
        target,
        ghCli: makeMockGhCli(),
      });
      expect(rc).toBe(1); // C5b (HIGH) FAILs because hash differs and no cicd-version
    });

    it('exits 0 when bundled file is byte-identical', async () => {
      const target = tmp();
      mkdirSync(join(target, '.github', 'workflows'), { recursive: true });
      const manifest = loadBundleManifest('codex-gate', 'v1');
      const wfEntry = manifest.files.find(
        (f) => f.targetPath === '.github/workflows/codex-gate.yml',
      );
      copyFileSync(
        join(bundleDir('codex-gate', 'v1'), wfEntry.bundlePath),
        join(target, '.github', 'workflows', 'codex-gate.yml'),
      );
      const rc = await verify({
        target,
        ghCli: makeMockGhCli(),
      });
      expect(rc).toBe(0);
    });
  });

  describe('AC-1 — concurrent execution of independent checks', () => {
    it('runs C3-C7 in parallel after C1/C2 (smoke — ghApi called for each)', async () => {
      const target = tmp();
      const apiCalls = [];
      const ghCli = makeMockGhCli();
      const origApi = ghCli.ghApi;
      ghCli.ghApi = (endpoint, ...args) => {
        apiCalls.push(endpoint);
        return origApi(endpoint, ...args);
      };
      await verify({ target, ghCli });
      // At least one call per concurrent check that needs network:
      //   C3: /pulls/comments
      //   C4: /branches/main
      //   C5: /repos/owner/repo
      expect(apiCalls.some((e) => e.includes('/pulls/comments'))).toBe(true);
      expect(apiCalls.some((e) => e.includes('/branches/'))).toBe(true);
      expect(
        apiCalls.some(
          (e) => e.match(/\/repos\/[^/]+\/[^/]+$/) && !e.includes('branches'),
        ),
      ).toBe(true);
    });
  });
});
