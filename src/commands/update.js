/**
 * `hubos-review update` — bump installed gate bundle in place.
 *
 * Story: CICD-002-E (AC-7 through AC-13).
 *
 * Reads `.aiox/cicd-version`, diffs against the bundle currently shipped
 * by this CLI, and (optionally) overwrites the gate files with the newer
 * versions. Detects local modifications (sha256 mismatch with the lock
 * file) and refuses to clobber them without `--force-update`.
 *
 * Exit codes:
 *   0  — up-to-date OR update applied successfully OR dry-run completed OR
 *        user declined interactive prompt
 *   1  — local modifications detected without --force-update OR no gate
 *        installed OR bundle source corrupt
 *   2  — USAGE error (target invalid)
 *
 * Design:
 *   - Per AC-9 / AC-10, TTY auto-detect: interactive sessions get a Y/n
 *     prompt; non-TTY (CI) auto-applies. `--auto-update` short-circuits
 *     the prompt; `--dry-run` short-circuits all writes.
 *   - Per AC-11, local modifications are detected by sha256(disk) !=
 *     sha256(installed record) — totally independent of bundle changes.
 *     This means an `update` on a clean install with no bundle changes is
 *     still a no-op (exit 0 "already up-to-date") even if hashes drifted
 *     between bundle and installed record (the latter is impossible in
 *     practice but the matrix is defensive).
 *   - After successful update, `.aiox/cicd-version` is rewritten with new
 *     hashes + timestamps. The branchProtection block (if any) is preserved.
 */

