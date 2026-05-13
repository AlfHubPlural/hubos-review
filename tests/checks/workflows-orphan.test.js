/**
 * Unit tests for `src/checks/workflows-orphan.js` (C7).
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import checkWorkflowsOrphan from '../../src/checks/workflows-orphan.js';

/** @type {string[]} */
const dirs = [];
function tmpDir() {
  const d = mkdtempSync(join(tmpdir(), 'hubos-review-orphan-test-'));
  dirs.push(d);
  return d;
}

afterEach(() => {
  while (dirs.length > 0) {
    try {
      rmSync(dirs.pop(), { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
});

describe('checkWorkflowsOrphan (C7)', () => {
  it('PASS when no .github/workflows directory', async () => {
    const targetDir = tmpDir();
    const r = await checkWorkflowsOrphan({ targetDir });
    expect(r.id).toBe('C7');
    expect(r.severity).toBe('LOW');
    expect(r.status).toBe('PASS');
    expect(r.blocking).toBe(false);
  });

  it('PASS when only codex-gate.yml exists', async () => {
    const targetDir = tmpDir();
    mkdirSync(join(targetDir, '.github', 'workflows'), { recursive: true });
    writeFileSync(join(targetDir, '.github', 'workflows', 'codex-gate.yml'), '');
    const r = await checkWorkflowsOrphan({ targetDir });
    expect(r.status).toBe('PASS');
  });

  it('WARN when other workflows exist', async () => {
    const targetDir = tmpDir();
    mkdirSync(join(targetDir, '.github', 'workflows'), { recursive: true });
    writeFileSync(join(targetDir, '.github', 'workflows', 'ci.yml'), '');
    writeFileSync(join(targetDir, '.github', 'workflows', 'release.yaml'), '');
    writeFileSync(join(targetDir, '.github', 'workflows', 'codex-gate.yml'), '');
    const r = await checkWorkflowsOrphan({ targetDir });
    expect(r.status).toBe('WARN');
    expect(r.blocking).toBe(false);
    expect(r.evidence.otherWorkflows).toEqual(['ci.yml', 'release.yaml']);
  });

  it('PASS when empty workflows directory', async () => {
    const targetDir = tmpDir();
    mkdirSync(join(targetDir, '.github', 'workflows'), { recursive: true });
    const r = await checkWorkflowsOrphan({ targetDir });
    expect(r.status).toBe('PASS');
  });
});
