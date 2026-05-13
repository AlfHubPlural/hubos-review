/**
 * Unit tests for src/lib/branch-protection.js.
 *
 * Story: CICD-002-D — AC-3 (merge not replace), AC-4 (graceful 403),
 * AC-6 (--branch), AC-7 (mocked gh api), AC-11 (cicd-version stamp via
 * installWithProtection integration).
 *
 * The fixture is a "fake ghCli" — same shape as createDefaultGhCli() returns,
 * but every method just resolves a pre-programmed outcome. No real `gh`
 * binary or network is touched.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  configureBranchProtection,
  maybeConfigureBranchProtection,
  decideProtectionFlow,
  mergeCheckIntoBody,
  normalizeForPut,
  buildManualCommand,
  parseGithubRemote,
  DEFAULT_CHECK_NAME,
} from '../src/lib/branch-protection.js';

/**
 * Stub a gh CLI with programmable responses.
 *
 * @param {object} cfg
 * @param {object} [cfg.getResponse]   what getProtection returns
 * @param {object} [cfg.putResponse]   what putProtection returns
 */
function fakeGhCli({ getResponse, putResponse } = {}) {
  const calls = { get: [], put: [] };
  return {
    calls,
    async getProtection(owner, repo, branch) {
      calls.get.push({ owner, repo, branch });
      return getResponse ?? { ok: true, body: emptyProtectionBody(), status: 200 };
    },
    async putProtection(owner, repo, branch, body) {
      calls.put.push({ owner, repo, branch, body });
      return putResponse ?? { ok: true, body: null, status: 200 };
    },
  };
}

function emptyProtectionBody() {
  return {
    required_status_checks: { strict: true, contexts: [] },
    enforce_admins: { enabled: false },
    required_pull_request_reviews: null,
    restrictions: null,
  };
}

/**
 * The empirically captured hub-os protection state (2026-05-12, see
 * branch-protection.js header). Used as the most realistic merge fixture.
 */
function hubOsProtectionBody() {
  return {
    required_status_checks: {
      strict: true,
      contexts: [
        'gitleaks scan',
        'npm audit (critical gate)',
        'Vercel Preview Comments',
        'Run unit tests',
        'codex-review-gate',
      ],
    },
    enforce_admins: { enabled: false },
    required_pull_request_reviews: null,
    restrictions: null,
  };
}

describe('parseGithubRemote', () => {
  it('parses SSH remote with .git suffix', () => {
    expect(parseGithubRemote('git@github.com:AlfHubPlural/hubos-review.git')).toEqual({
      owner: 'AlfHubPlural',
      repo: 'hubos-review',
    });
  });
  it('parses SSH remote without .git suffix', () => {
    expect(parseGithubRemote('git@github.com:foo/bar')).toEqual({ owner: 'foo', repo: 'bar' });
  });
  it('parses HTTPS remote with .git suffix', () => {
    expect(parseGithubRemote('https://github.com/AlfHubPlural/hubos-review.git')).toEqual({
      owner: 'AlfHubPlural',
      repo: 'hubos-review',
    });
  });
  it('parses HTTPS remote without .git suffix and trailing slash', () => {
    expect(parseGithubRemote('https://github.com/foo/bar/')).toEqual({ owner: 'foo', repo: 'bar' });
  });
  it('returns null for non-GitHub URL', () => {
    expect(parseGithubRemote('git@gitlab.com:foo/bar.git')).toBeNull();
  });
  it('returns null for empty input', () => {
    expect(parseGithubRemote('')).toBeNull();
    expect(parseGithubRemote(null)).toBeNull();
  });
});

describe('normalizeForPut', () => {
  it('returns sane defaults when no prior protection (null input)', () => {
    expect(normalizeForPut(null)).toEqual({
      required_status_checks: { strict: true, contexts: [] },
      enforce_admins: false,
      required_pull_request_reviews: null,
      restrictions: null,
    });
  });

  it('flattens enforce_admins.enabled → bare boolean', () => {
    const got = normalizeForPut(hubOsProtectionBody());
    expect(got.enforce_admins).toBe(false);
  });

  it('preserves all 5 contexts from hub-os fixture', () => {
    const got = normalizeForPut(hubOsProtectionBody());
    expect(got.required_status_checks.contexts).toEqual([
      'gitleaks scan',
      'npm audit (critical gate)',
      'Vercel Preview Comments',
      'Run unit tests',
      'codex-review-gate',
    ]);
    expect(got.required_status_checks.strict).toBe(true);
  });

  it('defaults strict to true if missing', () => {
    const got = normalizeForPut({ required_status_checks: { contexts: ['x'] } });
    expect(got.required_status_checks.strict).toBe(true);
  });

  it('accepts bare boolean enforce_admins', () => {
    const got = normalizeForPut({
      required_status_checks: { strict: false, contexts: [] },
      enforce_admins: true,
    });
    expect(got.enforce_admins).toBe(true);
  });
});

