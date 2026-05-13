/**
 * `hubos-review status` — audit installed gate state.
 *
 * Story: CICD-002-E (AC-1 through AC-6).
 *
 * Reads `.aiox/cicd-version` in the target repo, compares each installed
 * file's on-disk SHA-256 with the hash recorded at install time, queries
 * the npm registry for newer CLI versions, and probes branch protection
 * via `gh api`. Output is either a human-readable ASCII table (default)
 * or a stable JSON payload (`--json`) for CI consumers.
 *
 * Exit codes:
 *   0  — gate installed and healthy (MATCH on every file) OR offline
 *   1  — `.aiox/cicd-version` is missing OR critical hash mismatch (file
 *        recorded in lock but missing from disk)
 *   2  — USAGE error (target doesn't exist, etc.)
 *
 * Design:
 *   - All external dependencies (npm view, gh api, fs) are routed through
 *     injectable factory params for tests. The production defaults wire up
 *     to real npm + gh.
 *   - "Critical" mismatch: a file MISSING from disk. A merely "MODIFIED"
 *     file is a warning, not an error — the user might have legitimately
 *     edited the workflow. The README documents this contract.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { loadBundleManifest } from '../lib/bundle.js';
import { createRegistryClient, compareVersions } from '../lib/registry.js';
import { diffInstalledVsBundle, shortSha } from '../lib/diff.js';
import {
  createDefaultGhCli,
  detectOwnerRepo,
  DEFAULT_CHECK_NAME,
} from '../lib/branch-protection.js';

/**
 * Exit codes — mirrored from install.js to keep the CLI matrix coherent.
 */
const EXIT = {
  OK: 0,
  USAGE: 1,
  ARGS: 2,
};

/**
 * Public entry. Returns numeric exit code; never throws on expected paths.
 *
 * @param {object} [opts]
 * @param {string}  [opts.target]
 * @param {boolean} [opts.json]
 * @param {boolean} [opts.noRegistryCheck]   when true, skips `npm view`
 * @param {string}  [opts.gate]              defaults to 'codex-gate'
 * @param {string}  [opts.bundleVersion]     defaults to 'v1'
 * @param {string}  [opts.branch]            branch to probe for protection
 * @param {Function} [opts.execFn]           passed to registry client
 * @param {object}  [opts.ghCli]             override gh client (tests)
 * @param {object}  [opts.registry]          override registry client (tests)
 * @param {Function} [opts.detectOwnerRepoFn] override remote detection (tests)
 * @returns {Promise<number>} exit code
 */
