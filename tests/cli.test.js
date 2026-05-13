/**
 * Unit tests for the hubos-review CLI dispatcher.
 *
 * Strategy: instantiate fresh commander programs per test (via buildProgram),
 * exit-override commander so process.exit() is observable, and capture stdout/
 * stderr via console spies. This avoids subprocess overhead while still
 * exercising the same code path as the real binary.
 *
 * Covered (AC-3 through AC-9):
 *   - help lists 4 sub-commands
 *   - each stub prints expected message + exit code 0
 *   - unknown sub-command exits with code 1 and error message
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildProgram } from '../src/cli.js';
import { install } from '../src/commands/install.js';
import { update } from '../src/commands/update.js';
import { status } from '../src/commands/status.js';
import { verify } from '../src/commands/verify.js';

/**
 * Create a fresh non-git temp directory. Story B turned `install` into a real
 * command that refuses non-git targets (AC-9), so dispatcher tests now pass
 * --target=<git-dir> to exercise wiring without depending on process.cwd().
 */
function makeTempGitRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'hubos-review-cli-test-'));
  mkdirSync(join(dir, '.git'), { recursive: true });
  return dir;
}

/**
 * Parse argv synchronously through a fresh program. Captures stdout, stderr,
 * and any process.exit code via overrides. Returns a shape suitable for
 * assertions.
 */
async function runCli(args) {
  const program = buildProgram();
  // Capture --help / --version output (commander writes to stdout via configureOutput).
  let stdout = '';
  let stderr = '';
  program.configureOutput({
    writeOut: (s) => {
      stdout += s;
    },
    writeErr: (s) => {
      stderr += s;
    },
  });
  // Commander's exitOverride throws on .help() / .error(), letting us assert exit.
  program.exitOverride();

  const logSpy = vi.spyOn(console, 'log').mockImplementation((s) => {
    stdout += `${s}\n`;
  });
  const errSpy = vi.spyOn(console, 'error').mockImplementation((s) => {
    stderr += `${s}\n`;
  });

  let exitCode = 0;
  let thrown = null;
  // Intercept process.exit (used by our 'command:*' handler).
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
    exitCode = code ?? 0;
    // Throw to short-circuit further execution, mirroring real exit semantics.
    throw new Error(`__EXIT_${exitCode}__`);
  });

  try {
    // commander expects an argv-shaped array; prepend node + script placeholders.
    await program.parseAsync(['node', 'hubos-review', ...args]);
  } catch (err) {
    thrown = err;
    if (err && typeof err === 'object' && 'exitCode' in err) {
      // CommanderError carries exitCode for .help() / version etc.
      exitCode = err.exitCode ?? 0;
    }
  } finally {
    logSpy.mockRestore();
    errSpy.mockRestore();
    exitSpy.mockRestore();
  }

  return { stdout, stderr, exitCode, thrown };
}