describe('mergeCheckIntoBody', () => {
  it('appends new check to empty contexts', () => {
    const { body, alreadyPresent } = mergeCheckIntoBody(
      normalizeForPut(null),
      'codex-review-gate',
    );
    expect(alreadyPresent).toBe(false);
    expect(body.required_status_checks.contexts).toEqual(['codex-review-gate']);
  });

  it('appends without removing pre-existing checks (CRITICAL — AC-3)', () => {
    const normalized = normalizeForPut({
      required_status_checks: {
        strict: true,
        contexts: ['gitleaks scan', 'Run unit tests'],
      },
    });
    const { body } = mergeCheckIntoBody(normalized, 'codex-review-gate');
    expect(body.required_status_checks.contexts).toEqual([
      'gitleaks scan',
      'Run unit tests',
      'codex-review-gate',
    ]);
  });

  it('is idempotent — same check already present is detected', () => {
    const normalized = normalizeForPut(hubOsProtectionBody());
    const { body, alreadyPresent } = mergeCheckIntoBody(normalized, 'codex-review-gate');
    expect(alreadyPresent).toBe(true);
    expect(body.required_status_checks.contexts).toEqual(normalized.required_status_checks.contexts);
  });

  it('does not mutate the input body on merge', () => {
    const normalized = normalizeForPut(null);
    const before = JSON.parse(JSON.stringify(normalized));
    mergeCheckIntoBody(normalized, 'codex-review-gate');
    expect(normalized).toEqual(before);
  });
});

describe('buildManualCommand', () => {
  it('produces a heredoc with stable JSON', () => {
    const cmd = buildManualCommand('foo', 'bar', 'main', {
      required_status_checks: { strict: true, contexts: ['codex-review-gate'] },
      enforce_admins: false,
      required_pull_request_reviews: null,
      restrictions: null,
    });
    expect(cmd).toMatch(/gh api -X PUT \/repos\/foo\/bar\/branches\/main\/protection/);
    expect(cmd).toMatch(/--input - <<'EOF'/);
    expect(cmd).toContain('"codex-review-gate"');
    expect(cmd).toMatch(/EOF\s*$/);
  });
});

describe('decideProtectionFlow', () => {
  it('conflict when both flags set', () => {
    expect(
      decideProtectionFlow({ autoProtect: true, skipProtection: true, isInteractive: false }),
    ).toMatchObject({ action: 'conflict' });
    expect(
      decideProtectionFlow({ autoProtect: true, skipProtection: true, isInteractive: true }),
    ).toMatchObject({ action: 'conflict' });
  });

  it('--skip-protection wins over TTY context', () => {
    expect(
      decideProtectionFlow({ autoProtect: false, skipProtection: true, isInteractive: true }),
    ).toEqual({ action: 'skip-flag' });
    expect(
      decideProtectionFlow({ autoProtect: false, skipProtection: true, isInteractive: false }),
    ).toEqual({ action: 'skip-flag' });
  });

  it('--auto-protect bypasses TTY prompt', () => {
    expect(
      decideProtectionFlow({ autoProtect: true, skipProtection: false, isInteractive: true }),
    ).toEqual({ action: 'auto-flag' });
    expect(
      decideProtectionFlow({ autoProtect: true, skipProtection: false, isInteractive: false }),
    ).toEqual({ action: 'auto-flag' });
  });

  it('TTY without flags → prompt-tty', () => {
    expect(
      decideProtectionFlow({ autoProtect: false, skipProtection: false, isInteractive: true }),
    ).toEqual({ action: 'prompt-tty' });
  });

  it('non-TTY without flags → auto-non-tty', () => {
    expect(
      decideProtectionFlow({ autoProtect: false, skipProtection: false, isInteractive: false }),
    ).toEqual({ action: 'auto-non-tty' });
  });
});

