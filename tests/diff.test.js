/**
 * Unit tests for src/lib/diff.js.
 *
 * Story: CICD-002-E (AC-14 — diff coverage).
 *
 * Strategy: build a tmp dir on disk with real files so sha256File reads
 * something deterministic. Inject synthetic cicd-version + bundle manifest
 * objects to drive the diff state machine through all 6 status enums.
 */

import { describe, it, expect, afterEach } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';

import {
  diffInstalledVsBundle,
  hasBundleChanges,
  hasLocalModifications,
  shortSha,
} from '../src/lib/diff.js';

function sha(buf) {
  return 'sha256:' + createHash('sha256').update(buf).digest('hex');
}

function writeWithHash(dir, relPath, content) {
  const full = join(dir, relPath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content, 'utf8');
  return sha(Buffer.from(content, 'utf8'));
}

describe('diffInstalledVsBundle', () => {
  /** @type {string[]} */
  const dirs = [];

  function tmp() {
    const d = mkdtempSync(join(tmpdir(), 'hubos-review-diff-test-'));
    dirs.push(d);
    return d;
  }

  afterEach(() => {
    while (dirs.length > 0) {
      try {
        rmSync(dirs.pop(), { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });

  it('reports MATCH when disk sha == installed sha == bundle sha', () => {
    const target = tmp();
    const content = 'workflow yaml v1';
    const h = writeWithHash(target, '.github/workflows/codex-gate.yml', content);
    const cicd = {
      gates: {
        'codex-gate': {
          files: [
            { name: 'codex-gate.yml', targetPath: '.github/workflows/codex-gate.yml', sha256: h },
          ],
        },
      },
    };
    const bundle = {
      files: [
        { name: 'codex-gate.yml', targetPath: '.github/workflows/codex-gate.yml', sha256: h },
      ],
    };
    const { entries, summary } = diffInstalledVsBundle({
      targetDir: target,
      cicdVersion: cicd,
      gateName: 'codex-gate',
      bundleManifest: bundle,
    });
    expect(entries).toHaveLength(1);
    expect(entries[0].status).toBe('MATCH');
    expect(summary.match).toBe(1);
  });

  it('reports MODIFIED when disk sha differs from installed sha (bundle still matches install)', () => {
    const target = tmp();
    const original = 'workflow yaml v1';
    const modified = 'workflow yaml v1 with my edit';
    writeWithHash(target, '.github/workflows/codex-gate.yml', modified);
    const installedSha = sha(Buffer.from(original, 'utf8'));
    const cicd = {
      gates: {
        'codex-gate': {
          files: [
            { name: 'codex-gate.yml', targetPath: '.github/workflows/codex-gate.yml', sha256: installedSha },
          ],
        },
      },
    };
    const bundle = {
      files: [
        { name: 'codex-gate.yml', targetPath: '.github/workflows/codex-gate.yml', sha256: installedSha },
      ],
    };
    const { entries, summary } = diffInstalledVsBundle({
      targetDir: target,
      cicdVersion: cicd,
      gateName: 'codex-gate',
      bundleManifest: bundle,
    });
    expect(entries[0].status).toBe('MODIFIED');
    expect(summary.modified).toBe(1);
  });

  it('reports OUTDATED when disk == installed but bundle has a newer sha', () => {
    const target = tmp();
    const content = 'workflow yaml v1';
    const installedSha = writeWithHash(target, '.github/workflows/codex-gate.yml', content);
    const bundleSha = sha(Buffer.from('workflow yaml v2', 'utf8'));
    const cicd = {
      gates: {
        'codex-gate': {
          files: [
            { name: 'codex-gate.yml', targetPath: '.github/workflows/codex-gate.yml', sha256: installedSha },
          ],
        },
      },
    };
    const bundle = {
      files: [
        { name: 'codex-gate.yml', targetPath: '.github/workflows/codex-gate.yml', sha256: bundleSha },
      ],
    };
    const { entries, summary } = diffInstalledVsBundle({
      targetDir: target,
      cicdVersion: cicd,
      gateName: 'codex-gate',
      bundleManifest: bundle,
    });
    expect(entries[0].status).toBe('OUTDATED');
    expect(summary.outdated).toBe(1);
  });

  it('reports MODIFIED_AND_OUTDATED when both conditions hold', () => {
    const target = tmp();
    writeWithHash(target, '.github/workflows/codex-gate.yml', 'user edited content');
    const installedSha = sha(Buffer.from('workflow yaml v1', 'utf8'));
    const bundleSha = sha(Buffer.from('workflow yaml v2', 'utf8'));
    const cicd = {
      gates: {
        'codex-gate': {
          files: [
            { name: 'codex-gate.yml', targetPath: '.github/workflows/codex-gate.yml', sha256: installedSha },
          ],
        },
      },
    };
    const bundle = {
      files: [
        { name: 'codex-gate.yml', targetPath: '.github/workflows/codex-gate.yml', sha256: bundleSha },
      ],
    };
    const { entries, summary } = diffInstalledVsBundle({
      targetDir: target,
      cicdVersion: cicd,
      gateName: 'codex-gate',
      bundleManifest: bundle,
    });
    expect(entries[0].status).toBe('MODIFIED_AND_OUTDATED');
    expect(summary.modifiedAndOutdated).toBe(1);
  });

  it('reports MISSING when the file is absent from disk', () => {
    const target = tmp();
    // No file written.
    const installedSha = sha(Buffer.from('v1', 'utf8'));
    const cicd = {
      gates: {
        'codex-gate': {
          files: [
            { name: 'codex-gate.yml', targetPath: '.github/workflows/codex-gate.yml', sha256: installedSha },
          ],
        },
      },
    };
    const bundle = {
      files: [
        { name: 'codex-gate.yml', targetPath: '.github/workflows/codex-gate.yml', sha256: installedSha },
      ],
    };
    const { entries, summary } = diffInstalledVsBundle({
      targetDir: target,
      cicdVersion: cicd,
      gateName: 'codex-gate',
      bundleManifest: bundle,
    });
    expect(entries[0].status).toBe('MISSING');
    expect(entries[0].currentSha).toBeNull();
    expect(summary.missing).toBe(1);
  });

  it('reports NEW_IN_BUNDLE when bundle has a file not yet installed', () => {
    const target = tmp();
    const content = 'workflow yaml v1';
    const installedSha = writeWithHash(target, '.github/workflows/codex-gate.yml', content);
    const cicd = {
      gates: {
        'codex-gate': {
          files: [
            { name: 'codex-gate.yml', targetPath: '.github/workflows/codex-gate.yml', sha256: installedSha },
          ],
        },
      },
    };
    const newFileSha = sha(Buffer.from('new in v2', 'utf8'));
    const bundle = {
      files: [
        { name: 'codex-gate.yml', targetPath: '.github/workflows/codex-gate.yml', sha256: installedSha },
        { name: 'new-rule.md', targetPath: '.claude/rules/new-rule.md', sha256: newFileSha },
      ],
    };
    const { entries, summary } = diffInstalledVsBundle({
      targetDir: target,
      cicdVersion: cicd,
      gateName: 'codex-gate',
      bundleManifest: bundle,
    });
    expect(entries).toHaveLength(2);
    expect(entries[1].status).toBe('NEW_IN_BUNDLE');
    expect(summary.newInBundle).toBe(1);
  });

  it('handles gate not present in cicd-version (empty installed)', () => {
    const target = tmp();
    const bundle = {
      files: [
        { name: 'codex-gate.yml', targetPath: '.github/workflows/codex-gate.yml', sha256: sha(Buffer.from('x')) },
      ],
    };
    const { entries, summary } = diffInstalledVsBundle({
      targetDir: target,
      cicdVersion: { gates: {} },
      gateName: 'codex-gate',
      bundleManifest: bundle,
    });
    expect(entries[0].status).toBe('NEW_IN_BUNDLE');
    expect(summary.newInBundle).toBe(1);
  });
});

describe('hasBundleChanges / hasLocalModifications', () => {
  it('hasBundleChanges = true when any OUTDATED/NEW_IN_BUNDLE/MISSING/MODIFIED_AND_OUTDATED present', () => {
    expect(hasBundleChanges([{ status: 'OUTDATED' }])).toBe(true);
    expect(hasBundleChanges([{ status: 'NEW_IN_BUNDLE' }])).toBe(true);
    expect(hasBundleChanges([{ status: 'MISSING' }])).toBe(true);
    expect(hasBundleChanges([{ status: 'MODIFIED_AND_OUTDATED' }])).toBe(true);
    expect(hasBundleChanges([{ status: 'MATCH' }, { status: 'MODIFIED' }])).toBe(false);
    expect(hasBundleChanges([])).toBe(false);
  });

  it('hasLocalModifications = true when any MODIFIED or MODIFIED_AND_OUTDATED present', () => {
    expect(hasLocalModifications([{ status: 'MODIFIED' }])).toBe(true);
    expect(hasLocalModifications([{ status: 'MODIFIED_AND_OUTDATED' }])).toBe(true);
    expect(hasLocalModifications([{ status: 'OUTDATED' }, { status: 'MATCH' }])).toBe(false);
  });
});

describe('shortSha', () => {
  it('returns first 12 hex chars + ellipsis', () => {
    expect(shortSha('sha256:abcdef0123456789abcdef')).toBe('sha256:abcdef012345…');
  });
  it('returns <none> for null/undefined', () => {
    expect(shortSha(null)).toBe('<none>');
    expect(shortSha(undefined)).toBe('<none>');
  });
  it('returns the input unchanged when not sha256 shape', () => {
    expect(shortSha('not-sha-format')).toBe('not-sha-format');
  });
});
