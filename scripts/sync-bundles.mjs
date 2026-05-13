#!/usr/bin/env node
/**
 * sync-bundles.mjs — Bundle integrity + drift checker for hubos-review.
 *
 * Two responsibilities:
 *
 *   1. INTEGRITY (default, `--check`):
 *      Validate that each file currently sitting in `bundles/<bundle>/<v>/`
 *      still matches the SHA-256 recorded in that bundle's `manifest.json`.
 *      Runs without any external dependency — used in `prepublishOnly`.
 *
 *   2. DRIFT (optional, `--source-root <path>`):
 *      Additionally compare each bundle file against the corresponding
 *      source file in a local `hub-os` checkout. Used by the maintainer
 *      before cutting a release to ensure the bundle has not drifted from
 *      the source-of-truth artifacts in `hub-os`.
 *
 * Exit codes:
 *   0  — All bundles match their manifest (and source-root, if given).
 *   1  — At least one divergence detected (integrity OR drift).
 *   2  — Misuse (bad flag, missing manifest, etc.).
 *
 * Story: CICD-002-B (AC-5, AC-6).
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const BUNDLES_ROOT = join(REPO_ROOT, 'bundles');

/**
 * Compute SHA-256 of a file's contents, returning the canonical
 * `sha256:<hex>` form used throughout the project.
 */
function sha256(filePath) {
  const buf = readFileSync(filePath);
  return 'sha256:' + createHash('sha256').update(buf).digest('hex');
}

/**
 * Discover all bundles under `bundles/<name>/<version>/`. Skips anything
 * that does not look like a versioned bundle directory.
 *
 * @returns {Array<{ bundle: string, version: string, dir: string, manifestPath: string }>}
 */
function discoverBundles() {
  if (!existsSync(BUNDLES_ROOT)) return [];
  const out = [];
  for (const bundleName of readdirSync(BUNDLES_ROOT)) {
    const bundleDir = join(BUNDLES_ROOT, bundleName);
    if (!statSync(bundleDir).isDirectory()) continue;
    for (const version of readdirSync(bundleDir)) {
      const dir = join(bundleDir, version);
      if (!statSync(dir).isDirectory()) continue;
      const manifestPath = join(dir, 'manifest.json');
      if (!existsSync(manifestPath)) continue;
      out.push({ bundle: bundleName, version, dir, manifestPath });
    }
  }
  return out;
}

/**
 * Parse a manifest.json. Minimal schema check — any required field missing
 * is treated as a hard error (exit 2).
 */
function loadManifest(manifestPath) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (err) {
    throw new Error(`Invalid JSON in ${manifestPath}: ${err.message}`);
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`Manifest is not an object: ${manifestPath}`);
  }
  if (!Array.isArray(parsed.files) || parsed.files.length === 0) {
    throw new Error(`Manifest.files must be a non-empty array: ${manifestPath}`);
  }
  for (const f of parsed.files) {
    if (!f.name || !f.bundlePath || !f.sha256) {
      throw new Error(`Manifest file entry missing required fields: ${JSON.stringify(f)}`);
    }
  }
  return parsed;
}

/**
 * @typedef {{ kind: 'integrity' | 'drift', bundle: string, version: string, file: string, expected: string, actual: string, detail?: string }} Divergence
 */

/**
 * Check a single bundle. Returns the list of divergences (empty = healthy).
 *
 * @param {{ bundle: string, version: string, dir: string, manifestPath: string }} entry
 * @param {string|null} sourceRoot path to hub-os checkout (or null)
 * @returns {Divergence[]}
 */
function checkBundle(entry, sourceRoot) {
  const divergences = [];
  const manifest = loadManifest(entry.manifestPath);

  for (const file of manifest.files) {
    const bundleFile = join(entry.dir, file.bundlePath);

    // 1) Integrity: bundle file vs manifest hash
    if (!existsSync(bundleFile)) {
      divergences.push({
        kind: 'integrity',
        bundle: entry.bundle,
        version: entry.version,
        file: file.name,
        expected: file.sha256,
        actual: '<missing>',
        detail: `Bundle file not found at ${bundleFile}`,
      });
      continue;
    }
    const actualHash = sha256(bundleFile);
    if (actualHash !== file.sha256) {
      divergences.push({
        kind: 'integrity',
        bundle: entry.bundle,
        version: entry.version,
        file: file.name,
        expected: file.sha256,
        actual: actualHash,
        detail: `Bundle file hash does not match manifest`,
      });
    }

    // 2) Drift: bundle file vs source-of-truth (optional)
    if (sourceRoot && file.sourcePath) {
      const sourceFile = join(sourceRoot, file.sourcePath);
      if (!existsSync(sourceFile)) {
        divergences.push({
          kind: 'drift',
          bundle: entry.bundle,
          version: entry.version,
          file: file.name,
          expected: file.sha256,
          actual: '<source-missing>',
          detail: `Source file not found at ${sourceFile} (is --source-root pointing at a hub-os checkout?)`,
        });
        continue;
      }
      const sourceHash = sha256(sourceFile);
      if (sourceHash !== file.sha256) {
        divergences.push({
          kind: 'drift',
          bundle: entry.bundle,
          version: entry.version,
          file: file.name,
          expected: file.sha256,
          actual: sourceHash,
          detail: `Source file in hub-os has drifted from bundle — re-run bundle copy or bump bundle version`,
        });
      }
    }
  }

  return divergences;
}