export async function status(opts = {}) {
  const json = Boolean(opts.json);
  const noRegistryCheck = Boolean(opts.noRegistryCheck);
  const gateName = opts.gate ?? 'codex-gate';
  const bundleVersion = opts.bundleVersion ?? 'v1';
  const branch = opts.branch ?? 'main';
  const cwd = opts.cwd ?? process.cwd();
  const targetDir = resolve(opts.target ? opts.target : cwd);

  // ─── Step 1: validate target dir ────────────────────────────────────────
  if (!existsSync(targetDir)) {
    if (json) {
      console.log(
        JSON.stringify(
          {
            target: targetDir,
            overall: 'ERROR',
            error: `Target directory does not exist: ${targetDir}`,
            exitCode: EXIT.ARGS,
          },
          null,
          2,
        ),
      );
    } else {
      console.error(`hubos-review status: target directory does not exist: ${targetDir}`);
    }
    return EXIT.ARGS;
  }

  // ─── Step 2: read .aiox/cicd-version ────────────────────────────────────
  const cicdPath = join(targetDir, '.aiox', 'cicd-version');
  if (!existsSync(cicdPath)) {
    if (json) {
      console.log(
        JSON.stringify(
          {
            target: targetDir,
            lockFile: '.aiox/cicd-version',
            overall: 'NOT_INSTALLED',
            installed: false,
            error: 'No gate installed in this repository.',
            remediation: "Run 'hubos-review install codex-gate'",
            exitCode: EXIT.USAGE,
          },
          null,
          2,
        ),
      );
    } else {
      console.error('No gate installed in this repository.');
      console.error("Run 'hubos-review install codex-gate' to install.");
    }
    return EXIT.USAGE;
  }

  let cicdVersion;
  try {
    cicdVersion = JSON.parse(readFileSync(cicdPath, 'utf8'));
  } catch (err) {
    if (json) {
      console.log(
        JSON.stringify(
          {
            target: targetDir,
            lockFile: '.aiox/cicd-version',
            overall: 'CORRUPTED',
            error: `Failed to parse .aiox/cicd-version: ${err.message}`,
            exitCode: EXIT.USAGE,
          },
          null,
          2,
        ),
      );
    } else {
      console.error(`hubos-review status: .aiox/cicd-version is not valid JSON: ${err.message}`);
      console.error("Run 'hubos-review install codex-gate --force' to regenerate it.");
    }
    return EXIT.USAGE;
  }

  // ─── Step 3: load the bundle manifest shipped by this CLI ───────────────
  let bundleManifest = null;
  try {
    bundleManifest = loadBundleManifest(gateName, bundleVersion);
  } catch {
    // Non-fatal: we can still render the installed state without a bundle
    // comparison. The OUTDATED column simply degrades to "?".
    bundleManifest = null;
  }

  // ─── Step 4: per-file diff (sha256 match / modified / missing) ──────────
  const diff = bundleManifest
    ? diffInstalledVsBundle({ targetDir, cicdVersion, gateName, bundleManifest })
    : diffInstalledVsBundle({
        targetDir,
        cicdVersion,
        gateName,
        bundleManifest: { files: [] },
      });

  // ─── Step 5: npm registry check ─────────────────────────────────────────
  const installedVersion = cicdVersion.version ?? null;
  const packageName = cicdVersion.package ?? '@hubplural/hubos-review';
  let registryResult;
  if (noRegistryCheck) {
    registryResult = { status: 'offline', version: null, reason: 'flag' };
  } else {
    const registry = opts.registry ?? createRegistryClient({ execFn: opts.execFn });
    registryResult = await registry.getLatestVersion(packageName);
  }

  // ─── Step 6: branch protection probe ────────────────────────────────────
  // Best-effort. If gh isn't available or the user lacks access, we surface
  // "cannot verify" without blocking the overall exit code.
  const branchProtection = await probeBranchProtection({
    targetDir,
    branch,
    checkName: DEFAULT_CHECK_NAME,
    ghCli: opts.ghCli,
    detectOwnerRepoFn: opts.detectOwnerRepoFn,
  });

  // ─── Step 7: compute overall status ─────────────────────────────────────
  const criticalCount = diff.entries.filter((e) => e.status === 'MISSING').length;
  const modifiedCount = diff.summary.modified + diff.summary.modifiedAndOutdated;

  let overall = 'OK';
  let exitCode = EXIT.OK;
  if (criticalCount > 0) {
    overall = 'FAIL';
    exitCode = EXIT.USAGE;
  } else if (modifiedCount > 0) {
    overall = 'WARN';
    // AC-4: hash mismatch (modified) is NOT a fatal error, just a warning.
    exitCode = EXIT.OK;
  } else if (diff.summary.outdated > 0 || diff.summary.newInBundle > 0) {
    overall = 'OUTDATED';
    exitCode = EXIT.OK;
  }

  // Update availability is computed independently from file diff.
  let updateAvailable = false;
  if (registryResult.status === 'online' && registryResult.version && installedVersion) {
    updateAvailable = compareVersions(installedVersion, registryResult.version) < 0;
  }

  // ─── Step 8: render ─────────────────────────────────────────────────────
  if (json) {
    renderJson({
      targetDir,
      cicdVersion,
      diff,
      registryResult,
      branchProtection,
      gateName,
      overall,
      exitCode,
      updateAvailable,
    });
  } else {
    renderHuman({
      targetDir,
      cicdVersion,
      diff,
      registryResult,
      branchProtection,
      gateName,
      overall,
      exitCode,
      updateAvailable,
      packageName,
      installedVersion,
    });
  }
  return exitCode;
}

/**
 * Branch protection probe via gh api. Returns a structured outcome the
 * renderers can format without re-implementing classification.
 *
 * @param {object} args
 * @param {string} args.targetDir
 * @param {string} args.branch
 * @param {string} args.checkName
 * @param {object} [args.ghCli]
 * @param {Function} [args.detectOwnerRepoFn]
 * @returns {Promise<{ state: 'configured'|'not-configured'|'cannot-verify'|'no-remote'|'error', checkName?: string, owner?: string, repo?: string, branch?: string, message?: string }>}
 */
