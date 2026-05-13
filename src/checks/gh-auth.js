/**
 * C1 — `gh auth status` passes AND token has scopes `repo` and `read:org`.
 *
 * Severity: CRITICAL — without authentication, every subsequent gh-api check
 * also fails, so we report this first and let the dispatcher decide whether
 * to short-circuit.
 *
 * @typedef {import('./_types.js').CheckResult} CheckResult
 * @typedef {import('./_types.js').CheckContext} CheckContext
 */

import { createGhCli } from '../lib/gh-cli.js';

const REMEDIATION =
  "Run 'gh auth login --scopes repo,read:org' and re-authenticate. " +
  'See https://cli.github.com/manual/gh_auth_login for details.';

/**
 * @param {CheckContext} ctx
 * @returns {Promise<CheckResult>}
 */
export default async function checkGhAuth(ctx = {}) {
  const gh = ctx.ghCli ?? createGhCli({ execFn: ctx.execFn });

  const res = gh.ghAuthStatus();
  const id = 'C1';
  const name = 'gh auth + scopes';
  const severity = 'CRITICAL';

  if (!res.ok) {
    return {
      id,
      name,
      severity,
      status: 'FAIL',
      blocking: true,
      details: 'gh CLI is not authenticated (or gh is not installed).',
      remediation: REMEDIATION,
      evidence: { exitCode: res.exitCode, text: res.text },
    };
  }

  // `gh auth status` prints something like:
  //   ✓ Logged in to github.com account AlfHubPlural (keyring)
  //     - Token scopes: 'admin:public_key', 'gist', 'read:org', 'repo'
  // We parse the scopes line case-insensitively. Older gh versions used
  // "Token scopes:" without a quote style — be tolerant.
  const scopes = parseScopes(res.text);
  const missing = [];
  if (!scopes.has('repo')) missing.push('repo');
  if (!scopes.has('read:org')) missing.push('read:org');

  if (missing.length > 0) {
    return {
      id,
      name,
      severity,
      status: 'FAIL',
      blocking: true,
      details:
        `Token is authenticated but missing required scopes: ${missing.join(', ')}. ` +
        'Branch protection (Story D) and App-installation checks require these scopes.',
      remediation: REMEDIATION,
      evidence: { detectedScopes: [...scopes].sort(), missing },
    };
  }

  // Optional: extract the account login for nicer display in the table.
  const account = parseAccount(res.text);
  return {
    id,
    name,
    severity,
    status: 'PASS',
    blocking: true,
    details: `authenticated${account ? ` as ${account}` : ''} (${[...scopes].sort().join(', ')})`,
    evidence: { account, scopes: [...scopes].sort() },
  };
}

/**
 * Parse the "Token scopes:" line. Returns a Set of bare scope strings.
 * Tolerant to: single-quoted ('repo'), comma-space, leading whitespace.
 *
 * @param {string} text
 * @returns {Set<string>}
 */
export function parseScopes(text) {
  const out = new Set();
  if (!text) return out;
  const match = text.match(/Token scopes:\s*(.+)/i);
  if (!match) return out;
  const list = match[1];
  // Capture each scope between quotes OR each bare token between commas.
  const quoted = list.match(/'([^']+)'/g);
  if (quoted) {
    for (const q of quoted) out.add(q.replace(/'/g, '').trim());
    return out;
  }
  for (const piece of list.split(',')) {
    const t = piece.trim();
    if (t) out.add(t);
  }
  return out;
}

/**
 * Parse the account login from `gh auth status` output. Best-effort —
 * if the line shape changes upstream we degrade gracefully (return null).
 *
 * @param {string} text
 * @returns {string | null}
 */
export function parseAccount(text) {
  if (!text) return null;
  // Examples:
  //   ✓ Logged in to github.com account AlfHubPlural (keyring)
  //   ✓ Logged in to github.com as AlfHubPlural (...)  ← older gh
  const m =
    text.match(/account\s+([\w.-]+)/i) ||
    text.match(/Logged in to github\.com as ([\w.-]+)/i);
  return m ? m[1] : null;
}
