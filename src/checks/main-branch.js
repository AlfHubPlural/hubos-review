/**
 * C4 — Protected branch (default `main`) exists on the GitHub remote.
 *
 * Severity: HIGH — Story D's branch protection step needs the branch to exist
 * before it can attach required-status-checks to it. We surface this in
 * pre-flight so the user does not get a confusing 404 mid-install.
 *
 * @typedef {import('./_types.js').CheckResult} CheckResult
 * @typedef {import('./_types.js').CheckContext} CheckContext
 */

import { createGhCli } from '../lib/gh-cli.js';

/**
 * @param {CheckContext} ctx
 * @returns {Promise<CheckResult>}
 */
export default async function checkMainBranch(ctx = {}) {
  const id = 'C4';
  const branch = ctx.branch ?? 'main';
  const name = `branch '${branch}' exists`;
  const severity = 'HIGH';

  const coords = ctx.repoCoords;
  if (!coords) {
    return {
      id,
      name,
      severity,
      status: 'FAIL',
      blocking: true,
      details: 'cannot check branch without a GitHub repo (C2 must pass first).',
      remediation:
        "Resolve C2 (git repo + GitHub remote) first; then verify the protected branch.",
      evidence: { reason: 'no-repo-coords' },
    };
  }

  const gh = ctx.ghCli ?? createGhCli({ execFn: ctx.execFn });
  const res = gh.ghApi(`/repos/${coords.owner}/${coords.repo}/branches/${branch}`);
  if (!res.ok) {
    return {
      id,
      name,
      severity,
      status: 'FAIL',
      blocking: true,
      details:
        `branch '${branch}' not found on ${coords.owner}/${coords.repo} ` +
        '(or you lack repo:read scope).',
      remediation:
        `Confirm the default branch with 'gh repo view ${coords.owner}/${coords.repo} --json defaultBranchRef'. ` +
        `If the default is not '${branch}', re-run with '--branch <name>'.`,
      evidence: { stderr: res.stderr, exitCode: res.exitCode },
    };
  }

  return {
    id,
    name,
    severity,
    status: 'PASS',
    blocking: true,
    details: `branch '${branch}' present on ${coords.owner}/${coords.repo}.`,
    evidence: { branch, repo: `${coords.owner}/${coords.repo}` },
  };
}