describe('configureBranchProtection', () => {
  it('AC-3: merges into existing contexts without removing them', async () => {
    const ghCli = fakeGhCli({
      getResponse: {
        ok: true,
        status: 200,
        body: {
          required_status_checks: {
            strict: true,
            contexts: ['gitleaks scan', 'Run unit tests'],
          },
          enforce_admins: { enabled: false },
          required_pull_request_reviews: null,
          restrictions: null,
        },
      },
      putResponse: { ok: true, body: null, status: 200 },
    });
    const result = await configureBranchProtection({
      ghCli,
      owner: 'AlfHubPlural',
      repo: 'cobaia',
    });
    expect(result.status).toBe('applied');
    expect(result.previousContexts).toEqual(['gitleaks scan', 'Run unit tests']);
    expect(result.mergedContexts).toEqual([
      'gitleaks scan',
      'Run unit tests',
      'codex-review-gate',
    ]);
    // Verify the PUT payload preserved everything plus the new check.
    expect(ghCli.calls.put).toHaveLength(1);
    expect(ghCli.calls.put[0].body.required_status_checks.contexts).toEqual([
      'gitleaks scan',
      'Run unit tests',
      'codex-review-gate',
    ]);
  });

  it('creates from scratch when no protection (GET 404)', async () => {
    const ghCli = fakeGhCli({
      getResponse: { ok: false, status: 404, stderr: 'HTTP 404' },
      putResponse: { ok: true, body: null, status: 200 },
    });
    const result = await configureBranchProtection({
      ghCli,
      owner: 'foo',
      repo: 'bar',
    });
    expect(result.status).toBe('applied');
    expect(result.previousContexts).toEqual([]);
    expect(result.mergedContexts).toEqual(['codex-review-gate']);
    expect(ghCli.calls.put[0].body.required_status_checks.strict).toBe(true);
    expect(ghCli.calls.put[0].body.enforce_admins).toBe(false);
  });

  it('is idempotent (GET shows check already present) — does NOT call PUT', async () => {
    const ghCli = fakeGhCli({
      getResponse: { ok: true, status: 200, body: hubOsProtectionBody() },
    });
    const result = await configureBranchProtection({
      ghCli,
      owner: 'AlfHubPlural',
      repo: 'hub-os',
    });
    expect(result.status).toBe('noop');
    expect(ghCli.calls.put).toHaveLength(0);
    expect(result.mergedContexts).toEqual(hubOsProtectionBody().required_status_checks.contexts);
  });

  it('AC-4: returns forbidden with manualCommand on PUT 403', async () => {
    const ghCli = fakeGhCli({
      getResponse: { ok: true, status: 200, body: emptyProtectionBody() },
      putResponse: { ok: false, status: 403, stderr: 'HTTP 403 Must have admin' },
    });
    const result = await configureBranchProtection({
      ghCli,
      owner: 'someorg',
      repo: 'restricted-repo',
    });
    expect(result.status).toBe('forbidden');
    expect(result.reason).toBe('insufficient-permissions');
    expect(result.manualCommand).toMatch(/gh api -X PUT/);
    expect(result.manualCommand).toMatch(/codex-review-gate/);
  });

  it('AC-4: returns forbidden when GET itself is 403', async () => {
    const ghCli = fakeGhCli({
      getResponse: { ok: false, status: 403, stderr: 'HTTP 403' },
    });
    const result = await configureBranchProtection({
      ghCli,
      owner: 'someorg',
      repo: 'restricted-repo',
    });
    expect(result.status).toBe('forbidden');
    expect(result.manualCommand).toContain('codex-review-gate');
    // Should NOT have attempted PUT.
    expect(ghCli.calls.put).toHaveLength(0);
  });

  it('returns not-found when branch does not exist (PUT 404)', async () => {
    const ghCli = fakeGhCli({
      getResponse: { ok: false, status: 404, stderr: 'HTTP 404' },
      putResponse: { ok: false, status: 404, stderr: 'HTTP 404 Not Found' },
    });
    const result = await configureBranchProtection({
      ghCli,
      owner: 'foo',
      repo: 'bar',
      branch: 'no-such-branch',
    });
    expect(result.status).toBe('not-found');
    expect(result.branch).toBe('no-such-branch');
  });

  it('AC-6: respects custom --branch', async () => {
    const ghCli = fakeGhCli({
      getResponse: { ok: true, status: 200, body: emptyProtectionBody() },
      putResponse: { ok: true, body: null, status: 200 },
    });
    await configureBranchProtection({
      ghCli,
      owner: 'foo',
      repo: 'bar',
      branch: 'develop',
    });
    expect(ghCli.calls.get[0].branch).toBe('develop');
    expect(ghCli.calls.put[0].branch).toBe('develop');
  });

  it('respects custom checkName', async () => {
    const ghCli = fakeGhCli({
      getResponse: { ok: true, status: 200, body: emptyProtectionBody() },
      putResponse: { ok: true, body: null, status: 200 },
    });
    const result = await configureBranchProtection({
      ghCli,
      owner: 'foo',
      repo: 'bar',
      checkName: 'gitleaks-gate',
    });
    expect(result.mergedContexts).toEqual(['gitleaks-gate']);
    expect(result.checkName).toBe('gitleaks-gate');
  });

  it('returns error when ghCli has no methods', async () => {
    const result = await configureBranchProtection({
      ghCli: null,
      owner: 'foo',
      repo: 'bar',
    });
    expect(result.status).toBe('error');
  });

  it('returns error when owner/repo missing', async () => {
    const ghCli = fakeGhCli();
    const r1 = await configureBranchProtection({ ghCli, owner: '', repo: 'x' });
    expect(r1.status).toBe('error');
    const r2 = await configureBranchProtection({ ghCli, owner: 'x', repo: '' });
    expect(r2.status).toBe('error');
  });

  it('returns error when GET fails with non-403/404 (network)', async () => {
    const ghCli = fakeGhCli({
      getResponse: { ok: false, status: null, stderr: 'connection refused' },
    });
    const result = await configureBranchProtection({
      ghCli,
      owner: 'foo',
      repo: 'bar',
    });
    expect(result.status).toBe('error');
    expect(result.reason).toBe('gh-get-failed');
  });

  it('AC-3 + AC-6 + AC-11: real hub-os fixture, --branch=main, no-op when codex-review-gate present', async () => {
    const ghCli = fakeGhCli({
      getResponse: { ok: true, status: 200, body: hubOsProtectionBody() },
    });
    const result = await configureBranchProtection({
      ghCli,
      owner: 'AlfHubPlural',
      repo: 'hub-os',
      branch: 'main',
    });
    expect(result.status).toBe('noop');
    // Verify we read but didn't write.
    expect(ghCli.calls.get).toHaveLength(1);
    expect(ghCli.calls.put).toHaveLength(0);
  });

  it('respects DEFAULT_CHECK_NAME constant', () => {
    expect(DEFAULT_CHECK_NAME).toBe('codex-review-gate');
  });
});

