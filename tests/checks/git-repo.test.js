/**
 * Unit tests for `src/checks/git-repo.js` (C2).
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import checkGitRepo from '../../src/checks/git-repo.js';

/** @type {string[]} */
const dirs = [];

function tmpDir({ asGitRepo = false } = {}) {
  const d = mkdtempSync(join(tmpdir(), 'hubos-review-git-repo-test-'));
  dirs.push(d);
  if (asGitRepo) mkdirSync(join(d, '.git'), { recursive: true });
  return d;
}

function mockRemoteExec(remoteUrl) {
  return (bin, args) => {
    if (bin === 'git' && args[0] === 'remote') {
      if (remoteUrl == null) {
        return { ok: false, stdout: '', stderr: 'no remote', exitCode: 1 };
      }
      return { ok: true, stdout: remoteUrl + '\n', stderr: '', exitCode: 0 };
    }
    return { ok: true, stdout: '', stderr: '', exitCode: 0 };
  };
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

describe('checkGitRepo (C2)', () => {
  it('FAIL when target directory does not exist', async () => {
    const r = await checkGitRepo({
      targetDir: '/definitely-not-a-path/' + Math.random().toString(36).slice(2),
      execFn: () => ({ ok: false, stdout: '', stderr: '', exitCode: 1 }),
    });
    expect(r.id).toBe('C2');
    expect(r.severity).toBe('CRITICAL');
    expect(r.status).toBe('FAIL');
    expect(r.details).toMatch(/does not exist/);
  });

  it('FAIL when target is not a git repo (no .git)', async () => {
    const dir = tmpDir({ asGitRepo: false });
    const r = await checkGitRepo({
      targetDir: dir,
      execFn: () => ({ ok: false, stdout: '', stderr: '', exitCode: 1 }),
    });
    expect(r.status).toBe('FAIL');
    expect(r.details).toMatch(/not a git repository/);
    expect(r.remediation).toMatch(/git init/);
  });

  it('FAIL when origin is missing', async () => {
    const dir = tmpDir({ asGitRepo: true });
    const r = await checkGitRepo({
      targetDir: dir,
      execFn: mockRemoteExec(null),
    });
    expect(r.status).toBe('FAIL');
    expect(r.details).toMatch(/origin.*missing|not a GitHub URL/i);
  });

  it('FAIL when origin is not a GitHub URL', async () => {
    const dir = tmpDir({ asGitRepo: true });
    const r = await checkGitRepo({
      targetDir: dir,
      execFn: mockRemoteExec('git@gitlab.com:Owner/Repo.git'),
    });
    expect(r.status).toBe('FAIL');
  });

  it('PASS for SSH GitHub remote', async () => {
    const dir = tmpDir({ asGitRepo: true });
    const r = await checkGitRepo({
      targetDir: dir,
      execFn: mockRemoteExec('git@github.com:AlfHubPlural/hubos-review.git'),
    });
    expect(r.status).toBe('PASS');
    expect(r.evidence.owner).toBe('AlfHubPlural');
    expect(r.evidence.repo).toBe('hubos-review');
  });

  it('PASS for HTTPS GitHub remote', async () => {
    const dir = tmpDir({ asGitRepo: true });
    const r = await checkGitRepo({
      targetDir: dir,
      execFn: mockRemoteExec('https://github.com/Owner/Repo.git'),
    });
    expect(r.status).toBe('PASS');
    expect(r.evidence.owner).toBe('Owner');
    expect(r.evidence.repo).toBe('Repo');
  });

  it('PASS for HTTPS GitHub remote without .git suffix', async () => {
    const dir = tmpDir({ asGitRepo: true });
    const r = await checkGitRepo({
      targetDir: dir,
      execFn: mockRemoteExec('https://github.com/Owner/Repo'),
    });
    expect(r.status).toBe('PASS');
    expect(r.evidence.repo).toBe('Repo');
  });
});
