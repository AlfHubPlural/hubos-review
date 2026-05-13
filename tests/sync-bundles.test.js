/**
 * Tests for `scripts/sync-bundles.mjs` integrity + drift checks.
 *
 * Strategy: invoke the script as a subprocess via `node ...` so the test
 * exercises argv parsing, exit codes, and stdout/stderr exactly as the
 * `prepublishOnly` hook will. Tampering tests use a temp clone of the
 * bundle directory + manifest so the real `bundles/codex-gate/v1/` is
 * never modified.
 *
 * Coverage maps to Story CICD-002-B AC-5 + AC-6.
 */

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  copyFileSync,
  rmSync,
  cpSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const SCRIPT = join(REPO_ROOT, 'scripts', 'sync-bundles.mjs');

function runScript(args, cwd = REPO_ROOT) {
  const result = spawnSync('node', [SCRIPT, ...args], {
    cwd,
    encoding: 'utf8',
  });
  return {
    code: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

describe('sync-bundles.mjs', () => {
  it('--check passes on the real bundle (integrity)', () => {
    const { code, stdout } = runScript(['--check']);
    expect(code).toBe(0);
    expect(stdout).toMatch(/OK codex-gate\/v1/);
  });

  it('--source-root against hub-os passes drift check (when hub-os exists)', () => {
    const hubOsPath = '/Users/alfredojr/Projetos/00_Projetos/hub-os';
    // Skip silently if the developer machine layout differs.
    const { code, stdout, stderr } = runScript(['--source-root', hubOsPath]);
    if (stderr.match(/source-root path does not exist/)) {
      // Expected on CI / other machines — not a failure for this story.
      return;
    }
    expect(code).toBe(0);
    expect(stdout).toMatch(/integrity \+ drift/);
  });

  it('--help prints usage and exits 0', () => {
    const { code, stdout } = runScript(['--help']);
    expect(code).toBe(0);
    expect(stdout).toMatch(/USAGE/);
    expect(stdout).toMatch(/--source-root/);
  });

  it('unknown flag exits 2', () => {
    const { code, stderr } = runScript(['--nonsense']);
    expect(code).toBe(2);
    expect(stderr).toMatch(/Unknown argument/);
  });

  it('detects integrity divergence when a bundle file is tampered', () => {
    // Build a sandbox copy of the whole repo's `bundles/` + `scripts/` + `package.json`
    // so we can mutate the bundle without affecting the real one. To stay light,
    // we instead copy `scripts/sync-bundles.mjs` AND just the bundle dir into a
    // tmp dir that mimics REPO_ROOT.
    const sandbox = mkdtempSync(join(tmpdir(), 'sync-bundles-tamper-'));
    try {
      mkdirSync(join(sandbox, 'scripts'));
      copyFileSync(SCRIPT, join(sandbox, 'scripts', 'sync-bundles.mjs'));
      // Replicate bundles/codex-gate/v1/ inside the sandbox.
      const realBundle = join(REPO_ROOT, 'bundles', 'codex-gate', 'v1');
      const sandboxBundle = join(sandbox, 'bundles', 'codex-gate', 'v1');
      mkdirSync(sandboxBundle, { recursive: true });
      cpSync(realBundle, sandboxBundle, { recursive: true });
      // Tamper one file (the workflow).
      writeFileSync(
        join(sandboxBundle, 'codex-gate.yml'),
        readFileSync(join(sandboxBundle, 'codex-gate.yml'), 'utf8') + '\n# tampered\n',
        'utf8',
      );

      const sandboxScript = join(sandbox, 'scripts', 'sync-bundles.mjs');
      const result = spawnSync('node', [sandboxScript, '--check'], {
        cwd: sandbox,
        encoding: 'utf8',
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/INTEGRITY codex-gate\/v1 :: codex-gate\.yml/);
      expect(result.stderr).toMatch(/expected: sha256:14ad66b1/);
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });
});