/**
 * Parse argv. Supports:
 *   --check                  (default — integrity only)
 *   --source-root <path>     (also run drift check vs hub-os)
 *   --quiet                  (suppress success output, still emits failures)
 *   --help / -h
 */
function parseArgs(argv) {
  const opts = { sourceRoot: null, quiet: false, help: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--check') {
      // Default behavior; flag accepted for explicitness.
      continue;
    }
    if (a === '--source-root') {
      opts.sourceRoot = argv[++i];
      if (!opts.sourceRoot) {
        throw new Error('--source-root requires a path argument');
      }
      continue;
    }
    if (a.startsWith('--source-root=')) {
      opts.sourceRoot = a.slice('--source-root='.length);
      continue;
    }
    if (a === '--quiet') {
      opts.quiet = true;
      continue;
    }
    if (a === '--help' || a === '-h') {
      opts.help = true;
      continue;
    }
    throw new Error(`Unknown argument: ${a}`);
  }
  return opts;
}

function printHelp() {
  console.log(`sync-bundles.mjs — validate hubos-review bundles

USAGE
  node scripts/sync-bundles.mjs [--check] [--source-root <hub-os-path>] [--quiet]

DESCRIPTION
  By default ("--check"), verifies that each file in bundles/<name>/<version>/
  matches the SHA-256 recorded in that bundle's manifest.json. This is the
  integrity check wired into "npm run prepublishOnly".

  With --source-root <path>, additionally compares each bundle file against
  the corresponding source in a local hub-os checkout. Use this before
  cutting a release to catch drift from the source-of-truth.

EXIT CODES
  0  All bundles match (and source-root if given)
  1  At least one divergence detected
  2  Misuse / parse error
`);
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv);
  } catch (err) {
    console.error(`sync-bundles: ${err.message}`);
    console.error("Run 'node scripts/sync-bundles.mjs --help' for usage.");
    process.exit(2);
  }
  if (opts.help) {
    printHelp();
    process.exit(0);
  }

  const bundles = discoverBundles();
  if (bundles.length === 0) {
    console.error('sync-bundles: no bundles found under bundles/. Nothing to check.');
    process.exit(2);
  }

  if (opts.sourceRoot) {
    const abs = resolve(opts.sourceRoot);
    if (!existsSync(abs)) {
      console.error(`sync-bundles: --source-root path does not exist: ${abs}`);
      process.exit(2);
    }
    opts.sourceRoot = abs;
  }

  let totalDivergences = 0;
  for (const entry of bundles) {
    let divergences;
    try {
      divergences = checkBundle(entry, opts.sourceRoot);
    } catch (err) {
      console.error(`sync-bundles: ${err.message}`);
      process.exit(2);
    }
    if (divergences.length === 0) {
      if (!opts.quiet) {
        const note = opts.sourceRoot ? ' (integrity + drift)' : ' (integrity)';
        console.log(`OK ${entry.bundle}/${entry.version}${note}`);
      }
      continue;
    }
    totalDivergences += divergences.length;
    for (const d of divergences) {
      const tag = d.kind === 'drift' ? 'DRIFT' : 'INTEGRITY';
      console.error(
        `${tag} ${entry.bundle}/${entry.version} :: ${d.file}\n  expected: ${d.expected}\n  actual:   ${d.actual}\n  detail:   ${d.detail ?? '(no detail)'}`,
      );
    }
  }

  if (totalDivergences > 0) {
    console.error(`\nsync-bundles: ${totalDivergences} divergence(s) detected.`);
    process.exit(1);
  }

  if (!opts.quiet) {
    console.log(`sync-bundles: all ${bundles.length} bundle(s) clean.`);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(`sync-bundles: fatal error: ${err.message}`);
  process.exit(2);
});
