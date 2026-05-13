/**
 * C3 — GitHub App `chatgpt-codex-connector` is installed in the target repo.
 *
 * Severity: CRITICAL — without the App, the codex-gate workflow runs but
 * never receives reviews from the bot, leaving the gate eternally pending.
 *
 * ─── Empirical validation (Story C, T-C.9.3) ─────────────────────────────
 *
 * The story's primary hypothesis was `GET /repos/{owner}/{repo}/installation`
 * with detection via `app.slug === 'chatgpt-codex-connector'`. Tested 2026-05-13
 * with a user-token `gh` CLI (scopes `repo`, `read:org`):
 *
 *   $ gh api /repos/AlfHubPlural/hubos-review/installation
 *   → 401 "A JSON web token could not be decoded"
 *
 *   $ gh api /repos/AlfHubPlural/hubos-review/installations
 *   → 404 "Not Found"
 *
 *   $ gh api /user/installations
 *   → 403 "You must authenticate with an access token authorized to a
 *          GitHub App in order to list installations"
 *
 *   $ gh api /orgs/AlfHubPlural/installations
 *   → 404 "Not Found" (also needs admin:org)
 *
 * The official endpoints all require a JWT signed by the App's private key
 * (bot-side authentication), which is fundamentally incompatible with a
 * user-token CLI. There is no documented user-token endpoint that lists App
 * installations on a single repo. See:
 *   https://docs.github.com/rest/apps/apps#get-a-repository-installation-for-the-authenticated-app
 *
 * ─── Heuristic actually used ─────────────────────────────────────────────
 *
 * The CLI detects the App's *presence* by looking for past activity from the
 * bot's user account on the repo. The bot login is well-known
 * (`chatgpt-codex-connector[bot]`) and documented in
 * `.claude/rules/bot-review-integration.md` of the hub-os repo.
 *
 * Endpoints used (no JWT, just user token):
 *   1. `GET /repos/{owner}/{repo}/pulls/comments?per_page=100`
 *      Lists PR review comments. If any was authored by
 *      `chatgpt-codex-connector[bot]`, the App is installed.
 *      Empirically validated:
 *        AlfHubPlural/Hub-OS    → 72+ comments  → PASS
 *        AlfHubPlural/hubos-review → 0 comments → no signal yet
 *
 *   2. Fallback: `GET /repos/{owner}/{repo}/issues/comments?per_page=100`
 *      Some Apps comment on PRs at the issue level. Same login check.
 *
 *   3. WARN (not FAIL) when no signal is found. Rationale: a fresh repo with
 *      the App authorized but zero merged PRs would falsely FAIL the strict
 *      check. We surface the URL + manual override hint so the user can
 *      proceed with `--force` on `install` if they're sure.
 *
 * This trade-off is the right one for a pre-flight check: false-negatives
 * (App installed but no PRs yet) become WARN with clear next steps; the
 * alternative — JWT-based check — would require the user to provision an
 * App private key, which defeats the "one-shot install" goal of the epic.
 *
 * @typedef {import('./_types.js').CheckResult} CheckResult
 * @typedef {import('./_types.js').CheckContext} CheckContext
 */

import { createGhCli } from '../lib/gh-cli.js';

export const CODEX_APP_SLUG = 'chatgpt-codex-connector';
export const CODEX_BOT_LOGIN = 'chatgpt-codex-connector[bot]';
export const INSTALL_URL =
  'https://github.com/apps/chatgpt-codex-connector/installations/new';

const REMEDIATION =
  `Authorize the Codex App on this repo:\n` +
  `  1. Open ${INSTALL_URL}\n` +
  `  2. Select '${'{owner}/{repo}'}' from the list (or 'Only select repositories')\n` +
  `  3. Click Install/Authorize\n` +
  `Then re-run 'hubos-review verify'. If the App is already authorized but no\n` +
  `PRs have been opened yet, this check will WARN — that is expected on fresh\n` +
  `repos and does not block installation.`;

/**
 * @param {CheckContext} ctx
 * @returns {Promise<CheckResult>}
 */
