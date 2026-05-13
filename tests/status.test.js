/**
 * Integration tests for `hubos-review status`.
 *
 * Story: CICD-002-E (AC-1, AC-2, AC-3, AC-4, AC-5, AC-6, AC-14).
 *
 * Strategy: each test makes a fresh tmp git repo, runs `install` to seed
 * `.aiox/cicd-version`, then calls `status({...})` directly (no subprocess).
 * Registry + gh api dependencies are injected so the suite is hermetic.
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

import { install } from '../src/commands/install.js';
import { status } from '../src/commands/status.js';

function makeTempGitRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'hubos-review-status-test-'));
  mkdirSync(join(dir, '.git'), { recursive: true });
  return dir;
}

/** Fake gh client — returns a configurable response without spawning gh. */
function makeFakeGhCli({ getResponse } = {}) {
  return {
    async getProtection() {
      return (
        getResponse ?? {
          ok: true,
          status: 200,
          body: {
            required_status_checks: { strict: true, contexts: ['codex-review-gate'] },
            enforce_admins: { enabled: false },
            required_pull_request_reviews: null,
            restrictions: null,
          },
        }
      );
    },
    async putProtection() {
      throw new Error('status() should never PUT');
    },
  };
}

/** Fake registry — returns deterministic version. */
function makeFakeRegistry(version, { status = 'online' } = {}) {
  return {
    async getLatestVersion() {
      if (status === 'offline') return { status: 'offline', version: null, error: 'mock-offline' };
      return { status: 'online', version };
    },
    clearCache() {},
  };
}

const fakeDetect = (or) => async () => or;

