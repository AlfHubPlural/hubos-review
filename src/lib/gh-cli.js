/**
 * Thin wrapper around the `gh` CLI for use by pre-flight checks.
 *
 * Story: CICD-002-C (AC-6 — every shell call goes through an injected `execFn`
 * so tests can mock without touching the network).
 *
 * Design:
 *   - All public functions accept `execFn` for dependency injection (Story B
 *     pattern). Default `execFn` uses `node:child_process` synchronously.
 *   - "Result" objects: `{ ok: boolean, stdout: string, stderr: string,
 *     exitCode: number, error?: Error }`. Mirrors the Story B convention so
 *     check functions don't need to handle thrown errors from the wrapper.
 *   - No network calls happen in this module — everything shells out to `gh`.
 *
 * Why not use `execa`? Story B Dev Notes are explicit: stay on Node built-ins
 * to keep the dependency surface to commander + vitest only. `spawnSync` is
 * sufficient and avoids quoting headaches that `execSync` introduces.
 */

import { spawnSync } from 'node:child_process';

/**
 * @typedef {Object} ExecResult
 * @property {boolean} ok        true when exit code is 0
 * @property {string}  stdout    captured stdout (utf8)
 * @property {string}  stderr    captured stderr (utf8)
 * @property {number}  exitCode  process exit code (or 1 on spawn error)
 * @property {Error}   [error]   set when spawn itself failed (gh not installed, etc.)
 */

/**
 * Default executor used in production. Synchronous on purpose — pre-flight
 * checks are sequential per check function and the round-trips are short.
 * The dispatcher in `verify.js` runs checks concurrently via Promise.all,
 * which delegates to the JS event loop without needing async exec.
 *
 * @param {string} bin       command to spawn (e.g. 'gh' or 'git')
 * @param {string[]} args    arguments
 * @param {{ cwd?: string }} [opts]
 * @returns {ExecResult}
 */
export function defaultExec(bin, args, opts = {}) {
  const result = spawnSync(bin, args, {
    cwd: opts.cwd,
    encoding: 'utf8',
    // Capture both streams; do not inherit stdin so `gh` cannot prompt.
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error) {
    return {
      ok: false,
      stdout: '',
      stderr: result.error.message,
      exitCode: 1,
      error: result.error,
    };
  }
  return {
    ok: result.status === 0,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    exitCode: result.status ?? 1,
  };
}

/**
 * Build a tiny client object bound to a specific exec function. Letting each
 * check function instantiate its own client keeps mocks trivially scoped:
 *
 *   const gh = createGhCli({ execFn: myMock });
 *
 * @param {{ execFn?: (bin: string, args: string[], opts?: object) => ExecResult }} [opts]
 */
export function createGhCli({ execFn = defaultExec } = {}) {
  return {
    /**
     * Run `gh <args...>` with no implicit JSON parsing.
     */
    gh(args, opts = {}) {
      return execFn('gh', args, opts);
    },

    /**
     * Run `gh api <endpoint> [extra args]`. Returns parsed JSON on success,
     * else `{ ok: false, error }`. Pass `--jq` via extraArgs if you want
     * the bot-side filter to apply before parse.
     *
     * @param {string} endpoint  e.g. '/repos/owner/repo'
     * @param {string[]} [extraArgs]
     * @returns {{ ok: boolean, json?: any, raw?: string, stderr?: string, exitCode?: number }}
     */
    ghApi(endpoint, extraArgs = []) {
      const res = execFn('gh', ['api', endpoint, ...extraArgs]);
      if (!res.ok) {
        return { ok: false, stderr: res.stderr, exitCode: res.exitCode };
      }
      // `gh api` may emit empty body for some endpoints — treat that as null.
      if (!res.stdout || res.stdout.trim() === '') {
        return { ok: true, json: null, raw: res.stdout };
      }
      try {
        return { ok: true, json: JSON.parse(res.stdout), raw: res.stdout };
      } catch {
        // Not JSON — caller may still want the raw string.
        return { ok: true, json: null, raw: res.stdout };
      }
    },

    /**
     * Run `gh auth status`. Note: `gh auth status` writes to stderr by default
     * even on success — we collapse both streams into a single text blob so
     * the gh-auth check can scan once.
     *
     * @returns {{ ok: boolean, text: string, exitCode: number }}
     */
    ghAuthStatus() {
      const res = execFn('gh', ['auth', 'status']);
      return {
        ok: res.ok,
        text: (res.stdout || '') + (res.stderr || ''),
        exitCode: res.exitCode,
      };
    },

    /**
     * Extract `{ owner, repo }` from `git remote get-url origin` inside the
     * given target directory. Returns `null` when the remote is missing or
     * not a GitHub URL.
     *
     * @param {string} targetDir
     * @returns {{ owner: string, repo: string, remoteUrl: string } | null}
     */
    getGitHubRemote(targetDir) {
      const res = execFn('git', ['remote', 'get-url', 'origin'], { cwd: targetDir });
      if (!res.ok) return null;
      const url = (res.stdout || '').trim();
      return parseGitHubRemote(url);
    },
  };
}

/**
 * Pure parser, exported for testing in isolation. Handles the four common
 * remote URL shapes:
 *
 *   - git@github.com:Owner/Repo.git
 *   - https://github.com/Owner/Repo.git
 *   - https://github.com/Owner/Repo
 *   - ssh://git@github.com/Owner/Repo.git
 *
 * @param {string} url
 * @returns {{ owner: string, repo: string, remoteUrl: string } | null}
 */
export function parseGitHubRemote(url) {
  if (!url || typeof url !== 'string') return null;
  const trimmed = url.trim();
  // Strict regex: must contain github.com and capture owner/repo.
  // Both `:owner/repo` (ssh shorthand) and `/owner/repo` (https/ssh long) work.
  const m = trimmed.match(/github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/);
  if (!m) return null;
  const [, owner, repo] = m;
  // Reject obviously malformed pieces (defensive — gh refuses anyway).
  if (!owner || !repo) return null;
  return { owner, repo, remoteUrl: trimmed };
}