import {
  existsSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
  mkdirSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import {
  bundleDir,
  sha256File,
  verifyBundleIntegrity,
} from '../lib/bundle.js';
import { createRegistryClient, compareVersions } from '../lib/registry.js';
import {
  diffInstalledVsBundle,
  hasBundleChanges,
  hasLocalModifications,
  shortSha,
} from '../lib/diff.js';
import { defaultTty } from '../lib/tty.js';

const EXIT = {
  OK: 0,
  USAGE: 1,
  ARGS: 2,
};

/**
 * Public entry. Returns a numeric exit code; never throws on expected paths.
 *
 * @param {object} [opts]
 * @param {string}  [opts.target]
 * @param {string}  [opts.gate]              defaults to 'codex-gate'
 * @param {string}  [opts.bundleVersion]     defaults to 'v1'
 * @param {boolean} [opts.dryRun]
 * @param {boolean} [opts.autoUpdate]        non-interactive (CI mode)
 * @param {boolean} [opts.forceUpdate]       clobber local modifications
 * @param {boolean} [opts.noRegistryCheck]   skip npm view
 * @param {Function} [opts.now]              () => ISO string (for tests)
 * @param {Function} [opts.execFn]           passed to registry
 * @param {object}  [opts.tty]               override TTY helpers (tests)
 * @param {object}  [opts.registry]          override registry client (tests)
 * @returns {Promise<number>} exit code
 */
export async function update(opts = {}) {
  const gateName = opts.gate ?? 'codex-gate';
  const bundleVersion = opts.bundleVersion ?? 'v1';
  const cwd = opts.cwd ?? process.cwd();
  const targetDir = resolve(opts.target ? opts.target : cwd);
  const dryRun = Boolean(opts.dryRun);
  const autoUpdate = Boolean(opts.autoUpdate);
  const forceUpdate = Boolean(opts.forceUpdate);
  const noRegistryCheck = Boolean(opts.noRegistryCheck);
  const tty = opts.tty ?? defaultTty;
  const now =
    typeof opts.now === 'function' ? opts.now() : new Date().toISOString();

  // ─── Step 1: validate target dir ────────────────────────────────────────
  if (!existsSync(targetDir)) {
    console.error(`hubos-review update: target directory does not exist: ${targetDir}`);
    return EXIT.ARGS;
  }

  const cicdPath = join(targetDir, '.aiox', 'cicd-version');
  if (!existsSync(cicdPath)) {
    console.error(
      "hubos-review update: no gate installed in this repository.\n" +
        "Run 'hubos-review install codex-gate' to install first.",
    );
    return EXIT.USAGE;
  }

  let cicdVersion;
  try {
    cicdVersion = JSON.parse(readFileSync(cicdPath, 'utf8'));
  } catch (err) {
    console.error(
      `hubos-review update: .aiox/cicd-version is not valid JSON (${err.message}).\n` +
        "Run 'hubos-review install codex-gate --force' to regenerate.",
    );
    return EXIT.USAGE;
  }

  const gateRecord = cicdVersion?.gates?.[gateName];
  if (!gateRecord) {
    console.error(
      `hubos-review update: gate '${gateName}' is not recorded in .aiox/cicd-version.\n` +
        "Run 'hubos-review install codex-gate' first.",
    );
    return EXIT.USAGE;
  }

  // ─── Step 2: verify bundle integrity (defensive — AC-13 derivative) ─────
  let bundleManifest;
  try {
    bundleManifest = verifyBundleIntegrity(gateName, bundleVersion);
  } catch (err) {
    console.error(`hubos-review update: ${err.message}`);
    return EXIT.USAGE;
  }

  // ─── Step 3: registry lookup (informational — not a gate) ───────────────
  const installedVersion = cicdVersion.version ?? null;
  const packageName = cicdVersion.package ?? '@hubplural/hubos-review';
  let registryResult;
  if (noRegistryCheck) {
    registryResult = { status: 'offline', version: null, reason: 'flag' };
  } else {
    const registry = opts.registry ?? createRegistryClient({ execFn: opts.execFn });
    registryResult = await registry.getLatestVersion(packageName);
  }

  // ─── Step 4: file-level diff ────────────────────────────────────────────
  const diff = diffInstalledVsBundle({
    targetDir,
    cicdVersion,
    gateName,
    bundleManifest,
  });

  const localMods = hasLocalModifications(diff.entries);
  const bundleChanges = hasBundleChanges(diff.entries);

  // ─── Step 5: up-to-date short-circuit (AC-7) ────────────────────────────
  if (!bundleChanges) {
    if (localMods && !forceUpdate) {
      // Locally modified but bundle matches — there's nothing to update from
      // the CLI's perspective. Surface as informational, exit 0.
      console.log(
        `Already up-to-date with bundle (${gateName} ${bundleVersion}).`,
      );
      console.log(
        `Note: ${diff.summary.modified + diff.summary.modifiedAndOutdated} file(s) locally modified.` +
          " Inspect with 'git diff'.",
      );
      return EXIT.OK;
    }
    console.log(
      `Already up-to-date. ${gateName} ${bundleVersion} (${packageName}@${installedVersion ?? '?'})`,
    );
    if (registryResult.status === 'online' && registryResult.version && installedVersion) {
      if (compareVersions(installedVersion, registryResult.version) < 0) {
        console.log(
          `Note: newer CLI version available — ${packageName}@${registryResult.version}.` +
            ` Run 'npm install -g ${packageName}@beta' to fetch a fresher bundle.`,
        );
      }
    }
    return EXIT.OK;
  }

  // ─── Step 6: aborts on local modifications without --force-update (AC-11)
  if (localMods && !forceUpdate) {
    console.error('Aborting update: locally modified files detected.');
    console.error('Files with local modifications:');
    for (const entry of diff.entries) {
      if (entry.status === 'MODIFIED' || entry.status === 'MODIFIED_AND_OUTDATED') {
        console.error(
          `  ${entry.targetPath} (sha256 differs from installed record: ${shortSha(entry.installedSha)} → ${shortSha(entry.currentSha)})`,
        );
      }
    }
    console.error('');
    console.error('Use --force-update to overwrite local modifications.');
    console.error("Or inspect with 'git diff' / 'hubos-review status' first.");
    return EXIT.USAGE;
  }

  // ─── Step 7: print the proposed plan (also used for --dry-run, AC-8) ────
  const newBundleVersion = bundleManifest.bundleVersion ?? bundleVersion;
  const oldBundleVersion = gateRecord.bundleVersion ?? '<unknown>';

  console.log(
    `Update available: ${gateName} ${oldBundleVersion} → ${newBundleVersion}` +
      (registryResult.status === 'online' && registryResult.version && installedVersion
        ? ` (${packageName}@${installedVersion} → @${registryResult.version})`
        : ` (${packageName}@${installedVersion ?? '?'})`),
  );
  console.log('');
  console.log('Files that would change:');
  for (const entry of diff.entries) {
    if (entry.status === 'MATCH') continue;
    console.log(`  ${entry.name} (${entry.status})`);
    if (entry.installedSha || entry.bundleSha) {
      console.log(`    from: ${shortSha(entry.installedSha)} (current installed)`);
      console.log(`    to:   ${shortSha(entry.bundleSha)} (latest in bundle)`);
    }
    if (entry.status === 'MISSING') {
      console.log(`    (file missing from disk — will be restored)`);
    }
    if (entry.status === 'NEW_IN_BUNDLE') {
      console.log(`    (new file added in current bundle — will be created)`);
    }
  }
  console.log('');

  // ─── Step 8: --dry-run short-circuit (AC-8) ─────────────────────────────
  if (dryRun) {
    console.log('Dry run — no filesystem changes were made.');
    return EXIT.OK;
  }

  // ─── Step 9: TTY decision (AC-9, AC-10) ─────────────────────────────────
  let shouldApply = false;
  const interactive = tty?.isInteractive ? tty.isInteractive() : false;

  if (autoUpdate) {
    shouldApply = true;
    if (forceUpdate) {
      console.log("Applying update ('--auto-update --force-update' — local modifications will be overwritten).");
    } else {
      console.log("Applying update ('--auto-update' flag).");
    }
  } else if (!interactive) {
    shouldApply = true;
    console.log(
      'Non-TTY context detected — applying update automatically ' +
        "(pass --dry-run to preview without writing).",
    );
  } else {
    // Interactive — prompt the user.
    let yes;
    try {
      const warning = forceUpdate && localMods ? ' (local modifications WILL be overwritten)' : '';
      yes = await tty.promptYesNo(`Continue?${warning}`, true);
    } catch (err) {
      console.error(
        `hubos-review update: failed to prompt (${err.message}). ` +
          'Re-run with --auto-update or --dry-run to be explicit.',
      );
      return EXIT.USAGE;
    }
    if (!yes) {
      console.log('Update aborted by user.');
      return EXIT.OK;
    }
    shouldApply = true;
  }

  if (!shouldApply) {
    // Defensive — exhaustive branches above should always set shouldApply.
    return EXIT.OK;
  }

  // ─── Step 10: apply the update — copy files + rewrite cicd-version ──────
  const bundlePath = bundleDir(gateName, bundleVersion);
  const newFiles = [];
  for (const file of bundleManifest.files) {
    const sourcePath = join(bundlePath, file.bundlePath);
    const destPath = join(targetDir, file.targetPath);
    try {
      mkdirSync(dirname(destPath), { recursive: true });
      copyFileSync(sourcePath, destPath);
    } catch (err) {
      console.error(
        `hubos-review update: failed to copy ${file.name} → ${destPath}: ${err.message}`,
      );
      return EXIT.USAGE;
    }
    const actualHash = sha256File(destPath);
    if (actualHash !== file.sha256) {
      console.error(
        `hubos-review update: post-copy hash mismatch for ${file.name}.\n` +
          `  expected: ${file.sha256}\n` +
          `  actual:   ${actualHash}\n` +
          'Filesystem may be unreliable — .aiox/cicd-version NOT updated.',
      );
      return EXIT.USAGE;
    }
    newFiles.push({
      name: file.name,
      targetPath: file.targetPath,
      sha256: actualHash,
    });
  }

  // ─── Step 11: rewrite .aiox/cicd-version (AC-13) ────────────────────────
  // Preserve branchProtection (if any) from the previous record — `update`
  // doesn't touch branch protection state on GitHub.
  const pkgMeta = readPackageMeta();
  const previousProtection = gateRecord.branchProtection ?? null;

  const newCicd = {
    package: pkgMeta.name,
    version: pkgMeta.version,
    installedAt: now,
    gates: {
      ...(cicdVersion.gates ?? {}),
      [gateName]: {
        bundleVersion: newBundleVersion,
        installedAt: now,
        sourceHash: Object.fromEntries(newFiles.map((f) => [f.name, f.sha256])),
        files: newFiles.map((f) => ({
          name: f.name,
          targetPath: f.targetPath,
          sha256: f.sha256,
        })),
        ...(previousProtection ? { branchProtection: previousProtection } : {}),
      },
    },
  };
  try {
    mkdirSync(dirname(cicdPath), { recursive: true });
    writeFileSync(cicdPath, JSON.stringify(newCicd, null, 2) + '\n', 'utf8');
  } catch (err) {
    console.error(
      `hubos-review update: files updated but failed to rewrite .aiox/cicd-version: ${err.message}`,
    );
    return EXIT.USAGE;
  }

  // ─── Step 12: success banner ────────────────────────────────────────────
  console.log(
    `Updated ${gateName}: ${oldBundleVersion} → ${newBundleVersion}` +
      ` (${packageName}@${installedVersion ?? '?'} → @${pkgMeta.version}).`,
  );
  console.log(`${newFiles.length} file(s) refreshed.`);
  console.log("Remember to 'git add .aiox/cicd-version' and the refreshed gate files (D-002-8).");
  return EXIT.OK;
}

/**
 * Read the CLI's own package.json so we stamp the right `version` into
 * the target's lock file. Mirrors install.js's helper.
 */
function readPackageMeta() {
  try {
    const here = new URL('.', import.meta.url).pathname;
    const pkgPath = join(here, '..', '..', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    return {
      name: pkg.name ?? '@hubplural/hubos-review',
      version: pkg.version ?? '0.0.0-dev',
    };
  } catch {
    return { name: '@hubplural/hubos-review', version: '0.0.0-dev' };
  }
}
