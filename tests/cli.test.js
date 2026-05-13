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
import { buildProgram } from '../src/cli.js';
import { install } from '../src/commands/install.js';
import { update } from '../src/commands/update.js';
import { status } from '../src/commands/status.js';
import { verify } from '../src/commands/verify.js';

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

  describe('install stub (AC-4)', () => {
    it('prints stub message and returns exit 0 with default gate', async () => {
      const { stdout, exitCode } = await runCli(['install']);
      expect(exitCode).toBe(0);
      expect(stdout).toContain('install codex-gate');
      expect(stdout).toContain('Story B');
      expect(stdout).toContain('Not yet implemented');
    });

    it('accepts explicit gate-name argument', async () => {
      const { stdout, exitCode } = await runCli(['install', 'codex-gate']);
      expect(exitCode).toBe(0);
      expect(stdout).toContain('install codex-gate');
    });

    it('passes --force flag through to the stub message', async () => {
      const { stdout, exitCode } = await runCli(['install', 'codex-gate', '--force']);
      expect(exitCode).toBe(0);
      expect(stdout).toContain('--force');
    });
  });

  describe('update stub (AC-5)', () => {
    it('prints stub message and returns exit 0', async () => {
      const { stdout, exitCode } = await runCli(['update']);
      expect(exitCode).toBe(0);
      expect(stdout).toContain('Story E');
      expect(stdout).toContain('Not yet implemented');
    });
  });

  describe('status stub (AC-6)', () => {
    it('prints stub message and returns exit 0', async () => {
      const { stdout, exitCode } = await runCli(['status']);
      expect(exitCode).toBe(0);
      expect(stdout).toContain('Story E');
      expect(stdout).toContain('Not yet implemented');
    });
  });

  describe('verify stub (AC-7)', () => {
    it('prints stub message and returns exit 0', async () => {
      const { stdout, exitCode } = await runCli(['verify']);
      expect(exitCode).toBe(0);
      expect(stdout).toContain('Story C');
      expect(stdout).toContain('Not yet implemented');
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

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it('install() returns 0 and points to Story B', () => {
    const rc = install({ gate: 'codex-gate' });
    expect(rc).toBe(0);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Story B'));
  });

  it('install() with no args uses default gate', () => {
    const rc = install();
    expect(rc).toBe(0);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('codex-gate'));
  });

  it('update() returns 0 and points to Story E', () => {
    const rc = update();
    expect(rc).toBe(0);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Story E'));
  });

  it('status() returns 0 and points to Story E', () => {
    const rc = status();
    expect(rc).toBe(0);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Story E'));
  });

  it('verify() returns 0 and points to Story C', () => {
    const rc = verify();
    expect(rc).toBe(0);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Story C'));
  });
});
