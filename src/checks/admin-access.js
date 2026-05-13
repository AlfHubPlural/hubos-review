/**
 * C5 — current `gh`-authenticated user has admin permission on the target repo.
 *
 * Severity: HIGH (promoted from MEDIUM by Alf 2026-05-13). Without admin, the
 * branch-protection step of Story D will fail silently mid-install, leaving
 * the user with a half-configured gate. Catching this in pre-flight makes
 * the failure mode obvious.
 *
 * Detection: `GET /repos/{owner}/{repo}` returns a `permissions` object for
 * the authenticated user — `permissions.admin === true` is the canonical
 * signal. Tested 2026-05-13 against AlfHubPlural/hubos-review → admin=true.
 *
 * @typedef {import('./_types.js').CheckResult} CheckResult
 * @typedef {import('./_types.js').CheckContext} CheckContext
 */

import { createGhCli } from '../lib/gh-cli.js';

const REMEDIATION =
  "Ask a repo owner to grant admin permission, or run 'hubos-review install' " +
  'with --skip-protection to install the artifacts without configuring branch ' +
  'protection (Story D feature — coming).';

/**
 * @param {CheckContext} ctx
 * @returns {Promise<CheckResult>}
 */
export default async function checkAdminAccess(ctx = {}) {
  const id = 'C5';
  const name = 'admin access';
  const severity = 'HIGH';

  const coords = ctx.repoCoords;
  if (!coords) {
    return {
      id,
      name,
      severity,
      status: 'FAIL',
      blocking: true,
      details: 'cannot check admin without a GitHub repo (C2 must pass first).',
      remediation:
        "Resolve C2 (git repo + GitHub remote) first; then re-run verify.",
      evidence: { reason: 'no-repo-coords' },
    };
  }

  const gh = ctx.ghCli ?? createGhCli({ execFn: ctx.execFn });
  const res = gh.ghApi(`/repos/${coords.owner}/${coords.repo}`);
  if (!res.ok || !res.json) {
    return {
      id,
      name,
      severity,
      status: 'FAIL',
      blocking: true,
      details:
        `unable to fetch repo metadata for ${coords.owner}/${coords.repo} — ` +
        'cannot confirm admin permission.',
      remediation: REMEDIATION,
      evidence: { stderr: res.stderr, exitCode: res.exitCode },
    };
  }

  const perms = res.json.permissions || {};
  if (perms.admin === true) {
    return {
      id,
      name,
      severity,
      status: 'PASS',
      blocking: true,
      details: `user has admin permission on ${coords.owner}/${coords.repo}.`,
      evidence: { permissions: perms },
    };
  }

  return {
    id,
    name,
    severity,
    status: 'FAIL',
    blocking: true,
    details:
      `user does not have admin permission on ${coords.owner}/${coords.repo} ` +
      '(branch protection will fail at install time).',
    remediation: REMEDIATION,
    evidence: { permissions: perms },
  };
}
