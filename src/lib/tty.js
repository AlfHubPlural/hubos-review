/**
 * TTY detection + interactive prompt helpers.
 *
 * Story: CICD-002-D — AC-1 (TTY auto-detect), AC-2 (interactive prompt).
 *
 * The helpers are factored as a `createTtyHelpers(...)` factory so that
 * unit tests can inject fake stdin/stdout streams and a fake readline
 * module without touching `process.stdin.isTTY` globally. The default
 * factory (`defaultTty()`) wires up the real Node primitives and is what
 * the `install` command uses in production.
 *
 * Design choices:
 *   - Native `readline` (no `inquirer` dep) — AC-2 explicit no-extra-dep.
 *   - `isInteractive()` requires BOTH stdout AND stdin to be TTY. A pipe
 *     into stdin (e.g. `echo y | hubos-review install`) is NON-TTY by
 *     design — the install matrix wants those flows to auto-apply or
 *     respect `--skip-protection`.
 *   - `promptYesNo` honors a `defaultYes` flag. Empty answer (just Enter)
 *     resolves to the default; "y"/"yes" (case-insensitive) is YES;
 *     anything else is NO. Whitespace is trimmed.
 */

import { createInterface } from 'node:readline';

/**
 * Build a TTY helpers bundle. Defaults to the real `process` + `readline`
 * but every dependency is injectable so tests can supply fakes.
 *
 * @param {object} [deps]
 * @param {NodeJS.ReadStream} [deps.stdin] defaults to `process.stdin`
 * @param {NodeJS.WriteStream} [deps.stdout] defaults to `process.stdout`
 * @param {(opts: { input: any, output: any }) => any} [deps.createInterfaceFn]
 *   defaults to readline.createInterface
 * @returns {{ isInteractive: () => boolean, promptYesNo: (question: string, defaultYes?: boolean) => Promise<boolean> }}
 */
export function createTtyHelpers(deps = {}) {
  const stdin = deps.stdin ?? process.stdin;
  const stdout = deps.stdout ?? process.stdout;
  const createInterfaceFn = deps.createInterfaceFn ?? createInterface;

  function isInteractive() {
    // Both streams must be TTY. A pipe into stdin or a redirected stdout
    // means we are running in a non-interactive context (CI, script).
    return Boolean(stdout && stdout.isTTY) && Boolean(stdin && stdin.isTTY);
  }

  /**
   * Ask a yes/no question. Returns a Promise<boolean>.
   *
   * Empty input (just Enter pressed) resolves to `defaultYes`.
   * Any answer that starts with 'y' (case-insensitive) is YES, otherwise NO.
   * The suffix in the prompt is `[Y/n]` when `defaultYes=true`, else `[y/N]`.
   *
   * @param {string} question
   * @param {boolean} [defaultYes] defaults to true
   * @returns {Promise<boolean>}
   */
  async function promptYesNo(question, defaultYes = true) {
    const suffix = defaultYes ? '[Y/n]' : '[y/N]';
    return new Promise((resolve, reject) => {
      let rl;
      try {
        rl = createInterfaceFn({ input: stdin, output: stdout });
      } catch (err) {
        reject(err);
        return;
      }
      rl.question(`${question} ${suffix} `, (answer) => {
        try {
          rl.close();
        } catch {
          // ignore
        }
        const trimmed = String(answer ?? '').trim();
        if (trimmed === '') {
          resolve(defaultYes);
          return;
        }
        const first = trimmed.charAt(0).toLowerCase();
        if (first === 'y') {
          resolve(true);
        } else if (first === 'n') {
          resolve(false);
        } else {
          // Anything else → fall back to default. This matches the principle
          // of least surprise: a wandering keystroke should not silently
          // change a destructive operation.
          resolve(defaultYes);
        }
      });
    });
  }

  return { isInteractive, promptYesNo };
}

/**
 * Convenience: the default helpers bundle wired to the real process.
 * Most call sites can just import this directly.
 */
export const defaultTty = createTtyHelpers();