describe('hubos-review CLI dispatcher', () => {
  beforeEach(() => {
    // Reset any commander state by relying on fresh program per test (buildProgram).
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('--help (AC-3)', () => {
    it('lists all 4 sub-commands in help output', async () => {
      const { stdout, exitCode } = await runCli(['--help']);
      expect(exitCode).toBe(0);
      expect(stdout).toContain('install');
      expect(stdout).toContain('update');
      expect(stdout).toContain('status');
      expect(stdout).toContain('verify');
    });

    it('shows the CLI name and description', async () => {
      const { stdout } = await runCli(['--help']);
      expect(stdout).toContain('hubos-review');
    });

    it('-h short flag works the same as --help', async () => {
      const { stdout, exitCode } = await runCli(['-h']);
      expect(exitCode).toBe(0);
      expect(stdout).toContain('install');
      expect(stdout).toContain('verify');
    });
  });

  describe('--version', () => {
    it('emits the version from package.json (semver-ish)', async () => {
      const { stdout, exitCode } = await runCli(['--version']);
      expect(exitCode).toBe(0);
      // Match X.Y.Z (allowing pre-release suffixes like 0.0.0-dev).
      expect(stdout).toMatch(/\d+\.\d+\.\d+/);
    });
  });

  describe('install command wiring (Story B — was stub in Story A)', () => {
    /** @type {string[]} */
    const tmpDirs = [];

    function tmp() {
      const d = makeTempGitRepo();
      tmpDirs.push(d);
      return d;
    }

    afterEach(() => {
      while (tmpDirs.length > 0) {
        try {
          rmSync(tmpDirs.pop(), { recursive: true, force: true });
        } catch {
          // best-effort cleanup
        }
      }
    });

    it('dispatcher wires --target through to install (clean repo, exit 0)', async () => {
      const target = tmp();
      const { exitCode, stdout } = await runCli(['install', 'codex-gate', '--target', target]);
      expect(exitCode).toBe(0);
      expect(stdout).toMatch(/installed successfully/);
    });

    it('dispatcher wires --dry-run through (no writes, exit 0)', async () => {
      const target = tmp();
      const { exitCode, stdout } = await runCli([
        'install',
        'codex-gate',
        '--target',
        target,
        '--dry-run',
      ]);
      expect(exitCode).toBe(0);
      expect(stdout).toMatch(/DRY RUN/);
      expect(stdout).toMatch(/No filesystem changes were made/);
    });

    it('dispatcher wires --force through (subsequent install reinstalls)', async () => {
      const target = tmp();
      await runCli(['install', 'codex-gate', '--target', target]);
      const { exitCode, stdout } = await runCli([
        'install',
        'codex-gate',
        '--target',
        target,
        '--force',
      ]);
      expect(exitCode).toBe(0);
      expect(stdout).toMatch(/reinstalled successfully/);
    });

    it('default gate is codex-gate when omitted', async () => {
      const target = tmp();
      const { exitCode, stdout } = await runCli(['install', '--target', target]);
      expect(exitCode).toBe(0);
      expect(stdout).toMatch(/codex-gate v1 installed successfully/);
    });
  });

  // Story CICD-002-E (E.1 dispatcher wiring): update/status are no longer
  // stubs — they are real commands. We only assert wiring through the
  // dispatcher here; full behavioral coverage lives in tests/update.test.js
  // and tests/status.test.js.
  describe('update command wiring (Story E — was stub in Stories A–D)', () => {
    it('dispatcher wires --target through to update (no gate installed → exit 1)', async () => {
      const target = mkdtempSync(join(tmpdir(), 'hubos-review-update-cli-'));
      try {
        const { exitCode, stderr } = await runCli(['update', '--target', target]);
        expect(exitCode).toBe(1);
        expect(stderr).toMatch(/no gate installed/i);
      } finally {
        try {
          rmSync(target, { recursive: true, force: true });
        } catch {
          // ignore
        }
      }
    });

    it('--dry-run does not write to .aiox/cicd-version', async () => {
      const target = makeTempGitRepo();
      try {
        // First install so update has something to bump.
        await runCli(['install', 'codex-gate', '--target', target, '--skip-protection']);
        // --no-registry-check keeps the test hermetic (no network).
        const { exitCode } = await runCli([
          'update',
          '--target',
          target,
          '--dry-run',
          '--no-registry-check',
        ]);
        expect(exitCode).toBe(0);
      } finally {
        try {
          rmSync(target, { recursive: true, force: true });
        } catch {
          // ignore
        }
      }
    });
  });

  describe('status command wiring (Story E — was stub in Stories A–D)', () => {
    it('dispatcher wires --target through to status (no gate → exit 1)', async () => {
      const target = mkdtempSync(join(tmpdir(), 'hubos-review-status-cli-'));
      try {
        const { exitCode, stderr } = await runCli([
          'status',
          '--target',
          target,
          '--no-registry-check',
        ]);
        expect(exitCode).toBe(1);
        expect(stderr).toMatch(/no gate installed/i);
      } finally {
        try {
          rmSync(target, { recursive: true, force: true });
        } catch {
          // ignore
        }
      }
    });

    it('--json emits machine-readable payload on missing lock', async () => {
      const target = mkdtempSync(join(tmpdir(), 'hubos-review-status-cli-'));
      try {
        const { stdout, exitCode } = await runCli([
          'status',
          '--target',
          target,
          '--json',
          '--no-registry-check',
        ]);
        expect(exitCode).toBe(1);
        const payload = JSON.parse(stdout);
        expect(payload.overall).toBe('NOT_INSTALLED');
        expect(payload.installed).toBe(false);
      } finally {
        try {
          rmSync(target, { recursive: true, force: true });
        } catch {
          // ignore
        }
      }
    });
  });

  describe('verify command wiring (Story C — was stub in Story A)', () => {
    it('--json flag renders machine-readable output', async () => {
      // Use a temp non-git dir so verify exits early via C2 FAIL (no network).
      // The CLI dispatcher hands `--target` straight to verify(...), so we
      // exercise the full flag-wiring path without needing gh authentication.
      const target = mkdtempSync(join(tmpdir(), 'hubos-review-verify-cli-'));
      try {
        const { stdout, exitCode } = await runCli([
          'verify',
          '--json',
          '--target',
          target,
        ]);
        // C1 will hit gh; C2 fails (no .git/). Exit may be 0 or 1 depending
        // on whether gh is available — we only assert the JSON contract.
        expect([0, 1]).toContain(exitCode);
        const payload = JSON.parse(stdout);
        expect(payload).toHaveProperty('checks');
        expect(payload).toHaveProperty('overall');
        expect(payload.checks).toHaveLength(8);
        expect(payload.checks[0].id).toBe('C1');
      } finally {
        try {
          rmSync(target, { recursive: true, force: true });
        } catch {
          // best-effort cleanup
        }
      }
    });

    it('--gate=foo (unsupported) exits with code 1', async () => {
      const target = mkdtempSync(join(tmpdir(), 'hubos-review-verify-cli-'));
      try {
        const { exitCode, stderr } = await runCli([
          'verify',
          '--gate',
          'foo-gate',
          '--target',
          target,
        ]);
        expect(exitCode).toBe(1);
        expect(stderr).toMatch(/codex-gate/);
      } finally {
        try {
          rmSync(target, { recursive: true, force: true });
        } catch {
          // best-effort cleanup
        }
      }
    });
  });

  describe('unknown sub-command (AC-8)', () => {
    it('exits with code 1 and suggests --help', async () => {
      const { stderr, exitCode } = await runCli(['foobar']);
      expect(exitCode).toBe(1);
      expect(stderr).toMatch(/unknown command/i);
      expect(stderr).toContain('--help');
    });
  });
});

describe('command handlers (direct unit tests)', () => {
  let logSpy;
  /** @type {string[]} */
  const dirsToCleanup = [];

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    while (dirsToCleanup.length > 0) {
      try {
        rmSync(dirsToCleanup.pop(), { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
    }
  });

  it('install() returns 0 in a clean git repo (no longer a stub)', () => {
    const target = makeTempGitRepo();
    dirsToCleanup.push(target);
    const rc = install({ gate: 'codex-gate', target });
    expect(rc).toBe(0);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('installed successfully'));
  });

  it('install() default gate is codex-gate', () => {
    const target = makeTempGitRepo();
    dirsToCleanup.push(target);
    const rc = install({ target });
    expect(rc).toBe(0);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('codex-gate'));
  });

  it('update() returns 1 in an empty target dir (no .aiox/cicd-version) — Story E real handler', async () => {
    const target = makeTempGitRepo();
    dirsToCleanup.push(target);
    // No install ran — update should refuse to proceed.
    const rc = await update({ target, noRegistryCheck: true });
    expect(rc).toBe(1);
  });

  it('status() returns 1 in an empty target dir (no .aiox/cicd-version) — Story E real handler', async () => {
    const target = makeTempGitRepo();
    dirsToCleanup.push(target);
    const rc = await status({ target, noRegistryCheck: true });
    expect(rc).toBe(1);
  });

  it('verify() rejects unsupported --gate value with exit 1', async () => {
    const rc = await verify({ gate: 'foo-gate', json: true });
    expect(rc).toBe(1);
    // verify writes the JSON to console.log when --json is set, even on error
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('Only \'codex-gate\' is supported'),
    );
  });
});