describe('maybeConfigureBranchProtection (matrix integration)', () => {
  function makeTty({ interactive, answer = true }) {
    return {
      isInteractive: () => interactive,
      promptYesNo: vi.fn(async () => answer),
    };
  }

  it('flag conflict → outcome=conflict, no API call', async () => {
    const ghCli = fakeGhCli();
    const tty = makeTty({ interactive: true });
    const logs = [];
    const errs = [];
    const out = await maybeConfigureBranchProtection({
      ghCli,
      tty,
      options: { autoProtect: true, skipProtection: true },
      owner: 'foo',
      repo: 'bar',
      log: (s) => logs.push(s),
      errLog: (s) => errs.push(s),
    });
    expect(out.outcome).toBe('conflict');
    expect(ghCli.calls.get).toHaveLength(0);
    expect(ghCli.calls.put).toHaveLength(0);
    expect(errs.join('\n')).toMatch(/Cannot use --auto-protect and --skip-protection/);
  });

  it('--skip-protection → outcome=skipped, no API call', async () => {
    const ghCli = fakeGhCli();
    const tty = makeTty({ interactive: true });
    const logs = [];
    const out = await maybeConfigureBranchProtection({
      ghCli,
      tty,
      options: { skipProtection: true },
      owner: 'foo',
      repo: 'bar',
      log: (s) => logs.push(s),
    });
    expect(out.outcome).toBe('skipped');
    expect(ghCli.calls.get).toHaveLength(0);
    expect(logs.join('\n')).toMatch(/Skipping branch protection per --skip-protection/);
  });

  it('TTY + user declines → outcome=skipped, no PUT', async () => {
    const ghCli = fakeGhCli();
    const tty = makeTty({ interactive: true, answer: false });
    const logs = [];
    const out = await maybeConfigureBranchProtection({
      ghCli,
      tty,
      options: {},
      owner: 'foo',
      repo: 'bar',
      log: (s) => logs.push(s),
    });
    expect(out.outcome).toBe('skipped');
    expect(out.reason).toBe('user-declined');
    expect(tty.promptYesNo).toHaveBeenCalled();
    expect(ghCli.calls.get).toHaveLength(0);
    expect(logs.join('\n')).toMatch(/Skipping branch protection per user choice/);
  });

  it('TTY + user accepts → outcome=applied', async () => {
    const ghCli = fakeGhCli({
      getResponse: { ok: true, status: 200, body: emptyProtectionBody() },
      putResponse: { ok: true, body: null, status: 200 },
    });
    const tty = makeTty({ interactive: true, answer: true });
    const out = await maybeConfigureBranchProtection({
      ghCli,
      tty,
      options: {},
      owner: 'foo',
      repo: 'bar',
    });
    expect(out.outcome).toBe('applied');
    expect(ghCli.calls.put).toHaveLength(1);
  });

  it('non-TTY without flags → auto-applies', async () => {
    const ghCli = fakeGhCli({
      getResponse: { ok: true, status: 200, body: emptyProtectionBody() },
      putResponse: { ok: true, body: null, status: 200 },
    });
    const tty = makeTty({ interactive: false });
    const logs = [];
    const out = await maybeConfigureBranchProtection({
      ghCli,
      tty,
      options: {},
      owner: 'foo',
      repo: 'bar',
      log: (s) => logs.push(s),
    });
    expect(out.outcome).toBe('applied');
    expect(tty.promptYesNo).not.toHaveBeenCalled();
    expect(logs.join('\n')).toMatch(/Non-TTY context detected/);
  });

  it('non-TTY + --auto-protect → applies without prompt', async () => {
    const ghCli = fakeGhCli({
      getResponse: { ok: true, status: 200, body: emptyProtectionBody() },
      putResponse: { ok: true, body: null, status: 200 },
    });
    const tty = makeTty({ interactive: false });
    const out = await maybeConfigureBranchProtection({
      ghCli,
      tty,
      options: { autoProtect: true },
      owner: 'foo',
      repo: 'bar',
    });
    expect(out.outcome).toBe('applied');
  });

  it('--auto-protect + 403 → outcome=forbidden, logs manualCommand', async () => {
    const ghCli = fakeGhCli({
      getResponse: { ok: true, status: 200, body: emptyProtectionBody() },
      putResponse: { ok: false, status: 403, stderr: 'HTTP 403' },
    });
    const tty = makeTty({ interactive: false });
    const errs = [];
    const out = await maybeConfigureBranchProtection({
      ghCli,
      tty,
      options: { autoProtect: true },
      owner: 'foo',
      repo: 'bar',
      errLog: (s) => errs.push(s),
    });
    expect(out.outcome).toBe('forbidden');
    expect(errs.join('\n')).toMatch(/gh api -X PUT/);
    expect(errs.join('\n')).toMatch(/codex-review-gate/);
  });

  it('prompt rejection (promptYesNo throws) → outcome=skipped, gracefully', async () => {
    const ghCli = fakeGhCli();
    const tty = {
      isInteractive: () => true,
      promptYesNo: vi.fn(async () => {
        throw new Error('stdin closed unexpectedly');
      }),
    };
    const errs = [];
    const out = await maybeConfigureBranchProtection({
      ghCli,
      tty,
      options: {},
      owner: 'foo',
      repo: 'bar',
      errLog: (s) => errs.push(s),
    });
    expect(out.outcome).toBe('skipped');
    expect(out.reason).toBe('prompt-error');
    expect(errs.join('\n')).toMatch(/failed to prompt/);
  });

  it('AC-9 (no-op idempotent path): applied check is already present', async () => {
    const ghCli = fakeGhCli({
      getResponse: { ok: true, status: 200, body: hubOsProtectionBody() },
    });
    const tty = makeTty({ interactive: false });
    const logs = [];
    const out = await maybeConfigureBranchProtection({
      ghCli,
      tty,
      options: { autoProtect: true },
      owner: 'AlfHubPlural',
      repo: 'hub-os',
      log: (s) => logs.push(s),
    });
    expect(out.outcome).toBe('noop');
    expect(ghCli.calls.put).toHaveLength(0);
  });
});
