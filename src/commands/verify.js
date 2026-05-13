/**
 * `hubos-review verify` — run pre-flight checks before `install`.
 *
 * Story: CICD-002-C (AC-1 through AC-11).
 *
 * Design:
 *   - Orchestrates 8 independent check functions (`src/checks/`). Each is a
 *     pure async function `(ctx) → CheckResult`. Failures in one check do
 *     not crash the dispatcher; they surface as FAIL/WARN rows.
 *   - Exit code is severity-based (Alf 2026-05-13 D-002-13):
 *       FAIL on CRITICAL or HIGH    → exit 1
 *       FAIL/WARN on MEDIUM or LOW  → exit 0 (with WARN visible in table)
 *       WARN on CRITICAL or HIGH    → exit 0 (not blocking; surfaced amber)
 *       all PASS                    → exit 0 with "Ready to install"
 *   - Two output modes:
 *       human:    ASCII table + per-row remediation
 *       --json:   schema-stable JSON for CI/automation
 *
 * Note on concurrency:
 *   C3/C4/C5 all depend on C2 having resolved `{owner,repo}`. We therefore
 *   run C1+C2 first (sequential), then fan-out the remaining 6 checks via
 *   Promise.all. This shaves ~5 round-trips off cold-cache runs without
 *   making the dependency graph implicit.
 *
 * @typedef {import('../checks/_types.js').CheckResult} CheckResult
 */

import { createGhCli } from '../lib/gh-cli.js';

import checkGhAuth from '../checks/gh-auth.js';
import checkGitRepo from '../checks/git-repo.js';
import checkCodexApp from '../checks/codex-app.js';
import checkMainBranch from '../checks/main-branch.js';
import checkAdminAccess from '../checks/admin-access.js';
import checkNoConflict from '../checks/no-conflict.js';
import checkBundleOutdated from '../checks/bundle-outdated.js';
import checkWorkflowsOrphan from '../checks/workflows-orphan.js';

/** Order is the rendering order in the ASCII table. */
export const CHECK_ORDER = [
  'C1',
  'C2',
  'C3',
  'C4',
  'C5',
  'C5b',
  'C6',
  'C7',
];

const SUPPORTED_GATES = new Set(['codex-gate']);

/**
 * Public entry point invoked by commander. All args are optional; CLI flags
 * are pre-resolved at the dispatcher in src/cli.js. Returns an exit code
 * rather than throwing.
 *
 * @param {{
 *   json?: boolean,
 *   gate?: string,
 *   target?: string,
 *   branch?: string,
 *   bundleVersion?: string,
 *   execFn?: Function,
 *   ghCli?: any,
 * }} [opts]
 * @returns {Promise<number>}
 */
export async function verify(opts = {}) {
  const json = Boolean(opts.json);
  const gateName = opts.gate ?? 'codex-gate';
  const targetDir = opts.target ?? process.cwd();
  const branch = opts.branch ?? 'main';
  const bundleVersion = opts.bundleVersion ?? 'v1';

  // AC-5 — `--gate` is extensible but MVP only accepts `codex-gate`.
  if (!SUPPORTED_GATES.has(gateName)) {
    const msg = `Only 'codex-gate' is supported in this version (received '${gateName}').`;
    if (json) {
      console.log(
        JSON.stringify(
          {
            repo: null,
            overall: 'FAIL',
            exitCode: 1,
            error: msg,
          },
          null,
          2,
        ),
      );
    } else {
      console.error(`hubos-review verify: ${msg}`);
    }
    return 1;
  }

  const ghCli =
    opts.ghCli ?? createGhCli({ execFn: opts.execFn });

  // ── Phase 1: sequential prerequisites (C1, C2) ───────────────────────
  // C1 must run first so C3/C4/C5 surface a clean "you're not logged in"
  // message instead of cascade 404s. C2 produces `repoCoords` consumed by
  // C3/C4/C5; without it, those checks short-circuit with a clean message.
  const ctxBase = {
    targetDir,
    gateName,
    bundleVersion,
    branch,
    ghCli,
  };

  const c1 = await checkGhAuth(ctxBase);
  const c2 = await checkGitRepo(ctxBase);
  const repoCoords =
    c2.status === 'PASS' && c2.evidence ? c2.evidence : null;

  const ctxFull = { ...ctxBase, repoCoords };

  // ── Phase 2: independent checks (C3, C4, C5, C5b, C6, C7) ────────────
  const [c3, c4, c5, c5b, c6, c7] = await Promise.all([
    checkCodexApp(ctxFull),
    checkMainBranch(ctxFull),
    checkAdminAccess(ctxFull),
    checkNoConflict(ctxFull),
    checkBundleOutdated(ctxFull),
    checkWorkflowsOrphan(ctxFull),
  ]);

  /** @type {CheckResult[]} */
  const results = [c1, c2, c3, c4, c5, c5b, c6, c7];

  // ── Decide exit code (AC-1) ──────────────────────────────────────────
  // Only FAIL on CRITICAL/HIGH flips to exit 1. WARN never blocks (even on
  // CRITICAL severity — codex-app intentionally degrades to WARN on
  // "no signal yet" without forcing a manual override).
  const blockingFailures = results.filter(
    (r) =>
      r.status === 'FAIL' &&
      (r.severity === 'CRITICAL' || r.severity === 'HIGH'),
  );
  const exitCode = blockingFailures.length > 0 ? 1 : 0;
  const overall =
    blockingFailures.length > 0
      ? 'FAIL'
      : results.some((r) => r.status === 'WARN')
        ? 'WARN'
        : 'PASS';

  const repoLabel = repoCoords ? `${repoCoords.owner}/${repoCoords.repo}` : null;

  if (json) {
    renderJson({ repoLabel, results, overall, exitCode });
  } else {
    renderHuman({ repoLabel, results, overall, exitCode, gateName, blockingFailures });
  }

  return exitCode;
}

