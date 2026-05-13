/**
 * Unit tests for `src/checks/admin-access.js` (C5).
 */

import { describe, it, expect } from 'vitest';
import checkAdminAccess from '../../src/checks/admin-access.js';

const COORDS = { owner: 'AlfHubPlural', repo: 'hubos-review', remoteUrl: '' };

function mockGhCli(repoResult) {
  return {
    ghApi(endpoint) {
      if (endpoint.startsWith(`/repos/${COORDS.owner}/${COORDS.repo}`)) {
        return repoResult;
      }
      return { ok: false, stderr: 'unexpected', exitCode: 1 };
    },
  };
}

describe('checkAdminAccess (C5)', () => {
  it('FAIL when no repoCoords', async () => {
    const r = await checkAdminAccess({ repoCoords: null });
    expect(r.id).toBe('C5');
    expect(r.severity).toBe('HIGH');
    expect(r.status).toBe('FAIL');
  });

  it('PASS when permissions.admin === true', async () => {
    const r = await checkAdminAccess({
      ghCli: mockGhCli({
        ok: true,
        json: { permissions: { admin: true, maintain: true } },
      }),
      repoCoords: COORDS,
    });
    expect(r.status).toBe('PASS');
    expect(r.blocking).toBe(true);
  });

  it('FAIL when permissions.admin === false', async () => {
    const r = await checkAdminAccess({
      ghCli: mockGhCli({
        ok: true,
        json: { permissions: { admin: false, push: true } },
      }),
      repoCoords: COORDS,
    });
    expect(r.status).toBe('FAIL');
    expect(r.remediation).toMatch(/--skip-protection/);
  });

  it('FAIL when permissions field missing', async () => {
    const r = await checkAdminAccess({
      ghCli: mockGhCli({ ok: true, json: { full_name: 'Owner/Repo' } }),
      repoCoords: COORDS,
    });
    expect(r.status).toBe('FAIL');
  });

  it('FAIL when API call fails', async () => {
    const r = await checkAdminAccess({
      ghCli: mockGhCli({ ok: false, stderr: 'HTTP 404', exitCode: 1 }),
      repoCoords: COORDS,
    });
    expect(r.status).toBe('FAIL');
    expect(r.details).toMatch(/unable to fetch/);
  });
});