export default async function checkCodexApp(ctx = {}) {
  const id = 'C3';
  const name = 'Codex App installed';
  const severity = 'CRITICAL';

  const coords = ctx.repoCoords;
  if (!coords) {
    return {
      id,
      name,
      severity,
      status: 'FAIL',
      blocking: true,
      details: 'cannot detect App without a GitHub repo (C2 must pass first).',
      remediation: REMEDIATION.replace('{owner}/{repo}', '<owner>/<repo>'),
      evidence: { reason: 'no-repo-coords' },
    };
  }

  const gh = ctx.ghCli ?? createGhCli({ execFn: ctx.execFn });
  const repoTag = `${coords.owner}/${coords.repo}`;
  const installRemediation = REMEDIATION.replace('{owner}/{repo}', repoTag);

  // ── Primary signal: PR review comments ───────────────────────────────
  // We ask for the most recent 100; a single hit is enough.
  const reviewComments = gh.ghApi(
    `/repos/${coords.owner}/${coords.repo}/pulls/comments?per_page=100`,
  );
  if (reviewComments.ok && Array.isArray(reviewComments.json)) {
    const hits = reviewComments.json.filter(
      (c) => c?.user?.login === CODEX_BOT_LOGIN,
    );
    if (hits.length > 0) {
      return {
        id,
        name,
        severity,
        status: 'PASS',
        blocking: true,
        details:
          `App detected via ${hits.length} prior review comment(s) from ${CODEX_BOT_LOGIN}.`,
        evidence: {
          source: 'pulls/comments',
          sampleCount: hits.length,
          repo: repoTag,
        },
      };
    }
  }

  // ── Fallback signal: issue-level PR comments ─────────────────────────
  const issueComments = gh.ghApi(
    `/repos/${coords.owner}/${coords.repo}/issues/comments?per_page=100`,
  );
  if (issueComments.ok && Array.isArray(issueComments.json)) {
    const hits = issueComments.json.filter(
      (c) => c?.user?.login === CODEX_BOT_LOGIN,
    );
    if (hits.length > 0) {
      return {
        id,
        name,
        severity,
        status: 'PASS',
        blocking: true,
        details:
          `App detected via ${hits.length} prior issue comment(s) from ${CODEX_BOT_LOGIN}.`,
        evidence: {
          source: 'issues/comments',
          sampleCount: hits.length,
          repo: repoTag,
        },
      };
    }
  }

  // Neither endpoint produced a signal. If both calls actually failed (gh
  // error, repo private, etc.) we report FAIL with detail; if calls succeeded
  // but returned empty/no-match, we report WARN (could be a fresh repo).
  const bothFailed =
    !reviewComments.ok &&
    !issueComments.ok;

  if (bothFailed) {
    return {
      id,
      name,
      severity,
      status: 'FAIL',
      blocking: true,
      details:
        `unable to query PR/issue comments for ${repoTag} ` +
        '(both endpoints returned an error — repo may be private without scope, ' +
        'or rate-limited).',
      remediation: installRemediation,
      evidence: {
        repo: repoTag,
        reviewCommentsError: reviewComments.stderr,
        issueCommentsError: issueComments.stderr,
      },
    };
  }

  // Calls succeeded but no bot activity found. Could be a fresh repo where
  // the App is authorized but no PRs have been opened yet. WARN, not FAIL.
  return {
    id,
    name,
    severity,
    status: 'WARN',
    // WARN on a CRITICAL check still blocks the dispatcher's exit code by
    // design — but visually it's amber, signalling "probably fine, verify".
    // The dispatcher's severity logic treats WARN on CRITICAL/HIGH as
    // non-blocking (only explicit FAIL blocks). See verify.js docstring.
    blocking: false,
    details:
      `no prior activity from ${CODEX_BOT_LOGIN} found on ${repoTag}. ` +
      'App may be authorized but no PRs have been reviewed yet, or App is not installed.',
    remediation: installRemediation,
    evidence: {
      repo: repoTag,
      source: 'no-signal',
      note: 'Empirical check uses past PR activity; cannot prove negative without JWT-based GitHub App endpoints.',
    },
  };
}
