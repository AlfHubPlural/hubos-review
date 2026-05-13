/**
 * npm registry client for hubos-review.
 *
 * Story: CICD-002-E (AC-1, AC-3, AC-5, AC-7).
 *
 * Design:
 *   - Single responsibility: discover the latest version of a published npm
 *     package via `npm view <pkg> version --json`. No HTTP fetch — defers to
 *     the user's npm CLI configuration (proxy, registry, auth) to keep this
 *     module zero-dep and consistent with the rest of the CLI.
 *   - Test-friendly: every shell call is routed through an injectable
 *     `execFn` (same pattern as Stories B/C/D). Tests never hit the network.
 *   - Graceful offline mode: if `npm view` times out, fails to spawn, or
 *     emits non-JSON, the helper returns `{ status: 'offline', version: null }`
 *     so callers can render an "offline — could not check registry" line
 *     without crashing.
 *   - Per-session memoization: `createRegistryClient()` returns a tiny client
 *     with an internal Map cache keyed by package name. The same package is
 *     never queried twice in one process — important for `status` and
 *     `update` which may both call it during a single command.
 */

import { spawnSync } from 'node:child_process';

/**
 * Default executor — mirrors `defaultExec` from gh-cli.js. Synchronous on
 * purpose: the call site (`status`, `update`) is already async at the
 * command level but the registry lookup is a single short round-trip.
 *
 * @param {string} bin
 * @param {string[]} args
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {{ ok: boolean, stdout: string, stderr: string, exitCode: number, timedOut?: boolean }}
 */
export function defaultExec(bin, args, opts = {}) {
  const result = spawnSync(bin, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: opts.timeoutMs ?? 5000,
  });
  if (result.error) {
    return {
      ok: false,
      stdout: '',
      stderr: result.error.message,
      exitCode: 1,
      timedOut: result.error.code === 'ETIMEDOUT' || result.error.code === 'ETIME',
    };
  }
  return {
    ok: result.status === 0,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    exitCode: result.status ?? 1,
    timedOut: result.signal === 'SIGTERM' && (result.status === null || result.status === undefined),
  };
}

/**
 * @typedef {Object} RegistryLookup
 * @property {'online' | 'offline'} status
 * @property {string|null} version   semver string when online, null when offline
 * @property {string} [error]        short diagnostic when offline
 */

/**
 * Build a registry client bound to a specific exec function. Per-instance
 * cache prevents duplicate `npm view` calls within a single CLI invocation.
 *
 * Usage:
 *   const registry = createRegistryClient();
 *   const { status, version } = await registry.getLatestVersion('@hubplural/hubos-review');
 *
 * @param {object} [opts]
 * @param {Function} [opts.execFn]  defaults to defaultExec
 * @param {number}   [opts.timeoutMs] defaults to 5000
 * @returns {{
 *   getLatestVersion: (packageName: string, options?: { offline?: boolean }) => Promise<RegistryLookup>,
 *   clearCache: () => void
 * }}
 */
export function createRegistryClient(opts = {}) {
  const execFn = opts.execFn ?? defaultExec;
  const timeoutMs = opts.timeoutMs ?? 5000;
  const cache = new Map();

  return {
    async getLatestVersion(packageName, options = {}) {
      if (options.offline === true) {
        return { status: 'offline', version: null };
      }
      if (cache.has(packageName)) {
        return cache.get(packageName);
      }
      const result = await fetchOnce(execFn, packageName, timeoutMs);
      cache.set(packageName, result);
      return result;
    },
    clearCache() {
      cache.clear();
    },
  };
}

/**
 * One-shot registry lookup. Kept as a free function so callers that don't
 * need caching (rare) can use it directly. Honors injected execFn so tests
 * stay hermetic.
 *
 * @param {Function} execFn
 * @param {string} packageName
 * @param {number} timeoutMs
 * @returns {Promise<RegistryLookup>}
 */
async function fetchOnce(execFn, packageName, timeoutMs) {
  let res;
  try {
    // `--prefer-online` ensures we bypass the local npm cache so a recently
    // published version is visible. `--json` makes the output a JSON-encoded
    // string (or array for ambiguous specs — we only ask for `version`).
    res = await execFn('npm', ['view', packageName, 'version', '--json', '--prefer-online'], {
      timeoutMs,
    });
  } catch (err) {
    return { status: 'offline', version: null, error: err?.message ?? 'spawn failed' };
  }
  if (!res || res.timedOut) {
    return { status: 'offline', version: null, error: 'timeout' };
  }
  if (!res.ok) {
    return {
      status: 'offline',
      version: null,
      error: res.stderr?.trim() || `npm exit ${res.exitCode}`,
    };
  }
  const out = (res.stdout ?? '').trim();
  if (!out) {
    return { status: 'offline', version: null, error: 'empty registry response' };
  }
  try {
    const parsed = JSON.parse(out);
    // `npm view <pkg> version --json` returns a bare string for unambiguous
    // package@latest. For ranges/dist-tags it may return an object — we just
    // take the latest string if present.
    if (typeof parsed === 'string') {
      return { status: 'online', version: parsed };
    }
    if (parsed && typeof parsed === 'object') {
      // Some npm versions return { "latest": "x.y.z" } or an array of versions.
      if (typeof parsed.latest === 'string') {
        return { status: 'online', version: parsed.latest };
      }
      if (Array.isArray(parsed) && parsed.length > 0) {
        const last = parsed[parsed.length - 1];
        if (typeof last === 'string') {
          return { status: 'online', version: last };
        }
      }
    }
    return { status: 'offline', version: null, error: 'unexpected JSON shape' };
  } catch (err) {
    return {
      status: 'offline',
      version: null,
      error: `invalid JSON from npm view: ${err.message}`,
    };
  }
}

/**
 * Compare two semver-ish version strings. Returns:
 *   -1 if a < b
 *    0 if a == b (or unparseable)
 *    1 if a > b
 *
 * Pure helper for `status` / `update` to detect "newer available". Handles
 * the three-part semver (no pre-release suffix support — package.json on
 * this CLI uses simple major.minor.patch per D-002-13).
 *
 * @param {string} a
 * @param {string} b
 * @returns {-1 | 0 | 1}
 */
export function compareVersions(a, b) {
  if (a === b) return 0;
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i++) {
    if (pa[i] < pb[i]) return -1;
    if (pa[i] > pb[i]) return 1;
  }
  return 0;
}

/**
 * Parse `1.2.3` → `[1, 2, 3]`. Pre-release suffixes (`-beta.1`) are stripped
 * before comparison — `update` doesn't need pre-release precedence today.
 *
 * @param {string} v
 * @returns {number[] | null}
 */
export function parseSemver(v) {
  if (typeof v !== 'string') return null;
  const cleaned = v.split('-')[0].split('+')[0];
  const parts = cleaned.split('.');
  if (parts.length < 3) return null;
  const nums = parts.slice(0, 3).map((p) => Number.parseInt(p, 10));
  if (nums.some((n) => !Number.isFinite(n))) return null;
  return nums;
}
