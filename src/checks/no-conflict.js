/**
 * C5b — No conflict between pre-existing `.github/workflows/codex-gate.yml`
 *       and the bundle this CLI ships.
 *
 * Severity: HIGH — a naive `install` would silently overwrite a customized
 * `codex-gate.yml`. We surface this before any write happens so the user
 * decides explicitly (with --force) whether to clobber.
 *
 * Logic:
 *   1. No file at target → PASS (clean slate).
 *   2. File present + hash MATCHES bundle hash → PASS (already installed
 *      on this version; idempotence-friendly).
 *   3. File present + hash DIFFERS from bundle hash:
 *        a. If `.aiox/cicd-version` exists and tracks a different version,
 *           emit WARN (this is a legitimate prior install of a different
 *           bundle version — Story E's `update` will handle the bump).
 *        b. Otherwise → FAIL with explicit message about clobbering risk.
 *
 * @typedef {import('./_types.js').CheckResult} CheckResult
 * @typedef {import('./_types.js').CheckContext} CheckContext
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadBundleManifest, sha256File } from '../lib/bundle.js';

const TARGET_PATH = '.github/workflows/codex-gate.yml';

/**
 * @param {CheckContext} ctx
 * @returns {Promise<CheckResult>}
 */
export default async function checkNoConflict(ctx = {}) {
  const id = 'C5b';
  const name = 'codex-gate.yml conflict';
  const severity = 'HIGH';
  const targetDir = ctx.targetDir ?? process.cwd();
  const gateName = ctx.gateName ?? 'codex-gate';
  const bundleVersion = ctx.bundleVersion ?? 'v1';

  const targetFile = join(targetDir, TARGET_PATH);
  if (!existsSync(targetFile)) {
    return {
      id,
      name,
      severity,
      status: 'PASS',
      blocking: true,
      details: 'no pre-existing workflow file.',
      evidence: { targetFile, present: false },
    };
  }

  // Compare the on-disk hash with the bundle's manifest. If the bundle is
  // unavailable for any reason, fall back to WARN so the dispatcher does not
  // block on a CLI packaging issue. (Story B guarantees the bundle ships
  // inside the npm tarball; absence implies a corrupted install.)
  let bundleManifest;
  try {
    bundleManifest = loadBundleManifest(gateName, bundleVersion);
  } catch (err) {
    return {
      id,
      name,
      severity,
      status: 'WARN',
      blocking: false,
      details:
        `pre-existing workflow file present, but bundle '${gateName}/${bundleVersion}' ` +
        `is not available to compare (${err.message}).`,
      remediation:
        'Reinstall the CLI to restore the bundle: ' +
        "'npm install -g @hubplural/hubos-review@beta'.",
      evidence: { targetFile, bundleError: err.message },
    };
  }

  const wfEntry = bundleManifest.files.find(
    (f) => f.targetPath === TARGET_PATH,
  );
  if (!wfEntry) {
    return {
      id,
      name,
      severity,
      status: 'WARN',
      blocking: false,
      details:
        `bundle manifest does not declare ${TARGET_PATH} — cannot compare hashes.`,
      remediation:
        'Verify the CLI version is recent (`hubos-review --version`).',
      evidence: { manifestFiles: bundleManifest.files.map((f) => f.name) },
    };
  }

  const actualHash = sha256File(targetFile);
  if (actualHash === wfEntry.sha256) {
    return {
      id,
      name,
      severity,
      status: 'PASS',
      blocking: true,
      details:
        `pre-existing workflow matches bundle ${gateName}/${bundleVersion} ` +
        '(no conflict).',
      evidence: { hash: actualHash, bundleHash: wfEntry.sha256 },
    };
  }

  // Hash mismatch — figure out if a legitimate prior install of a different
  // bundle version is the explanation (then WARN), or if the user has hand-
  // edited the file (then FAIL).
  const cicdPath = join(targetDir, '.aiox', 'cicd-version');
  let priorVersion = null;
  if (existsSync(cicdPath)) {
    try {
      const cicd = JSON.parse(readFileSync(cicdPath, 'utf8'));
      const gate = cicd?.gates?.[gateName];
      if (gate?.bundleVersion && gate.bundleVersion !== bundleVersion) {
        priorVersion = gate.bundleVersion;
      }
    } catch {
      // malformed cicd-version — treat as no prior install for this purpose
    }
  }

  if (priorVersion) {
    return {
      id,
      name,
      severity,
      status: 'WARN',
      blocking: false,
      details:
        `workflow already installed at bundle version '${priorVersion}', ` +
        `differs from current bundle '${bundleVersion}'. ` +
        "Use 'hubos-review update' (Story E) to bump versions cleanly.",
      remediation:
        "Run 'hubos-review update' once Story E lands, or 'hubos-review install --force' " +
        'to overwrite immediately.',
      evidence: {
        priorVersion,
        currentBundle: bundleVersion,
        diskHash: actualHash,
        bundleHash: wfEntry.sha256,
      },
    };
  }

  return {
    id,
    name,
    severity,
    status: 'FAIL',
    blocking: true,
    details:
      `pre-existing workflow at ${TARGET_PATH} differs from bundle ` +
      `${gateName}/${bundleVersion} and is not tracked by .aiox/cicd-version. ` +
      'Installing without --force would overwrite manual customizations.',
    remediation:
      'Inspect the file diff, back it up if needed, then re-run ' +
      "'hubos-review install --force' to overwrite with the canonical bundle.",
    evidence: {
      diskHash: actualHash,
      bundleHash: wfEntry.sha256,
      cicdVersionPresent: existsSync(cicdPath),
    },
  };
}
