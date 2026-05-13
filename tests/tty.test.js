/**
 * Unit tests for src/lib/tty.js.
 *
 * Story: CICD-002-D — AC-1 (TTY detection), AC-2 (interactive prompt).
 *
 * Strategy: never touch real process.stdin/stdout — every test injects fake
 * streams and a fake `createInterfaceFn`. Coverage targets:
 *   - isInteractive() truth table (both, only stdout, only stdin, neither)
 *   - promptYesNo: default Y on empty, explicit y/n, case-insensitive,
 *     wandering keystroke falls back to default, defaultYes=false suffix
 *   - rl.close() is always called (no leaked handles)
 */

import { describe, it, expect, vi } from 'vitest';
import { createTtyHelpers } from '../src/lib/tty.js';

/**
 * Make a fake readline-like interface. Resolves `rl.question(prompt, cb)` by
 * invoking `cb` synchronously with the pre-programmed answer. Records calls.
 */
function makeFakeReadline(answer) {
  const closed = { value: false };
  const calls = [];
  const factory = (opts) => {
    return {
      _opts: opts,
      question(prompt, cb) {
        calls.push({ prompt });
        // schedule asynchronously to mirror real readline behavior
        Promise.resolve().then(() => cb(answer));
      },
      close() {
        closed.value = true;
      },
    };
  };
  return { factory, closed, calls };
}

function fakeStream({ isTTY }) {
  return { isTTY };
}

describe('createTtyHelpers — isInteractive()', () => {
  it('returns true when both stdin and stdout are TTY', () => {
    const helpers = createTtyHelpers({
      stdin: fakeStream({ isTTY: true }),
      stdout: fakeStream({ isTTY: true }),
    });
    expect(helpers.isInteractive()).toBe(true);
  });

  it('returns false when only stdout is TTY (pipe into stdin)', () => {
    const helpers = createTtyHelpers({
      stdin: fakeStream({ isTTY: false }),
      stdout: fakeStream({ isTTY: true }),
    });
    expect(helpers.isInteractive()).toBe(false);
  });

  it('returns false when only stdin is TTY (output redirected)', () => {
    const helpers = createTtyHelpers({
      stdin: fakeStream({ isTTY: true }),
      stdout: fakeStream({ isTTY: false }),
    });
    expect(helpers.isInteractive()).toBe(false);
  });

  it('returns false when neither is TTY (CI)', () => {
    const helpers = createTtyHelpers({
      stdin: fakeStream({ isTTY: false }),
      stdout: fakeStream({ isTTY: false }),
    });
    expect(helpers.isInteractive()).toBe(false);
  });

  it('returns false when isTTY is undefined (Node default for non-TTY)', () => {
    const helpers = createTtyHelpers({
      stdin: fakeStream({ isTTY: undefined }),
      stdout: fakeStream({ isTTY: undefined }),
    });
    expect(helpers.isInteractive()).toBe(false);
  });
});