async function probeBranchProtection({
  targetDir,
  branch,
  checkName,
  ghCli,
  detectOwnerRepoFn,
}) {
  const detectFn = detectOwnerRepoFn ?? detectOwnerRepo;
  let ownerRepo = null;
  try {
    ownerRepo = await detectFn({ cwd: targetDir });
  } catch {
    ownerRepo = null;
  }
  if (!ownerRepo) {
    return { state: 'no-remote', branch };
  }
  const client = ghCli ?? createDefaultGhCli();
  let res;
  try {
    res = await client.getProtection(ownerRepo.owner, ownerRepo.repo, branch);
  } catch (err) {
    return {
      state: 'error',
      owner: ownerRepo.owner,
      repo: ownerRepo.repo,
      branch,
      message: err?.message ?? 'unknown error',
    };
  }
  if (res && res.ok) {
    const contexts =
      res.body?.required_status_checks?.contexts ?? [];
    if (contexts.includes(checkName)) {
      return {
        state: 'configured',
        checkName,
        owner: ownerRepo.owner,
        repo: ownerRepo.repo,
        branch,
      };
    }
    return {
      state: 'not-configured',
      checkName,
      owner: ownerRepo.owner,
      repo: ownerRepo.repo,
      branch,
      message: `protection exists but '${checkName}' is not in required status checks`,
    };
  }
  // !ok — distinguish 403/404 from generic errors.
  if (res && res.status === 403) {
    return {
      state: 'cannot-verify',
      checkName,
      owner: ownerRepo.owner,
      repo: ownerRepo.repo,
      branch,
      message: 'HTTP 403 — no admin access to inspect protection',
    };
  }
  if (res && res.status === 404) {
    return {
      state: 'not-configured',
      checkName,
      owner: ownerRepo.owner,
      repo: ownerRepo.repo,
      branch,
      message: 'no branch protection configured (HTTP 404)',
    };
  }
  return {
    state: 'cannot-verify',
    checkName,
    owner: ownerRepo.owner,
    repo: ownerRepo.repo,
    branch,
    message: res?.stderr ?? 'gh api unavailable',
  };
}

/**
 * Render the machine-readable JSON payload. Schema is stable for CI.
 *
 * @param {object} arg
 */
function renderJson({
  targetDir,
  cicdVersion,
  diff,
  registryResult,
  branchProtection,
  gateName,
  overall,
  exitCode,
  updateAvailable,
}) {
  const gateRecord = cicdVersion.gates?.[gateName] ?? null;
  const payload = {
    target: targetDir,
    lockFile: '.aiox/cicd-version',
    package: cicdVersion.package ?? null,
    installedVersion: cicdVersion.version ?? null,
    installedAt: cicdVersion.installedAt ?? null,
    gates: {
      [gateName]: {
        bundleVersion: gateRecord?.bundleVersion ?? null,
        installedAt: gateRecord?.installedAt ?? null,
        files: diff.entries.map((e) => ({
          name: e.name,
          targetPath: e.targetPath,
          installed: e.installedSha,
          current: e.currentSha,
          bundle: e.bundleSha,
          status: e.status,
        })),
        branchProtection: {
          state: branchProtection.state,
          checkName: branchProtection.checkName ?? null,
          owner: branchProtection.owner ?? null,
          repo: branchProtection.repo ?? null,
          branch: branchProtection.branch ?? null,
          message: branchProtection.message ?? null,
        },
      },
    },
    latestAvailable: registryResult.version,
    registryStatus: registryResult.status,
    updateAvailable,
    summary: diff.summary,
    overall,
    exitCode,
  };
  console.log(JSON.stringify(payload, null, 2));
}

/**
 * Render the human-readable ASCII output. Mirrors `verify`'s aesthetics:
 * header → tabular file list → footer with actionable hints.
 *
 * @param {object} arg
 */
