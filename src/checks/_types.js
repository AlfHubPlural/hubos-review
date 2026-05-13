/**
 * Shared JSDoc typedefs for pre-flight checks.
 *
 * This module is intentionally side-effect-free. Check modules reference
 * the types via JSDoc `@typedef import(...)` clauses; this file's `export`
 * keeps it from being tree-shaken by ESLint as "unused".
 *
 * @typedef {Object} CheckResult
 * @property {string} id                       short identifier (e.g., 'C1', 'C5b')
 * @property {string} name                     human-readable column label
 * @property {'CRITICAL'|'HIGH'|'MEDIUM'|'LOW'} severity
 * @property {'PASS'|'FAIL'|'WARN'} status
 * @property {boolean} blocking                true when failure should flip the exit code
 * @property {string} details                  one-line description rendered in the table
 * @property {string} [remediation]            actionable hint shown below failing rows
 * @property {object} [evidence]               raw artifacts (kept for --json + debug)
 *
 * @typedef {Object} CheckContext
 * @property {string} [targetDir]              target repo path (default: process.cwd())
 * @property {string} [gateName]               gate slug (default: 'codex-gate')
 * @property {string} [bundleVersion]          bundle version slug (default: 'v1')
 * @property {string} [branch]                 protected branch name (default: 'main')
 * @property {{ owner: string, repo: string, remoteUrl: string } | null} [repoCoords]
 *           pre-resolved GitHub remote — checks downstream of C2 receive this
 *           so they don't re-shell to `git remote` each time
 * @property {ReturnType<typeof import('../lib/gh-cli.js').createGhCli>} [ghCli]
 *           shared gh-cli wrapper; pre-built by the dispatcher (and trivially
 *           swappable in tests via createGhCli({ execFn }))
 * @property {(bin: string, args: string[], opts?: object) => any} [execFn]
 *           low-level exec injector used when ghCli is not provided
 */

export const __typedef = null;