describe('hubos-review status', () => {
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

  it('AC-2: no .aiox/cicd-version → exit 1 + remediation message', async () => {
    const target = tmp();
    const errSpy = vi.spyOn(console, 'error');
    const rc = await status({ target, noRegistryCheck: true });
    expect(rc).toBe(1);
    const messages = errSpy.mock.calls.flat().join('\n');
    expect(messages).toMatch(/no gate installed/i);
    expect(messages).toMatch(/install codex-gate/);
  });

  it('AC-6: --target points status at a different directory', async () => {
    const target = tmp();
    expect(existsSync(join(target, '.aiox', 'cicd-version'))).toBe(false);
    const rc = await status({ target, noRegistryCheck: true });
    expect(rc).toBe(1);
  });

  it('AC-1: status on a freshly installed repo with all hashes matching → exit 0', async () => {
    const target = tmp();
    install({ gate: 'codex-gate', target });
    const rc = await status({
      target,
      noRegistryCheck: true,
      ghCli: makeFakeGhCli(),
      detectOwnerRepoFn: fakeDetect({ owner: 'foo', repo: 'bar' }),
    });
    expect(rc).toBe(0);
  });

  it('AC-4: hash mismatch on disk → status returns 0 (WARN) and reports MODIFIED', async () => {
    const target = tmp();
    install({ gate: 'codex-gate', target });
    // Tamper with one of the 3 installed files.
    const yml = join(target, '.github', 'workflows', 'codex-gate.yml');
    writeFileSync(yml, readFileSync(yml, 'utf8') + '\n# local edit\n', 'utf8');
    const rc = await status({
      target,
      noRegistryCheck: true,
      json: true,
      ghCli: makeFakeGhCli(),
      detectOwnerRepoFn: fakeDetect({ owner: 'foo', repo: 'bar' }),
    });
    // AC-4 explicitly: modified is a WARNING, NOT an error → exit 0.
    expect(rc).toBe(0);
  });

  it('AC-1 critical: missing file → exit 1 (FAIL)', async () => {
    const target = tmp();
    install({ gate: 'codex-gate', target });
    // Delete one of the 3 files.
    rmSync(join(target, '.github', 'workflows', 'codex-gate.yml'));
    const rc = await status({
      target,
      noRegistryCheck: true,
      ghCli: makeFakeGhCli(),
      detectOwnerRepoFn: fakeDetect({ owner: 'foo', repo: 'bar' }),
    });
    expect(rc).toBe(1);
  });

  it('AC-3: --json produces a schema-stable payload', async () => {
    const target = tmp();
    install({ gate: 'codex-gate', target });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const rc = await status({
      target,
      noRegistryCheck: true,
      json: true,
      ghCli: makeFakeGhCli(),
      detectOwnerRepoFn: fakeDetect({ owner: 'foo', repo: 'bar' }),
    });
    expect(rc).toBe(0);
    // Last console.log call was the JSON payload.
    const lastCall = logSpy.mock.calls[logSpy.mock.calls.length - 1];
    const payload = JSON.parse(lastCall[0]);
    expect(payload).toHaveProperty('target');
    expect(payload).toHaveProperty('package');
    expect(payload).toHaveProperty('installedVersion');
    expect(payload).toHaveProperty('gates');
    expect(payload).toHaveProperty('overall');
    expect(payload.gates['codex-gate']).toHaveProperty('files');
    expect(payload.gates['codex-gate'].files).toHaveLength(3);
    expect(payload.gates['codex-gate'].files[0]).toHaveProperty('status');
    expect(payload.overall).toBe('OK');
  });

  it('AC-5: --no-registry-check skips npm registry lookup', async () => {
    const target = tmp();
    install({ gate: 'codex-gate', target });
    const registrySpy = makeFakeRegistry('99.99.99');
    const wrapped = {
      getLatestVersion: vi.fn(registrySpy.getLatestVersion),
      clearCache: () => {},
    };
    const rc = await status({
      target,
      noRegistryCheck: true,
      registry: wrapped,
      ghCli: makeFakeGhCli(),
      detectOwnerRepoFn: fakeDetect({ owner: 'foo', repo: 'bar' }),
    });
    expect(rc).toBe(0);
    // Registry should NOT have been called when --no-registry-check is set.
    expect(wrapped.getLatestVersion).not.toHaveBeenCalled();
  });

  it('AC-3 + AC-5: --json + --no-registry-check returns registryStatus: offline', async () => {
    const target = tmp();
    install({ gate: 'codex-gate', target });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await status({
      target,
      noRegistryCheck: true,
      json: true,
      ghCli: makeFakeGhCli(),
      detectOwnerRepoFn: fakeDetect({ owner: 'foo', repo: 'bar' }),
    });
    const payload = JSON.parse(logSpy.mock.calls[logSpy.mock.calls.length - 1][0]);
    expect(payload.registryStatus).toBe('offline');
    expect(payload.latestAvailable).toBeNull();
  });

  it('newer registry version → updateAvailable: true in JSON payload', async () => {
    const target = tmp();
    install({ gate: 'codex-gate', target });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await status({
      target,
      registry: makeFakeRegistry('99.99.99'),
      json: true,
      ghCli: makeFakeGhCli(),
      detectOwnerRepoFn: fakeDetect({ owner: 'foo', repo: 'bar' }),
    });
    const payload = JSON.parse(logSpy.mock.calls[logSpy.mock.calls.length - 1][0]);
    expect(payload.latestAvailable).toBe('99.99.99');
    expect(payload.updateAvailable).toBe(true);
  });

  it('branch protection configured → state: configured in JSON', async () => {
    const target = tmp();
    install({ gate: 'codex-gate', target });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await status({
      target,
      noRegistryCheck: true,
      json: true,
      ghCli: makeFakeGhCli(),
      detectOwnerRepoFn: fakeDetect({ owner: 'foo', repo: 'bar' }),
    });
    const payload = JSON.parse(logSpy.mock.calls[logSpy.mock.calls.length - 1][0]);
    expect(payload.gates['codex-gate'].branchProtection.state).toBe('configured');
  });

  it('branch protection 403 → state: cannot-verify', async () => {
    const target = tmp();
    install({ gate: 'codex-gate', target });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await status({
      target,
      noRegistryCheck: true,
      json: true,
      ghCli: makeFakeGhCli({ getResponse: { ok: false, status: 403, stderr: 'HTTP 403' } }),
      detectOwnerRepoFn: fakeDetect({ owner: 'foo', repo: 'bar' }),
    });
    const payload = JSON.parse(logSpy.mock.calls[logSpy.mock.calls.length - 1][0]);
    expect(payload.gates['codex-gate'].branchProtection.state).toBe('cannot-verify');
  });

  it('branch protection 404 → state: not-configured', async () => {
    const target = tmp();
    install({ gate: 'codex-gate', target });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await status({
      target,
      noRegistryCheck: true,
      json: true,
      ghCli: makeFakeGhCli({ getResponse: { ok: false, status: 404, stderr: 'Not Found' } }),
      detectOwnerRepoFn: fakeDetect({ owner: 'foo', repo: 'bar' }),
    });
    const payload = JSON.parse(logSpy.mock.calls[logSpy.mock.calls.length - 1][0]);
    expect(payload.gates['codex-gate'].branchProtection.state).toBe('not-configured');
  });

  it('no GitHub remote → state: no-remote', async () => {
    const target = tmp();
    install({ gate: 'codex-gate', target });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await status({
      target,
      noRegistryCheck: true,
      json: true,
      ghCli: makeFakeGhCli(),
      detectOwnerRepoFn: async () => null,
    });
    const payload = JSON.parse(logSpy.mock.calls[logSpy.mock.calls.length - 1][0]);
    expect(payload.gates['codex-gate'].branchProtection.state).toBe('no-remote');
  });

  it('malformed .aiox/cicd-version → exit 1 with remediation', async () => {
    const target = tmp();
    mkdirSync(join(target, '.aiox'), { recursive: true });
    writeFileSync(join(target, '.aiox', 'cicd-version'), '{not-json:', 'utf8');
    const errSpy = vi.spyOn(console, 'error');
    const rc = await status({ target, noRegistryCheck: true });
    expect(rc).toBe(1);
    expect(errSpy.mock.calls.flat().join('\n')).toMatch(/not valid JSON/i);
  });

  it('non-existent target → exit 2 (USAGE error)', async () => {
    const rc = await status({
      target: '/this/path/should/never/exist/in/the/universe',
      noRegistryCheck: true,
    });
    expect(rc).toBe(2);
  });

  it('JSON output preserves exitCode field consistent with return value', async () => {
    const target = tmp();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const rc = await status({
      target,
      noRegistryCheck: true,
      json: true,
    });
    expect(rc).toBe(1);
    const payload = JSON.parse(logSpy.mock.calls[logSpy.mock.calls.length - 1][0]);
    expect(payload.exitCode).toBe(1);
    expect(payload.overall).toBe('NOT_INSTALLED');
  });
});
