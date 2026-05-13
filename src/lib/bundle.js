/**
 * Bundle discovery + manifest parsing for hubos-review.
 *
 * Bundles live in `bundles/<gate-name>/<version>/` (relative to the package
 * root) and ship inside the npm tarball. Each bundle directory has a
 * `manifest.json` describing files, source/target paths, and SHA-256 hashes.
 *
 * This module is the single source of truth for resolving bundle paths so
 * install, verify, status, and update can all share the same logic.
 *
 * Story: CICD-002-B (AC-1, AC-5, AC-7).
 */

import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Resolve the absolute path to the package root (the directory containing
 * `package.json` + `bundles/`). Walks up from this module's location.
 */
export function packageRoot() {
  return resolve(__dirname, '..', '..');
}

/**
 * Resolve the absolute path to a bundle directory.
 *
 * @param {string} gate gate name (e.g., 'codex-gate')
 * @param {string} version bundle version (e.g., 'v1')
 * @returns {string}
 */
export function bundleDir(gate, version = 'v1') {
  return join(packageRoot(), 'bundles', gate, version);
}

/**
 * Compute SHA-256 of a file in canonical `sha256:<hex>` form.
 *
 * @param {string} filePath
 * @returns {string}
 */
export function sha256File(filePath) {
  const buf = readFileSync(filePath);
  return 'sha256:' + createHash('sha256').update(buf).digest('hex');
}

/**
 * Compute SHA-256 of a buffer/string in canonical form.
 *
 * @param {Buffer|string} input
 * @returns {string}
 */
export function sha256Buffer(input) {
  return 'sha256:' + createHash('sha256').update(input).digest('hex');
}

/**
 * @typedef {Object} ManifestFile
 * @property {string} name        Bundle-relative file name (e.g. 'codex-gate.yml')
 * @property {string} bundlePath  Path inside the bundle dir (often = name)
 * @property {string} targetPath  Relative path inside the install target repo
 * @property {string} sourcePath  Relative path inside the source-of-truth repo (hub-os)
 * @property {string} sha256      Expected SHA-256 of the bundle file
 * @property {number} [bytes]     Size in bytes (informational)
 */

/**
 * @typedef {Object} BundleManifest
 * @property {string} bundle           Gate name
 * @property {string} bundleVersion    Version slug ('v1', etc.)
 * @property {string} [sourceRepo]
 * @property {string} [createdAt]
 * @property {string} [description]
 * @property {ManifestFile[]} files
 */

/**
 * Load a bundle's manifest.json. Throws if the bundle or manifest is missing.
 *
 * @param {string} gate
 * @param {string} [version]
 * @returns {BundleManifest}
 */
export function loadBundleManifest(gate, version = 'v1') {
  const dir = bundleDir(gate, version);
  const manifestPath = join(dir, 'manifest.json');
  if (!existsSync(manifestPath)) {
    throw new Error(
      `Bundle not found: ${gate}/${version}. Expected manifest at ${manifestPath}. ` +
        `This usually means the npm package is corrupted or you forgot to publish the bundle.`,
    );
  }
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (err) {
    throw new Error(`Invalid JSON in bundle manifest ${manifestPath}: ${err.message}`);
  }
  if (!manifest || typeof manifest !== 'object') {
    throw new Error(`Bundle manifest is not an object: ${manifestPath}`);
  }
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
    throw new Error(`Bundle manifest.files must be a non-empty array: ${manifestPath}`);
  }
  for (const f of manifest.files) {
    if (!f.name || !f.bundlePath || !f.targetPath || !f.sha256) {
      throw new Error(
        `Bundle manifest file entry missing required fields (need name/bundlePath/targetPath/sha256): ${JSON.stringify(f)}`,
      );
    }
  }
  return manifest;
}

/**
 * Validate that every file referenced by the manifest exists in the bundle dir
 * and matches its recorded SHA-256. This is the defensive integrity check we
 * run before any install/dry-run writes to the target.
 *
 * @param {string} gate
 * @param {string} [version]
 * @throws {Error} when any file is missing or has a mismatched hash.
 */
export function verifyBundleIntegrity(gate, version = 'v1') {
  const manifest = loadBundleManifest(gate, version);
  const dir = bundleDir(gate, version);
  for (const file of manifest.files) {
    const bundleFile = join(dir, file.bundlePath);
    if (!existsSync(bundleFile)) {
      throw new Error(
        `Bundle integrity check failed: ${file.name} is missing from ${dir}. ` +
          `Bundle may be corrupted — try reinstalling the package.`,
      );
    }
    const actual = sha256File(bundleFile);
    if (actual !== file.sha256) {
      throw new Error(
        `Bundle integrity check failed: ${file.name} hash mismatch.\n` +
          `  expected: ${file.sha256}\n` +
          `  actual:   ${actual}\n` +
          `Bundle file may have been tampered with — reinstall the package.`,
      );
    }
  }
  return manifest;
}
