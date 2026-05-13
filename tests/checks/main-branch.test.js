/**
 * Unit tests for `src/checks/main-branch.js` (C4).
 */

import { describe, it, expect } from 'vitest';
import checkMainBranch from '../../src/checks/main-branch.js';

const COORDS = { owner: 'AlfHubPlural', repo: 'hubos-review', remoteUrl: '' };

function mockGhCli({ found = true } = {}) {
  return {
    ghApi(endpoint) {
      if (endpoint.includes('/branches/')) {
        if (!found) {
          return { ok: false, stderr: 'HTTP 404 Not Found', exitCode: 1 };
        }
        return { ok: true, json: { name: 'main', protected: false } };
      }
      return { ok: false, stderr: 'unexpected', exitCode: 1 };
    },
    gh: () => ({ ok: false, stdout: '', stderr: '', exitCode: 1 }),
    ghAuthStatus: () => ({ ok: false, text: '', exitCode: 1 }),
    getGitHubRemote: () => null,
  };
}

describe('checkMainBranch (C4)', () => {
  it('FAIL when no repoCoords', async () => {
    const r = await checkMainBranch({ repoCoords: null });
    expect(r.id).toBe('C4');
    expect(r.severity).toBe('HIGH');
    expect(r.status).toBe('FAIL');
    expect(r.blocking).toBe(true);
  });

  it('PASS when branch main exists', async () => {
    const r = await checkMainBranch({
      ghCli: mockGhCli({ found: true }),
      repoCoords: COORDS,
    });
    expect(r.status).toBe('PASS');
    expect(r.details).toMatch(/main.*present/);
  });

  it('FAIL when branch main 404s', async () => {
    const r = await checkMainBranch({
      ghCli: mockGhCli({ found: false }),
      repoCoords: COORDS,
    });
    expect(r.status).toBe('FAIL');
    expect(r.remediation).toMatch(/defaultBranchRef/);
  });

  it('uses ctx.branch override when supplied', async () => {
    const ghCli = {
      ghApi(endpoint) {
        if (endpoint.endsWith('/branches/develop')) {
          return { ok: true, json: { name: 'develop', protected: false } };
        }
        return { ok: false, stderr: 'HTTP 404', exitCode: 1 };
      },
    };
    const r = await checkMainBranch({
      ghCli,
      repoCoords: COORDS,
      branch: 'develop',
    });
    expect(r.status).toBe('PASS');
    expect(r.name).toMatch(/develop/);
  });
});