function renderHuman({
  targetDir,
  cicdVersion,
  diff,
  registryResult,
  branchProtection,
  gateName,
  overall,
  exitCode,
  updateAvailable,
  packageName,
  installedVersion,
}) {
  const gateRecord = cicdVersion.gates?.[gateName] ?? null;
  console.log('hubos-review status');
  console.log(`Target repo: ${targetDir}`);
  console.log('Lock file: .aiox/cicd-version (committed per D-002-8)');
  console.log('');
  console.log(`Package: ${packageName}`);
  console.log(`Installed version: ${installedVersion ?? '<unknown>'}`);
  console.log(`Installed at: ${cicdVersion.installedAt ?? '<unknown>'}`);
  console.log('');
  console.log(`Gate: ${gateName} ${gateRecord?.bundleVersion ?? '<unknown>'}`);
  if (gateRecord) {
    console.log(`  Bundle version: ${gateRecord.bundleVersion ?? '<unknown>'}`);
    console.log(`  Installed at: ${gateRecord.installedAt ?? '<unknown>'}`);
  }
  console.log(`  Files (${diff.entries.length}):`);
  for (const entry of diff.entries) {
    const icon = fileStatusIcon(entry.status);
    const note = fileStatusNote(entry);
    console.log(`    ${icon} ${entry.targetPath}${note}`);
  }
  console.log('');

  // Update availability line.
  if (registryResult.status === 'offline') {
    const reason = registryResult.error ? ` (${registryResult.error})` : '';
    console.log(`Latest available: offline — could not check registry${reason}`);
    console.log('  Use --no-registry-check to suppress this lookup.');
  } else if (updateAvailable) {
    console.log(
      `Latest available: ${packageName}@${registryResult.version} (newer version available — run 'hubos-review update')`,
    );
  } else if (registryResult.version) {
    console.log(`Latest available: ${packageName}@${registryResult.version} (up-to-date)`);
  } else {
    console.log('Latest available: <unknown>');
  }
  console.log('');

  // Branch protection line.
  console.log('Branch protection:');
  console.log(`  ${branchProtectionLine(branchProtection)}`);
  console.log('');

  // Overall verdict.
  console.log(`Result: ${overall}${overall === 'OK' ? ' — all hashes match' : ''}`);
  if (overall === 'WARN') {
    console.log(
      `  ${diff.summary.modified + diff.summary.modifiedAndOutdated} file(s) locally modified.`,
    );
    console.log(
      "  Inspect with 'git diff' or run 'hubos-review update --dry-run' to preview a clean reinstall.",
    );
  } else if (overall === 'OUTDATED') {
    console.log(`  ${diff.summary.outdated + diff.summary.newInBundle} file(s) outdated.`);
    console.log("  Run 'hubos-review update' to bump.");
  } else if (overall === 'FAIL') {
    console.log(`  ${diff.summary.missing} file(s) missing from disk (critical).`);
    console.log(
      "  Run 'hubos-review install codex-gate --force' to restore from the bundle.",
    );
  }
  if (updateAvailable && overall === 'OK') {
    console.log(
      `  CLI update available: run 'npm install -g ${packageName}@beta' for newer bundle.`,
    );
  }
  // Exit code is the value returned by status(); not echoed here on purpose
  // (a noisy "exit 0" line clutters successful runs).
  void exitCode;
}

function fileStatusIcon(status) {
  switch (status) {
    case 'MATCH':
      return '[OK]';
    case 'MODIFIED':
      return '[!] ';
    case 'OUTDATED':
      return '[U] ';
    case 'MODIFIED_AND_OUTDATED':
      return '[!U]';
    case 'MISSING':
      return '[X] ';
    case 'NEW_IN_BUNDLE':
      return '[+] ';
    default:
      return '[?] ';
  }
}

function fileStatusNote(entry) {
  switch (entry.status) {
    case 'MATCH':
      return ' (sha256 match)';
    case 'MODIFIED':
      return ` (locally modified — sha256 differs from installed record)`;
    case 'OUTDATED':
      return ` (bundle has newer version — installed ${shortSha(entry.installedSha)} → bundle ${shortSha(entry.bundleSha)})`;
    case 'MODIFIED_AND_OUTDATED':
      return ' (locally modified AND bundle has newer version)';
    case 'MISSING':
      return ' (MISSING from disk — install integrity broken)';
    case 'NEW_IN_BUNDLE':
      return ' (NEW in current bundle — not yet installed)';
    default:
      return '';
  }
}

function branchProtectionLine(bp) {
  switch (bp.state) {
    case 'configured':
      return `[OK] '${bp.checkName}' is required check on '${bp.branch}'`;
    case 'not-configured':
      return `[!] not configured for '${bp.branch}' — run 'hubos-review install codex-gate --auto-protect'`;
    case 'cannot-verify':
      return `[?] cannot verify (${bp.message ?? 'no admin access'})`;
    case 'no-remote':
      return `[?] cannot verify — no github.com remote detected on '${bp.branch}'`;
    case 'error':
      return `[?] cannot verify — ${bp.message ?? 'gh api error'}`;
    default:
      return `[?] unknown state`;
  }
}
