/**
 * C2 — CWD/target is a git repo whose `origin` remote points at github.com.
 *
 * Severity: CRITICAL — every downstream check needs `{ owner, repo }` parsed
 * from this remote. If parsing fails we abort with a clear FAIL so the user
 * doesn't see a cascade of unrelated 404s from C3/C4/C5.
 *
 * @typedef {import('./_types.js').CheckResult} CheckResult
 * @typedef {import('./_types.js').CheckContext} CheckContext
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createGhCli } from '../lib/gh-cli.js';

const REMEDIATION_NOT_GIT =
  "Run 'git init' in the target directory, or pass --target=<path> pointing to a git repo.";
const REMEDIATION_NOT_GITHUB =
  "Set the origin remote to a GitHub URL: 'git remote add origin <https-or-ssh-url>' " +
  "or 'git remote set-url origin <url>'.";

/**
 * @param {CheckContext} ctx
 * @returns {Promise<CheckResult>}
 */
export default async function checkGitRepo(ctx = {}) {
  const targetDir = ctx.targetDir ?? process.cwd();
  const gh = ctx.ghCli ?? createGhCli({ execFn: ctx.execFn });

  const id = 'C2';
  const name = 'git repo + GitHub remote';
  const severity = 'CRITICAL';

  if (!existsSync(targetDir)) {
    return {
      id,
      name,
      severity,
      status: 'FAIL',
      blocking: true,
      details: `target directory does not exist: ${targetDir}`,
      remediation: REMEDIATION_NOT_GIT,
      evidence: { targetDir },
    };
  }

  if (!existsSync(join(targetDir, '.git'))) {
    return {
      id,
      name,
      severity,
      status: 'FAIL',
      blocking: true,
      details: `target is not a git repository (no .git/ at ${targetDir}).`,
      remediation: REMEDIATION_NOT_GIT,
      evidence: { targetDir },
    };
  }

  const coords = gh.getGitHubRemote(targetDir);
  if (!coords) {
    return {
      id,
      name,
      severity,
      status: 'FAIL',
      blocking: true,
      details: "git repo found but 'origin' remote is missing or not a GitHub URL.",
      remediation: REMEDIATION_NOT_GITHUB,
      evidence: { targetDir },
    };
  }

  return {
    id,
    name,
    severity,
    status: 'PASS',
    blocking: true,
    details: `origin: ${coords.remoteUrl}`,
    evidence: coords,
  };
}
