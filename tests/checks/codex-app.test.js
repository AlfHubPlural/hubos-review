/**
 * Unit tests for `src/checks/codex-app.js` (C3).
 *
 * Strategy: mock the gh-cli `ghApi` calls. Each test crafts the response a
 * specific endpoint returns so we can exercise PASS / FAIL / WARN paths
 * without ever hitting the network.
 */

import { describe, it, expect } from 'vitest';
import checkCodexApp, {
  CODEX_BOT_LOGIN,
  CODEX_APP_SLUG,
  INSTALL_URL,
} from '../../src/checks/codex-app.js';

/**
 * Build a ghCli mock whose `ghApi(endpoint)` returns the supplied responses.
 *
 * @param {{
 *   reviewComments?: any[]|null,
 *   issueComments?: any[]|null,
 *   reviewFail?: boolean,
 *   issueFail?: boolean,
 * }} cfg
 */
function mockGhCli(cfg = {}) {
  return {
    ghApi(endpoint) {
      if (endpoint.includes('/pulls/comments')) {
        if (cfg.reviewFail) {
          return { ok: false, stderr: 'HTTP 404', exitCode: 1 };
        }
        return {
          ok: true,
          json: cfg.reviewComments ?? [],
          raw: JSON.stringify(cfg.reviewComments ?? []),
        };
      }
      if (endpoint.includes('/issues/comments')) {
        if (cfg.issueFail) {
          return { ok: false, stderr: 'HTTP 404', exitCode: 1 };
        }
        return {
          ok: true,
          json: cfg.issueComments ?? [],
          raw: JSON.stringify(cfg.issueComments ?? []),
        };
      }
      return { ok: false, stderr: 'unexpected', exitCode: 1 };
    },
    gh: () => ({ ok: false, stdout: '', stderr: '', exitCode: 1 }),
    ghAuthStatus: () => ({ ok: false, text: '', exitCode: 1 }),
    getGitHubRemote: () => null,
  };
}

const COORDS = { owner: 'AlfHubPlural', repo: 'hubos-review', remoteUrl: '' };

describe('checkCodexApp (C3)', () => {
  it('FAIL when no repoCoords (C2 must pass first)', async () => {
    const r = await checkCodexApp({
      ghCli: mockGhCli({}),
      repoCoords: null,
    });
    expect(r.id).toBe('C3');
    expect(r.severity).toBe('CRITICAL');
    expect(r.status).toBe('FAIL');
    expect(r.evidence.reason).toBe('no-repo-coords');
  });

  it('PASS when bot login appears in /pulls/comments', async () => {
    const r = await checkCodexApp({
      ghCli: mockGhCli({
        reviewComments: [
          { user: { login: CODEX_BOT_LOGIN }, body: 'P1 Badge: bug' },
          { user: { login: 'somebody-else' }, body: 'lgtm' },
        ],
      }),
      repoCoords: COORDS,
    });
    expect(r.status).toBe('PASS');
    expect(r.blocking).toBe(true);
    expect(r.evidence.source).toBe('pulls/comments');
    expect(r.evidence.sampleCount).toBe(1);
  });

  it('PASS via /issues/comments fallback when /pulls/comments has no bot', async () => {
    const r = await checkCodexApp({
      ghCli: mockGhCli({
        reviewComments: [{ user: { login: 'someone' } }],
        issueComments: [
          { user: { login: CODEX_BOT_LOGIN }, body: 'review summary' },
        ],
      }),
      repoCoords: COORDS,
    });
    expect(r.status).toBe('PASS');
    expect(r.evidence.source).toBe('issues/comments');
  });

  it('WARN when no signal found but both endpoints succeeded', async () => {
    const r = await checkCodexApp({
      ghCli: mockGhCli({
        reviewComments: [{ user: { login: 'human' } }],
        issueComments: [{ user: { login: 'vercel[bot]' } }],
      }),
      repoCoords: COORDS,
    });
    expect(r.status).toBe('WARN');
    expect(r.blocking).toBe(false);
    expect(r.remediation).toContain(INSTALL_URL);
    expect(r.remediation).toContain('AlfHubPlural/hubos-review');
  });

  it('FAIL when both endpoints error out (likely permission issue)', async () => {
    const r = await checkCodexApp({
      ghCli: mockGhCli({ reviewFail: true, issueFail: true }),
      repoCoords: COORDS,
    });
    expect(r.status).toBe('FAIL');
    expect(r.blocking).toBe(true);
    expect(r.details).toMatch(/unable to query/i);
  });

  it('exposes the install URL constant for remediation messages', () => {
    expect(INSTALL_URL).toMatch(/^https:\/\/github\.com\/apps\/chatgpt-codex-connector/);
    expect(CODEX_APP_SLUG).toBe('chatgpt-codex-connector');
    expect(CODEX_BOT_LOGIN).toBe('chatgpt-codex-connector[bot]');
  });
});
