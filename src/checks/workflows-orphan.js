/**
 * C7 — informational scan of `.github/workflows/` for non-codex-gate files.
 *
 * Severity: LOW — purely informative, never alters exit code. Helps the
 * operator understand which other CI surfaces share the repo (e.g. `ci.yml`,
 * `release.yml`, `gitleaks.yml`) so they know what to expect after install.
 *
 * @typedef {import('./_types.js').CheckResult} CheckResult
 * @typedef {import('./_types.js').CheckContext} CheckContext
 */

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const CODEX_FILE = 'codex-gate.yml';

/**
 * @param {CheckContext} ctx
 * @returns {Promise<CheckResult>}
 */
export default async function checkWorkflowsOrphan(ctx = {}) {
  const id = 'C7';
  const name = 'workflows orphan';
  const severity = 'LOW';
  const targetDir = ctx.targetDir ?? process.cwd();
  const wfDir = join(targetDir, '.github', 'workflows');

  if (!existsSync(wfDir)) {
    return {
      id,
      name,
      severity,
      status: 'PASS',
      blocking: false,
      details: 'no .github/workflows/ directory (fresh repo).',
      evidence: { wfDir, present: false },
    };
  }

  let files;
  try {
    files = readdirSync(wfDir, { withFileTypes: true })
      .filter((d) => d.isFile() && /\.(ya?ml)$/i.test(d.name))
      .map((d) => d.name);
  } catch (err) {
    return {
      id,
      name,
      severity,
      status: 'WARN',
      blocking: false,
      details: `unable to read .github/workflows/: ${err.message}`,
      evidence: { wfDir, error: err.message },
    };
  }

  const others = files.filter((f) => f !== CODEX_FILE).sort();
  if (others.length === 0) {
    return {
      id,
      name,
      severity,
      status: 'PASS',
      blocking: false,
      details: 'no other workflows present.',
      evidence: { wfDir, files },
    };
  }

  return {
    id,
    name,
    severity,
    status: 'WARN',
    blocking: false,
    details: `${others.length} other workflow(s) present: ${others.join(', ')} (unrelated, ignorable).`,
    evidence: { wfDir, otherWorkflows: others },
  };
}