describe('createTtyHelpers — promptYesNo()', () => {
  it('returns true when user just hits Enter and default is Y', async () => {
    const { factory, closed, calls } = makeFakeReadline('');
    const helpers = createTtyHelpers({
      stdin: fakeStream({ isTTY: true }),
      stdout: fakeStream({ isTTY: true }),
      createInterfaceFn: factory,
    });
    const ans = await helpers.promptYesNo('Configure protection?', true);
    expect(ans).toBe(true);
    expect(closed.value).toBe(true);
    expect(calls[0].prompt).toContain('[Y/n]');
  });

  it('returns false when default is N and user hits Enter', async () => {
    const { factory } = makeFakeReadline('');
    const helpers = createTtyHelpers({
      stdin: fakeStream({ isTTY: true }),
      stdout: fakeStream({ isTTY: true }),
      createInterfaceFn: factory,
    });
    const ans = await helpers.promptYesNo('Are you sure?', false);
    expect(ans).toBe(false);
  });

  it('returns true on explicit "y"', async () => {
    const { factory } = makeFakeReadline('y');
    const helpers = createTtyHelpers({
      stdin: fakeStream({ isTTY: true }),
      stdout: fakeStream({ isTTY: true }),
      createInterfaceFn: factory,
    });
    expect(await helpers.promptYesNo('?', false)).toBe(true);
  });

  it('returns true on "Yes" (case-insensitive)', async () => {
    const { factory } = makeFakeReadline('Yes please');
    const helpers = createTtyHelpers({
      stdin: fakeStream({ isTTY: true }),
      stdout: fakeStream({ isTTY: true }),
      createInterfaceFn: factory,
    });
    expect(await helpers.promptYesNo('?', false)).toBe(true);
  });

  it('returns false on explicit "n"', async () => {
    const { factory } = makeFakeReadline('n');
    const helpers = createTtyHelpers({
      stdin: fakeStream({ isTTY: true }),
      stdout: fakeStream({ isTTY: true }),
      createInterfaceFn: factory,
    });
    expect(await helpers.promptYesNo('?', true)).toBe(false);
  });

  it('returns false on "NO"', async () => {
    const { factory } = makeFakeReadline('NO');
    const helpers = createTtyHelpers({
      stdin: fakeStream({ isTTY: true }),
      stdout: fakeStream({ isTTY: true }),
      createInterfaceFn: factory,
    });
    expect(await helpers.promptYesNo('?', true)).toBe(false);
  });

  it('trims whitespace before deciding', async () => {
    const { factory } = makeFakeReadline('   y   ');
    const helpers = createTtyHelpers({
      stdin: fakeStream({ isTTY: true }),
      stdout: fakeStream({ isTTY: true }),
      createInterfaceFn: factory,
    });
    expect(await helpers.promptYesNo('?', false)).toBe(true);
  });

  it('falls back to default on wandering keystroke (e.g., "x")', async () => {
    const { factory } = makeFakeReadline('x');
    const helpers = createTtyHelpers({
      stdin: fakeStream({ isTTY: true }),
      stdout: fakeStream({ isTTY: true }),
      createInterfaceFn: factory,
    });
    expect(await helpers.promptYesNo('?', true)).toBe(true);
    expect(await helpers.promptYesNo('?', false)).toBe(false);
  });

  it('suffix shows [y/N] when defaultYes is false', async () => {
    const { factory, calls } = makeFakeReadline('y');
    const helpers = createTtyHelpers({
      stdin: fakeStream({ isTTY: true }),
      stdout: fakeStream({ isTTY: true }),
      createInterfaceFn: factory,
    });
    await helpers.promptYesNo('Are you sure?', false);
    expect(calls[0].prompt).toContain('[y/N]');
  });

  it('rejects when createInterface throws synchronously', async () => {
    const factory = () => {
      throw new Error('readline boom');
    };
    const helpers = createTtyHelpers({
      stdin: fakeStream({ isTTY: true }),
      stdout: fakeStream({ isTTY: true }),
      createInterfaceFn: factory,
    });
    await expect(helpers.promptYesNo('?', true)).rejects.toThrow('readline boom');
  });

  it('uses the default question suffix', async () => {
    const { factory, calls } = makeFakeReadline('');
    const helpers = createTtyHelpers({
      stdin: fakeStream({ isTTY: true }),
      stdout: fakeStream({ isTTY: true }),
      createInterfaceFn: factory,
    });
    await helpers.promptYesNo('Configure branch protection?');
    expect(calls[0].prompt).toMatch(/^Configure branch protection\? \[Y\/n\] $/);
  });

  it('does not leak rl when close() throws (best-effort cleanup)', async () => {
    const factory = () => ({
      question(_prompt, cb) {
        Promise.resolve().then(() => cb('y'));
      },
      close() {
        throw new Error('close failed');
      },
    });
    const helpers = createTtyHelpers({
      stdin: fakeStream({ isTTY: true }),
      stdout: fakeStream({ isTTY: true }),
      createInterfaceFn: factory,
    });
    // Should resolve normally despite close() throwing.
    await expect(helpers.promptYesNo('?', true)).resolves.toBe(true);
  });
});

describe('default helpers', () => {
  it('module exports defaultTty wired to real readline (smoke)', async () => {
    // Don't actually call promptYesNo — we just want to confirm the export
    // is callable shape-wise. isInteractive() is harmless to call.
    const mod = await import('../src/lib/tty.js');
    expect(typeof mod.defaultTty.isInteractive).toBe('function');
    expect(typeof mod.defaultTty.promptYesNo).toBe('function');
    // Calling isInteractive() should not throw; result depends on the env.
    expect(() => mod.defaultTty.isInteractive()).not.toThrow();
  });
});

// Quiet "vi" reference for ESLint when it's not used by an explicit mock.
void vi;