/**
 * Emit a JSON payload to stdout. Schema is stable for CI consumers.
 *
 * @param {{ repoLabel: string|null, results: CheckResult[], overall: string, exitCode: number }} arg
 */
function renderJson({ repoLabel, results, overall, exitCode }) {
  const payload = {
    repo: repoLabel,
    overall,
    exitCode,
    checks: results.map((r) => ({
      id: r.id,
      name: r.name,
      severity: r.severity,
      status: r.status,
      blocking: r.blocking,
      details: r.details,
      ...(r.remediation ? { remediation: r.remediation } : {}),
      ...(r.evidence ? { evidence: r.evidence } : {}),
    })),
  };
  console.log(JSON.stringify(payload, null, 2));
}

/**
 * Emit a human-friendly ASCII table + remediation footer.
 *
 * @param {{
 *   repoLabel: string|null,
 *   results: CheckResult[],
 *   overall: string,
 *   exitCode: number,
 *   gateName: string,
 *   blockingFailures: CheckResult[],
 * }} arg
 */
function renderHuman({
  repoLabel,
  results,
  overall,
  exitCode,
  gateName,
  blockingFailures,
}) {
  console.log(`hubos-review verify — pre-flight check for ${gateName}`);
  console.log(`Repo: ${repoLabel ?? '<unresolved>'}`);
  console.log('');

  // Column widths picked once so renderer stays simple. Sized to fit the
  // longest known value plus a two-space gutter:
  //   CHECK ID  → 'C5b' (3) + gutter → 4
  //   CHECK     → most names <=30; reserve 32
  //   SEV       → 'CRITICAL' (8) + gutter → 10
  //   STATUS    → 'PASS'/'FAIL'/'WARN' (4) + gutter → 8
  const widths = { id: 4, check: 32, sev: 10, status: 8 };
  const header =
    pad('CHECK ID', widths.id) +
    '  ' +
    pad('CHECK', widths.check) +
    pad('SEV', widths.sev) +
    pad('STATUS', widths.status) +
    'DETAILS';
  console.log(header);
  console.log('-'.repeat(Math.max(header.length, 80)));

  for (const r of results) {
    const idCol = pad(r.id, widths.id);
    const checkCol = pad(truncate(r.name, widths.check - 1), widths.check);
    const sevCol = pad(r.severity, widths.sev);
    const statusCol = pad(statusLabel(r), widths.status);
    console.log(`${idCol}  ${checkCol}${sevCol}${statusCol}${r.details}`);
  }
  console.log('');

  // Footer: overall verdict + actionable hints.
  if (exitCode === 0 && overall === 'PASS') {
    console.log(
      `Result: PASS — ready to run 'hubos-review install ${gateName}'.`,
    );
  } else if (exitCode === 0 && overall === 'WARN') {
    const warns = results.filter((r) => r.status === 'WARN');
    console.log(
      `Result: PASS with ${warns.length} warning(s) — install can proceed.`,
    );
    for (const w of warns) {
      console.log(`  - ${w.id} (${w.severity}): ${w.details}`);
      if (w.remediation) {
        console.log(indent(`Remediation: ${w.remediation}`));
      }
    }
  } else {
    console.log(
      `Result: FAIL — ${blockingFailures.length} blocking issue(s). Resolve before running install.`,
    );
    for (const f of blockingFailures) {
      console.log(`  - ${f.id} (${f.severity}): ${f.details}`);
      if (f.remediation) {
        console.log(indent(`Remediation: ${f.remediation}`));
      }
    }
    // Also surface CRITICAL/HIGH WARNs (codex-app no-signal case).
    const heavyWarns = results.filter(
      (r) =>
        r.status === 'WARN' &&
        (r.severity === 'CRITICAL' || r.severity === 'HIGH'),
    );
    for (const w of heavyWarns) {
      console.log(`  - ${w.id} (${w.severity}, WARN): ${w.details}`);
      if (w.remediation) {
        console.log(indent(`Remediation: ${w.remediation}`));
      }
    }
  }
}

function statusLabel(r) {
  if (r.status === 'PASS') return 'PASS';
  if (r.status === 'FAIL') return 'FAIL';
  return 'WARN';
}

function pad(s, n) {
  const str = String(s ?? '');
  if (str.length >= n) return str;
  return str + ' '.repeat(n - str.length);
}

function truncate(s, n) {
  const str = String(s ?? '');
  if (str.length <= n) return str;
  return str.slice(0, Math.max(0, n - 1)) + '…';
}

function indent(text, prefix = '      ') {
  return text
    .split('\n')
    .map((line) => prefix + line)
    .join('\n');
}
