/**
 * File-level diff between an installed gate (`.aiox/cicd-version`) and the
 * bundle currently shipped by this CLI.
 *
 * Story: CICD-002-E (AC-4, AC-8, AC-11).
 *
 * Output is deliberately coarse — we report per-file status enums, not a
 * unified text diff. `update` only needs to know which files changed
 * (`from sha256:... to sha256:...`); the user inspects content with `git
 * diff` if they want to see line-level changes.
 *
 * Status enum for each file:
 *   - 'MATCH'             on-disk sha == installed record sha AND ==
 *                          bundle sha (no change either side)
 *   - 'MODIFIED'           on-disk sha != installed record sha (user
 *                          edited the file after install)
 *   - 'OUTDATED'           on-disk sha == installed record sha, but bundle
 *                          sha is newer (this CLI ships a fresher copy)
 *   - 'MODIFIED_AND_OUTDATED'  user edited AND bundle moved — both
 *                          conditions; `update --force-update` clobbers
 *   - 'MISSING'            file is missing from disk (probably deleted)
 *   - 'NEW_IN_BUNDLE'      bundle has a file the installed record doesn't
 *                          (forward compat — new file added in v2)
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { sha256File } from './bundle.js';

/**
 * @typedef {Object} FileDiffEntry
 * @property {string} name
 * @property {string} targetPath
 * @property {string|null} installedSha   sha recorded in .aiox/cicd-version
 * @property {string|null} currentSha     sha computed from disk (or null when MISSING)
 * @property {string|null} bundleSha      sha shipped by the CLI bundle
 * @property {'MATCH'|'MODIFIED'|'OUTDATED'|'MODIFIED_AND_OUTDATED'|'MISSING'|'NEW_IN_BUNDLE'} status
 */

/**
 * Build the full file-by-file diff between an installed gate record and a
 * bundle manifest. Pure (apart from filesystem reads through sha256File).
 *
 * @param {object} args
 * @param {string} args.targetDir
 * @param {object} args.cicdVersion       parsed .aiox/cicd-version JSON (or null)
 * @param {string} args.gateName          e.g. 'codex-gate'
 * @param {object} args.bundleManifest    output of loadBundleManifest()
 * @returns {{ entries: FileDiffEntry[], summary: { match: number, modified: number, outdated: number, missing: number, newInBundle: number, modifiedAndOutdated: number } }}
 */
export function diffInstalledVsBundle({ targetDir, cicdVersion, gateName, bundleManifest }) {
  const gateRecord = cicdVersion?.gates?.[gateName] ?? null;
  const installedFiles = Array.isArray(gateRecord?.files) ? gateRecord.files : [];
  const bundleFiles = Array.isArray(bundleManifest?.files) ? bundleManifest.files : [];

  // Index by `name` since that's the stable identifier in both schemas
  // (manifest.files[].name + cicd-version.gates.{}.files[].name).
  const bundleByName = new Map(bundleFiles.map((f) => [f.name, f]));
  const installedByName = new Map(installedFiles.map((f) => [f.name, f]));

  /** @type {FileDiffEntry[]} */
  const entries = [];

  // Walk installed first so the output preserves install order when possible.
  for (const inst of installedFiles) {
    const bundleEntry = bundleByName.get(inst.name) ?? null;
    const targetPath = inst.targetPath ?? bundleEntry?.targetPath;
    const fullPath = join(targetDir, targetPath);
    const installedSha = inst.sha256 ?? null;
    const bundleSha = bundleEntry?.sha256 ?? null;

    if (!existsSync(fullPath)) {
      entries.push({
        name: inst.name,
        targetPath,
        installedSha,
        currentSha: null,
        bundleSha,
        status: 'MISSING',
      });
      continue;
    }
    const currentSha = sha256File(fullPath);
    const isModified = installedSha !== null && currentSha !== installedSha;
    const isOutdated = bundleSha !== null && installedSha !== null && installedSha !== bundleSha;

    let status;
    if (isModified && isOutdated) {
      status = 'MODIFIED_AND_OUTDATED';
    } else if (isModified) {
      status = 'MODIFIED';
    } else if (isOutdated) {
      status = 'OUTDATED';
    } else {
      status = 'MATCH';
    }
    entries.push({
      name: inst.name,
      targetPath,
      installedSha,
      currentSha,
      bundleSha,
      status,
    });
  }

  // Add any bundle file that wasn't in the installed record (forward compat).
  for (const bundle of bundleFiles) {
    if (!installedByName.has(bundle.name)) {
      entries.push({
        name: bundle.name,
        targetPath: bundle.targetPath,
        installedSha: null,
        currentSha: null,
        bundleSha: bundle.sha256 ?? null,
        status: 'NEW_IN_BUNDLE',
      });
    }
  }

  const summary = {
    match: entries.filter((e) => e.status === 'MATCH').length,
    modified: entries.filter((e) => e.status === 'MODIFIED').length,
    outdated: entries.filter((e) => e.status === 'OUTDATED').length,
    modifiedAndOutdated: entries.filter((e) => e.status === 'MODIFIED_AND_OUTDATED').length,
    missing: entries.filter((e) => e.status === 'MISSING').length,
    newInBundle: entries.filter((e) => e.status === 'NEW_IN_BUNDLE').length,
  };
  return { entries, summary };
}

/**
 * Predicate: are there any files that would be touched if we ran `update`?
 *
 * @param {FileDiffEntry[]} entries
 * @returns {boolean}
 */
export function hasBundleChanges(entries) {
  return entries.some(
    (e) => e.status === 'OUTDATED' || e.status === 'NEW_IN_BUNDLE' || e.status === 'MODIFIED_AND_OUTDATED' || e.status === 'MISSING',
  );
}

/**
 * Predicate: are there local modifications (user edited files post-install)?
 *
 * @param {FileDiffEntry[]} entries
 * @returns {boolean}
 */
export function hasLocalModifications(entries) {
  return entries.some(
    (e) => e.status === 'MODIFIED' || e.status === 'MODIFIED_AND_OUTDATED',
  );
}

/**
 * Format a sha256:<hex> for human display. Keeps the prefix + first 12 hex
 * chars so the table stays readable while preserving uniqueness in practice.
 *
 * @param {string|null} sha
 * @returns {string}
 */
export function shortSha(sha) {
  if (!sha) return '<none>';
  // sha256:abcdef...  → sha256:abcdef0123ab
  const m = sha.match(/^(sha256:)([0-9a-f]+)$/i);
  if (!m) return sha;
  return `${m[1]}${m[2].slice(0, 12)}…`;
}
