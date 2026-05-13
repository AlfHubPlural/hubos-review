/**
 * Unit tests for `src/lib/gh-cli.js`.
 *
 * Covers the createGhCli wrapper + the parseGitHubRemote helper.
 * The defaultExec function shells out to the real `gh`/`git`; we do not
 * exercise it here — every consumer mocks via `execFn`.
 */

import { describe, it, expect } from 'vitest';
import { createGhCli, parseGitHubRemote } from '../src/lib/gh-cli.js';

describe('parseGitHubRemote', () => {
  it('parses SSH shorthand', () => {
    expect(parseGitHubRemote('git@github.com:Owner/Repo.git')).toEqual({
      owner: 'Owner',
      repo: 'Repo',
      remoteUrl: 'git@github.com:Owner/Repo.git',
    });
  });

  it('parses HTTPS with .git suffix', () => {
    expect(parseGitHubRemote('https://github.com/Owner/Repo.git')).toEqual({
      owner: 'Owner',
      repo: 'Repo',
      remoteUrl: 'https://github.com/Owner/Repo.git',
    });
  });

  it('parses HTTPS without .git suffix', () => {
    expect(parseGitHubRemote('https://github.com/Owner/Repo')).toEqual({
      owner: 'Owner',
      repo: 'Repo',
      remoteUrl: 'https://github.com/Owner/Repo',
    });
  });

  it('parses ssh:// long form', () => {
    expect(parseGitHubRemote('ssh://git@github.com/Owner/Repo.git')).toEqual({
      owner: 'Owner',
      repo: 'Repo',
      remoteUrl: 'ssh://git@github.com/Owner/Repo.git',
    });
  });

  it('returns null for non-GitHub URLs', () => {
    expect(parseGitHubRemote('git@gitlab.com:Owner/Repo.git')).toBe(null);
  });

  it('returns null for malformed input', () => {
    expect(parseGitHubRemote('')).toBe(null);
    expect(parseGitHubRemote(null)).toBe(null);
    expect(parseGitHubRemote(undefined)).toBe(null);
    expect(parseGitHubRemote('not a url')).toBe(null);
  });

  it('strips trailing slash', () => {
    expect(parseGitHubRemote('https://github.com/Owner/Repo/')).toEqual({
      owner: 'Owner',
      repo: 'Repo',
      remoteUrl: 'https://github.com/Owner/Repo/',
    });
  });
});

describe('createGhCli', () => {
  it('ghApi parses JSON success body', () => {
    const exec = (_bin, args) => {
      expect(args[0]).toBe('api');
      return {
        ok: true,
        stdout: JSON.stringify({ permissions: { admin: true } }),
        stderr: '',
        exitCode: 0,
      };
    };
    const gh = createGhCli({ execFn: exec });
    const res = gh.ghApi('/repos/owner/repo');
    expect(res.ok).toBe(true);
    expect(res.json.permissions.admin).toBe(true);
  });

  it('ghApi returns { ok: false } on non-zero exit', () => {
    const exec = () => ({
      ok: false,
      stdout: '',
      stderr: 'HTTP 404',
      exitCode: 1,
    });
    const gh = createGhCli({ execFn: exec });
    const res = gh.ghApi('/repos/owner/missing');
    expect(res.ok).toBe(false);
    expect(res.stderr).toBe('HTTP 404');
  });

  it('ghApi handles empty stdout (no JSON)', () => {
    const exec = () => ({ ok: true, stdout: '', stderr: '', exitCode: 0 });
    const gh = createGhCli({ execFn: exec });
    const res = gh.ghApi('/some/endpoint');
    expect(res.ok).toBe(true);
    expect(res.json).toBe(null);
  });

  it('ghApi handles non-JSON stdout gracefully', () => {
    const exec = () => ({
      ok: true,
      stdout: 'plain text response',
      stderr: '',
      exitCode: 0,
    });
    const gh = createGhCli({ execFn: exec });
    const res = gh.ghApi('/some/endpoint');
    expect(res.ok).toBe(true);
    expect(res.json).toBe(null);
    expect(res.raw).toBe('plain text response');
  });

  it('ghAuthStatus collapses stdout + stderr into single text blob', () => {
    const exec = () => ({
      ok: true,
      stdout: '',
      stderr: 'Logged in to github.com\nToken scopes: repo, read:org',
      exitCode: 0,
    });
    const gh = createGhCli({ execFn: exec });
    const res = gh.ghAuthStatus();
    expect(res.ok).toBe(true);
    expect(res.text).toMatch(/Token scopes/);
  });

  it('getGitHubRemote returns null on git failure', () => {
    const exec = () => ({ ok: false, stdout: '', stderr: '', exitCode: 1 });
    const gh = createGhCli({ execFn: exec });
    expect(gh.getGitHubRemote('/tmp')).toBe(null);
  });

  it('getGitHubRemote parses successful output', () => {
    const exec = (_bin, args) => {
      expect(args).toEqual(['remote', 'get-url', 'origin']);
      return {
        ok: true,
        stdout: 'git@github.com:Owner/Repo.git\n',
        stderr: '',
        exitCode: 0,
      };
    };
    const gh = createGhCli({ execFn: exec });
    const r = gh.getGitHubRemote('/tmp');
    expect(r.owner).toBe('Owner');
    expect(r.repo).toBe('Repo');
  });
});
