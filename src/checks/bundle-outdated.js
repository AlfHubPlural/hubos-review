/**
 * C6 — bundle version installed in the target is the latest available in the
 *      CLI. Informational only.
 *
 * Severity: MEDIUM — never blocks install (`exit 0`). Surfaces a WARN when
 * `.aiox/cicd-version` references a bundle version older than what this CLI
 * ships. MVP only declares `v1`, so this check always returns PASS unless a
 * future CLI ships `v2+`.
 *
 * @typedef {import('./_types.js').CheckResult} CheckResult
 * @typedef {import('./_types.js').CheckContext} CheckContext
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { bundleDir, loadBundleManifest } from '../lib/bundle.js';

/**
 * @param {CheckContext} ctx
 * @returns {Promise<CheckResult>}
 */
export default async function checkBundleOutdated(ctx = {}) {
  const id = 'C6';
  const name = 'bundle version (outdated)';
  const severity = 'MEDIUM';
  const targetDir = ctx.targetDir ?? process.cwd();
  const gateName = ctx.gateName ?? 'codex-gate';
  const latestBundleVersion = ctx.bundleVersion ?? 'v1';

  // Cheap availability check first — we use bundleDir() so the failure mode
  // matches install.js semantics if the bundle has been stripped.
  if (!existsSync(bundleDir(gateName, latestBundleVersion))) {
    return {
      id,
      name,
      severity,
      status: 'WARN',
      blocking: false,
      details: `bundle '${gateName}/${latestBundleVersion}' not present in the CLI package — cannot compare.`,
      remediation:
        "Reinstall the CLI: 'npm install -g @hubplural/hubos-review@beta'.",
      evidence: { latestBundleVersion },
    };
  }

  // Load just to assert the manifest is well-formed — surfaces packaging bugs
  // early. Result discarded; we only care that it succeeds.
  try {
    loadBundleManifest(gateName, latestBundleVersion);
  } catch (err) {
    return {
      id,
      name,
      severity,
      status: 'WARN',
      blocking: false,
      details: `bundle manifest unreadable: ${err.message}`,
      evidence: { error: err.message },
    };
  }

  const cicdPath = join(targetDir, '.aiox', 'cicd-version');
  if (!existsSync(cicdPath)) {
    return {
      id,
      name,
      severity,
      status: 'PASS',
      blocking: false,
      details: `bundle ${latestBundleVersion} (no prior install detected).`,
      evidence: { installed: null, latest: latestBundleVersion },
    };
  }

  let cicd;
  try {
    cicd = JSON.parse(readFileSync(cicdPath, 'utf8'));
  } catch {
    return {
      id,
      name,
      severity,
      status: 'WARN',
      blocking: false,
      details: 'existing .aiox/cicd-version is malformed (not valid JSON).',
      remediation:
        "Run 'hubos-review install --force' to regenerate, after backing up customizations.",
      evidence: { cicdPath },
    };
  }

  const installedVersion = cicd?.gates?.[gateName]?.bundleVersion ?? null;
  if (!installedVersion) {
    return {
      id,
      name,
      severity,
      status: 'PASS',
      blocking: false,
      details: `bundle ${latestBundleVersion} (no install record for gate '${gateName}').`,
      evidence: { installed: null, latest: latestBundleVersion },
    };
  }

  if (installedVersion === latestBundleVersion) {
    return {
      id,
      name,
      severity,
      status: 'PASS',
      blocking: false,
      details: `bundle ${installedVersion} (current).`,
      evidence: { installed: installedVersion, latest: latestBundleVersion },
    };
  }

  // Strict monotonic compare — bundle versions are `v1`, `v2`, ... per
  // D-002-6. We extract the integer portion and compare; anything we can't
  // parse falls back to "unknown — WARN".
  const installedInt = parseVersionNumber(installedVersion);
  const latestInt = parseVersionNumber(latestBundleVersion);
  if (installedInt != null && latestInt != null && installedInt < latestInt) {
    return {
      id,
      name,
      severity,
      status: 'WARN',
      blocking: false,
      details:
        `installed bundle ${installedVersion} is older than current ${latestBundleVersion}. ` +
        "Run 'hubos-review update' (Story E) to bump.",
      remediation:
        "After Story E lands, 'hubos-review update' will bump in place. " +
        "Until then, 'hubos-review install --force' reinstalls the latest.",
      evidence: { installed: installedVersion, latest: latestBundleVersion },
    };
  }

  // Installed > latest (downgrade?) or unparseable — surface as WARN so the
  // user notices the unusual state without blocking.
  return {
    id,
    name,
    severity,
    status: 'WARN',
    blocking: false,
    details: `unable to compare versions: installed=${installedVersion}, latest=${latestBundleVersion}.`,
    evidence: { installed: installedVersion, latest: latestBundleVersion },
  };
}

/**
 * Parse `'v1'` → 1, `'v23'` → 23, anything else → null.
 *
 * @param {string} v
 * @returns {number | null}
 */
export function parseVersionNumber(v) {
  if (typeof v !== 'string') return null;
  const m = v.match(/^v(\d+)$/);
  if (!m) return null;
  const n = Number.parseInt(m[1], 10);
  return Number.isFinite(n) ? n : null;
}
