/**
 * Unit tests for `src/checks/gh-auth.js` (C1).
 *
 * Strategy: inject `execFn` so the test fully controls what `gh auth status`
 * appears to return. No subprocess, no network. We do not mock `createGhCli`
 * directly — we let the check call it with our `execFn` and exercise the
 * real wrapper alongside, which doubles as a smoke test for gh-cli.js.
 */

import { describe, it, expect } from 'vitest';
import checkGhAuth, { parseScopes, parseAccount } from '../../src/checks/gh-auth.js';

/**
 * Build a tiny exec mock that returns the specified result for `gh auth
 * status` and a generic empty-ok response for anything else.
 *
 * @param {{ ok?: boolean, stdout?: string, stderr?: string, exitCode?: number }} authResult
 */
function mockExec(authResult) {
  return (_bin, args) => {
    if (args[0] === 'auth' && args[1] === 'status') {
      return {
        ok: authResult.ok ?? true,
        stdout: authResult.stdout ?? '',
        stderr: authResult.stderr ?? '',
        exitCode: authResult.exitCode ?? (authResult.ok === false ? 1 : 0),
      };
    }
    return { ok: true, stdout: '', stderr: '', exitCode: 0 };
  };
}

describe('checkGhAuth (C1)', () => {
  it('PASS when authenticated with both required scopes', async () => {
    const r = await checkGhAuth({
      execFn: mockExec({
        ok: true,
        stderr:
          '✓ Logged in to github.com account AlfHubPlural (keyring)\n' +
          "  - Active account: true\n" +
          "  - Token scopes: 'admin:public_key', 'gist', 'read:org', 'repo'\n",
      }),
    });
    expect(r.id).toBe('C1');
    expect(r.severity).toBe('CRITICAL');
    expect(r.status).toBe('PASS');
    expect(r.blocking).toBe(true);
    expect(r.details).toContain('authenticated as AlfHubPlural');
    expect(r.details).toContain('read:org');
    expect(r.details).toContain('repo');
  });

  it('FAIL when not authenticated', async () => {
    const r = await checkGhAuth({
      execFn: mockExec({ ok: false, stderr: 'You are not logged in' }),
    });
    expect(r.status).toBe('FAIL');
    expect(r.severity).toBe('CRITICAL');
    expect(r.blocking).toBe(true);
    expect(r.remediation).toMatch(/gh auth login/);
  });

  it('FAIL when scopes are missing repo', async () => {
    const r = await checkGhAuth({
      execFn: mockExec({
        ok: true,
        stderr: "Token scopes: 'gist', 'read:org'\n",
      }),
    });
    expect(r.status).toBe('FAIL');
    expect(r.details).toMatch(/missing required scopes/);
    expect(r.details).toMatch(/repo/);
    expect(r.evidence.missing).toContain('repo');
  });

  it('FAIL when scopes are missing read:org', async () => {
    const r = await checkGhAuth({
      execFn: mockExec({
        ok: true,
        stderr: "Token scopes: 'repo', 'gist'\n",
      }),
    });
    expect(r.status).toBe('FAIL');
    expect(r.evidence.missing).toContain('read:org');
    expect(r.evidence.missing).not.toContain('repo');
  });

  it('handles unquoted scope list (older gh versions)', async () => {
    const r = await checkGhAuth({
      execFn: mockExec({
        ok: true,
        stderr: 'Token scopes: repo, read:org, gist\n',
      }),
    });
    expect(r.status).toBe('PASS');
  });

  it('parseScopes returns empty Set when no Token scopes line present', () => {
    const scopes = parseScopes('Logged in to github.com\n');
    expect([...scopes]).toEqual([]);
  });

  it('parseAccount extracts login from account-style output', () => {
    expect(parseAccount('Logged in to github.com account AlfHubPlural (keyring)')).toBe(
      'AlfHubPlural',
    );
  });

  it('parseAccount extracts login from "as" style (older gh)', () => {
    expect(parseAccount('Logged in to github.com as someone (...)')).toBe('someone');
  });

  it('parseAccount returns null when no login present', () => {
    expect(parseAccount('')).toBe(null);
    expect(parseAccount('no login here')).toBe(null);
  });
});
