/**
 * Branch protection configuration via `gh api`.
 *
 * Story: CICD-002-D
 *   - AC-3 (CRITICAL): merge with pre-existing checks — never replace.
 *   - AC-4: graceful degradation when user lacks admin (403).
 *   - AC-6: support arbitrary branch via --branch.
 *   - AC-7: all `gh` invocations are injection-friendly for tests.
 *   - AC-9: emit the structured payload + manual instruction on failure.
 *
 * Empirical payload reference (resolves OQ-D of the parent epic):
 *
 *     gh api /repos/AlfHubPlural/hub-os/branches/main/protection
 *
 * captured 2026-05-12 from the live `hub-os` repository (the source of
 * truth for codex-gate). The relevant shape, normalized to the PUT body
 * expected by `PUT /repos/{owner}/{repo}/branches/{branch}/protection`:
 *
 *     {
 *       "required_status_checks": {
 *         "strict": true,                            // hub-os uses strict=true
 *         "contexts": ["gitleaks scan", "Run unit tests",
 *                      "Vercel Preview Comments", "codex-review-gate", ...]
 *       },
 *       "enforce_admins": false,                     // hub-os does not enforce
 *       "required_pull_request_reviews": null,       // null = no review requirement
 *       "restrictions": null                         // null = no user/team restriction
 *     }
 *
 * Important quirks (validated against the GitHub REST docs + empirical run):
 *
 *   - The PUT endpoint is a FULL REPLACE of the protection state. A naive
 *     PUT with `{ required_status_checks: { contexts: ["codex-review-gate"] }}`
 *     would clobber every other gate the repo had. Hence the GET-merge-PUT
 *     dance (AC-3).
 *   - `enforce_admins` and `required_status_checks.strict` must be primitive
 *     booleans, never null.
 *   - `required_pull_request_reviews` and `restrictions` MUST be `null`
 *     (not omitted) when we don't want to manage them. Omitting them would
 *     leave existing values in place per GitHub docs, BUT empirically the
 *     `gh api -F` pattern used historically by the CICD-A story sent them
 *     as null, so we mirror that contract to avoid surprises.
 *   - The GET response wraps `enforce_admins` in `{ enabled: bool }`, while
 *     the PUT body expects the bare boolean. The `normalizeForPut` helper
 *     handles the asymmetry so callers see a single coherent payload shape.
 */

import { spawn } from 'node:child_process';

/**
 * Empirically validated default check name. Constant — referenced by the
 * `codex-review-gate.yml` workflow shipped in the bundle.
 */
export const DEFAULT_CHECK_NAME = 'codex-review-gate';

/**
 * The structured outcome shapes used by the public API.
 *
 * Status values:
 *   - 'applied'   PUT succeeded; payload installed in target repo.
 *   - 'noop'      Check was already present; we did not call PUT.
 *   - 'forbidden' User lacks admin permissions (HTTP 403).
 *   - 'not-found' Branch or repo not found (HTTP 404).
 *   - 'error'     Any other failure (network, invalid JSON, etc).
 *
 * @typedef {Object} BranchProtectionResult
 * @property {'applied'|'noop'|'forbidden'|'not-found'|'error'} status
 * @property {string} [reason]            short human-readable label
 * @property {string} [message]           detailed human message (for logs)
 * @property {string[]} [previousContexts] contexts before merge (audit trail)
 * @property {string[]} [mergedContexts]   contexts written by the PUT
 * @property {string} [branch]
 * @property {string} [checkName]
 * @property {object} [payload]           the exact body sent on PUT (or that would be sent)
 * @property {string} [manualCommand]     ready-to-paste gh CLI command for AC-4
 */

/**
 * Run `gh api ...` and return its parsed JSON output, or throw a structured
 * error. Test-friendly: callers can inject `spawnFn` to replace the real
 * `child_process.spawn`.
 *
 * @param {string[]} args             arguments AFTER the `gh` binary name
 * @param {object} [opts]
 * @param {string} [opts.input]       optional stdin payload (for PUTs with --input -)
 * @param {Function} [opts.spawnFn]   defaults to child_process.spawn
 * @returns {Promise<{ stdout: string, stderr: string, code: number }>}
 */
function runGhCmd(args, { input, spawnFn = spawn } = {}) {
  return new Promise((resolve, reject) => {
    let proc;
    try {
      proc = spawnFn('gh', args, {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      reject(err);
      return;
    }
    let stdout = '';
    let stderr = '';
    proc.stdout?.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });
    proc.stderr?.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    proc.on('error', reject);
    proc.on('close', (code) => {
      resolve({ stdout, stderr, code: code ?? 0 });
    });
    if (input !== undefined) {
      try {
        proc.stdin?.write(input);
        proc.stdin?.end();
      } catch (err) {
        reject(err);
      }
    } else {
      try {
        proc.stdin?.end();
      } catch {
        // ignore — already closed
      }
    }
  });
}

/**
 * Default GH client. Each method returns a structured outcome the caller
 * can pattern-match on without needing to know about gh exit codes.
 *
 * @param {object} [deps]
 * @param {Function} [deps.spawnFn]
 * @returns {{
 *   getProtection: (owner: string, repo: string, branch: string) => Promise<{ ok: boolean, body?: any, status?: number, stderr?: string }>,
 *   putProtection: (owner: string, repo: string, branch: string, body: object) => Promise<{ ok: boolean, body?: any, status?: number, stderr?: string }>,
 * }}
 */
export function createDefaultGhCli(deps = {}) {
  const spawnFn = deps.spawnFn ?? spawn;

  function classifyError(stderr) {
    const s = String(stderr || '').toLowerCase();
    if (
      s.includes('http 403') ||
      s.includes('must have admin') ||
      s.includes('upgrade to github pro') ||
      s.includes('not authorized')
    ) {
      return 403;
    }
    if (s.includes('http 404') || s.includes('not found')) {
      return 404;
    }
    if (s.includes('http 422')) {
      return 422;
    }
    return null;
  }

  async function getProtection(owner, repo, branch) {
    const endpoint = `/repos/${owner}/${repo}/branches/${branch}/protection`;
    const { stdout, stderr, code } = await runGhCmd(['api', endpoint], { spawnFn });
    if (code === 0) {
      try {
        return { ok: true, body: JSON.parse(stdout), status: 200 };
      } catch (err) {
        return { ok: false, status: null, stderr: `Invalid JSON from gh api: ${err.message}` };
      }
    }
    const httpStatus = classifyError(stderr);
    return { ok: false, status: httpStatus, stderr };
  }

  async function putProtection(owner, repo, branch, body) {
    const endpoint = `/repos/${owner}/${repo}/branches/${branch}/protection`;
    const args = [
      'api',
      '-X',
      'PUT',
      endpoint,
      '-H',
      'Accept: application/vnd.github+json',
      '--input',
      '-',
    ];
    const { stdout, stderr, code } = await runGhCmd(args, {
      input: JSON.stringify(body),
      spawnFn,
    });
    if (code === 0) {
      try {
        return { ok: true, body: JSON.parse(stdout), status: 200 };
      } catch {
        // PUT can return non-JSON; treat as success-with-empty-body.
        return { ok: true, body: null, status: 200 };
      }
    }
    const httpStatus = classifyError(stderr);
    return { ok: false, status: httpStatus, stderr };
  }

  return { getProtection, putProtection };
}

/**
 * Discover `owner/repo` from a local git repo. Looks at `git config
 * --get remote.origin.url`. Supports both SSH and HTTPS GitHub URLs.
 *
 * Test-friendly via injected `execFn` (sync exec returning { stdout }).
 *
 * @param {object} [deps]
 * @param {string} [deps.cwd]
 * @param {Function} [deps.execFn]  defaults to a child_process.execSync wrapper
 * @returns {Promise<{ owner: string, repo: string } | null>}
 */
export async function detectOwnerRepo(deps = {}) {
  const { cwd = process.cwd(), execFn } = deps;
  const exec =
    execFn ??
    (async () => {
      const { spawn: realSpawn } = await import('node:child_process');
      return new Promise((resolve, reject) => {
        const proc = realSpawn('git', ['-C', cwd, 'config', '--get', 'remote.origin.url'], {
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let out = '';
        let err = '';
        proc.stdout.on('data', (c) => {
          out += c.toString('utf8');
        });
        proc.stderr.on('data', (c) => {
          err += c.toString('utf8');
        });
        proc.on('error', reject);
        proc.on('close', (code) => {
          if (code !== 0) {
            resolve({ stdout: '', stderr: err, code });
          } else {
            resolve({ stdout: out, stderr: err, code });
          }
        });
      });
    });
  const result = await exec();
  const url = String(result?.stdout || '').trim();
  if (!url) return null;
  return parseGithubRemote(url);
}

/**
 * Parse a GitHub remote URL into `{ owner, repo }`.
 *
 *   git@github.com:Owner/Repo.git
 *   https://github.com/Owner/Repo
 *   https://github.com/Owner/Repo.git
 *
 * Returns null when the URL is not parseable as a GitHub remote.
 *
 * @param {string} url
 * @returns {{ owner: string, repo: string } | null}
 */
export function parseGithubRemote(url) {
  if (!url) return null;
  let m;
  // SSH: git@github.com:Owner/Repo(.git)?
  m = url.match(/^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (m) return { owner: m[1], repo: m[2] };
  // HTTPS: https://github.com/Owner/Repo(.git)?
  m = url.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
  if (m) return { owner: m[1], repo: m[2] };
  return null;
}

/**
 * Convert a GET-protection response shape into the PUT body shape.
 *
 * The asymmetries between GET and PUT (e.g. `enforce_admins.enabled` vs
 * `enforce_admins`) live entirely in this function so callers can treat
 * the payload as a single coherent contract.
 *
 * @param {object|null} getResponse  body of a successful GET, or null when 404
 * @returns {{ required_status_checks: { strict: boolean, contexts: string[] }, enforce_admins: boolean, required_pull_request_reviews: null|object, restrictions: null|object }}
 */
export function normalizeForPut(getResponse) {
  if (!getResponse) {
    // No prior protection. Use sensible defaults (mirrors the CICD-A
    // empirical payload — strict=true, enforce_admins=false, null PR/restriction).
    return {
      required_status_checks: { strict: true, contexts: [] },
      enforce_admins: false,
      required_pull_request_reviews: null,
      restrictions: null,
    };
  }
  const rsc = getResponse.required_status_checks ?? {};
  const contexts = Array.isArray(rsc.contexts) ? [...rsc.contexts] : [];
  const strict = typeof rsc.strict === 'boolean' ? rsc.strict : true;
  // enforce_admins on GET → { enabled: bool }. On PUT → bare boolean.
  let enforceAdmins = false;
  if (typeof getResponse.enforce_admins === 'boolean') {
    enforceAdmins = getResponse.enforce_admins;
  } else if (getResponse.enforce_admins && typeof getResponse.enforce_admins === 'object') {
    enforceAdmins = Boolean(getResponse.enforce_admins.enabled);
  }
  // PR reviews / restrictions: preserve whatever GET returned (could be a
  // full nested object). When absent or `{ enabled: false }`-style, normalize
  // to null per the PUT contract.
  const prr = getResponse.required_pull_request_reviews ?? null;
  const restrictions = getResponse.restrictions ?? null;
  return {
    required_status_checks: { strict, contexts },
    enforce_admins: enforceAdmins,
    required_pull_request_reviews: prr,
    restrictions,
  };
}

/**
 * Merge `checkName` into a normalized PUT body without duplicating it.
 * Pure, deterministic — no I/O.
 *
 * @param {object} normalizedBody    output of normalizeForPut
 * @param {string} checkName
 * @returns {{ body: object, alreadyPresent: boolean }}
 */
export function mergeCheckIntoBody(normalizedBody, checkName) {
  const contexts = normalizedBody.required_status_checks?.contexts ?? [];
  const alreadyPresent = contexts.includes(checkName);
  if (alreadyPresent) {
    return { body: normalizedBody, alreadyPresent: true };
  }
  // Spread into a new object so callers can keep the original for audit.
  const newBody = {
    ...normalizedBody,
    required_status_checks: {
      ...normalizedBody.required_status_checks,
      contexts: [...contexts, checkName],
    },
  };
  return { body: newBody, alreadyPresent: false };
}

/**
 * Build a copy-pasteable `gh api ...` command equivalent to the PUT we
 * would execute. Used by the AC-4 graceful-degradation path so the user
 * can run it manually after asking an admin to do so.
 *
 * @param {string} owner
 * @param {string} repo
 * @param {string} branch
 * @param {object} body
 * @returns {string} multi-line shell snippet
 */
export function buildManualCommand(owner, repo, branch, body) {
  const json = JSON.stringify(body, null, 2);
  return (
    `gh api -X PUT /repos/${owner}/${repo}/branches/${branch}/protection \\\n` +
    `  -H "Accept: application/vnd.github+json" \\\n` +
    `  --input - <<'EOF'\n` +
    `${json}\n` +
    `EOF`
  );
}

/**
 * Apply branch protection (GET → merge → PUT). Pure orchestration —
 * delegates all `gh` I/O to the injected client.
 *
 * @param {object} args
 * @param {{ getProtection: Function, putProtection: Function }} args.ghCli
 * @param {string} args.owner
 * @param {string} args.repo
 * @param {string} [args.branch]      defaults to 'main'
 * @param {string} [args.checkName]   defaults to 'codex-review-gate'
 * @returns {Promise<BranchProtectionResult>}
 */
export async function configureBranchProtection(args) {
  const { ghCli, owner, repo } = args;
  const branch = args.branch ?? 'main';
  const checkName = args.checkName ?? DEFAULT_CHECK_NAME;

  if (!ghCli || typeof ghCli.getProtection !== 'function' || typeof ghCli.putProtection !== 'function') {
    return {
      status: 'error',
      reason: 'invalid-gh-cli',
      message: 'configureBranchProtection requires a ghCli with getProtection + putProtection',
      branch,
      checkName,
    };
  }
  if (!owner || !repo) {
    return {
      status: 'error',
      reason: 'missing-owner-repo',
      message:
        'Could not determine owner/repo for the target repository. ' +
        'Make sure the target has an `origin` remote pointing at github.com.',
      branch,
      checkName,
    };
  }

  // ─── GET ───────────────────────────────────────────────────────────────
  const getResult = await ghCli.getProtection(owner, repo, branch);

  let previousBody = null;
  let previousContexts = [];

  if (getResult.ok) {
    previousBody = getResult.body;
    previousContexts = Array.isArray(previousBody?.required_status_checks?.contexts)
      ? [...previousBody.required_status_checks.contexts]
      : [];
  } else if (getResult.status === 404) {
    // No protection yet. We'll create from scratch.
    previousBody = null;
  } else if (getResult.status === 403) {
    // Not even allowed to read protection state — bail with graceful payload.
    const fallbackBody = normalizeForPut(null);
    const { body: mergedBody } = mergeCheckIntoBody(fallbackBody, checkName);
    return {
      status: 'forbidden',
      reason: 'insufficient-permissions',
      message:
        `Cannot read branch protection on ${owner}/${repo}@${branch} (HTTP 403). ` +
        'Ask an admin to apply the manual command below.',
      branch,
      checkName,
      payload: mergedBody,
      manualCommand: buildManualCommand(owner, repo, branch, mergedBody),
      previousContexts: [],
    };
  } else {
    // Network / parse / other error.
    return {
      status: 'error',
      reason: 'gh-get-failed',
      message: `gh api GET protection failed: ${getResult.stderr || 'unknown error'}`,
      branch,
      checkName,
      previousContexts: [],
    };
  }

  // ─── MERGE ─────────────────────────────────────────────────────────────
  const normalized = normalizeForPut(previousBody);
  const { body: mergedBody, alreadyPresent } = mergeCheckIntoBody(normalized, checkName);

  if (alreadyPresent) {
    // Idempotent fast-path. We do NOT call PUT to avoid touching unrelated
    // protection state in the off chance of any drift.
    return {
      status: 'noop',
      reason: 'already-present',
      message: `'${checkName}' is already in required status checks of ${owner}/${repo}@${branch}.`,
      branch,
      checkName,
      previousContexts,
      mergedContexts: previousContexts,
      payload: mergedBody,
    };
  }

  // ─── PUT ───────────────────────────────────────────────────────────────
  const putResult = await ghCli.putProtection(owner, repo, branch, mergedBody);

  if (putResult.ok) {
    return {
      status: 'applied',
      reason: 'put-success',
      message: `Branch protection updated: added '${checkName}' to ${owner}/${repo}@${branch}.`,
      branch,
      checkName,
      previousContexts,
      mergedContexts: mergedBody.required_status_checks.contexts,
      payload: mergedBody,
    };
  }

  if (putResult.status === 403) {
    return {
      status: 'forbidden',
      reason: 'insufficient-permissions',
      message:
        `Cannot write branch protection on ${owner}/${repo}@${branch} (HTTP 403). ` +
        `You probably do not have admin access. The 3 bundle files are still installed.`,
      branch,
      checkName,
      previousContexts,
      mergedContexts: [],
      payload: mergedBody,
      manualCommand: buildManualCommand(owner, repo, branch, mergedBody),
    };
  }
  if (putResult.status === 404) {
    return {
      status: 'not-found',
      reason: 'branch-or-repo-not-found',
      message:
        `Branch protection PUT returned 404 — repo or branch '${branch}' does not exist (or token lacks scope).`,
      branch,
      checkName,
      previousContexts,
      payload: mergedBody,
    };
  }
  return {
    status: 'error',
    reason: 'put-failed',
    message: `gh api PUT protection failed: ${putResult.stderr || 'unknown error'}`,
    branch,
    checkName,
    previousContexts,
    payload: mergedBody,
  };
}

/**
 * Decide what to do given (TTY, flags) without doing it. Pure function —
 * trivially testable.
 *
 * Returns an object with `action`:
 *   - 'skip-flag'      user passed --skip-protection
 *   - 'auto-flag'      user passed --auto-protect
 *   - 'auto-non-tty'   non-TTY context → auto-apply with explicit log
 *   - 'prompt-tty'     TTY context → interactive prompt
 *   - 'conflict'       both --auto-protect and --skip-protection given (exit 2)
 *
 * @param {object} args
 * @param {boolean} args.autoProtect
 * @param {boolean} args.skipProtection
 * @param {boolean} args.isInteractive
 * @returns {{ action: 'skip-flag'|'auto-flag'|'auto-non-tty'|'prompt-tty'|'conflict', message?: string }}
 */
export function decideProtectionFlow({ autoProtect, skipProtection, isInteractive }) {
  if (autoProtect && skipProtection) {
    return {
      action: 'conflict',
      message:
        'Cannot use --auto-protect and --skip-protection together. ' +
        'Pick one (or neither — non-TTY contexts auto-apply, TTY contexts prompt).',
    };
  }
  if (skipProtection) {
    return { action: 'skip-flag' };
  }
  if (autoProtect) {
    return { action: 'auto-flag' };
  }
  if (isInteractive) {
    return { action: 'prompt-tty' };
  }
  return { action: 'auto-non-tty' };
}

/**
 * High-level entry point used by `install`. Wraps the decideProtectionFlow
 * matrix + TTY prompt + configureBranchProtection into one async call.
 *
 * Returns a structured `{ outcome, result? }` where:
 *   - outcome ∈ 'skipped' | 'applied' | 'noop' | 'forbidden' | 'not-found' | 'error' | 'conflict'
 *   - result is the BranchProtectionResult when an API call happened
 *
 * NOTE: This function NEVER throws on expected paths — callers (the install
 * command) just receive an outcome and decide what to log / exit with.
 *
 * @param {object} args
 * @param {{ getProtection: Function, putProtection: Function }} args.ghCli
 * @param {{ isInteractive: () => boolean, promptYesNo: (q: string, dy?: boolean) => Promise<boolean> }} args.tty
 * @param {object} args.options
 * @param {boolean} [args.options.autoProtect]
 * @param {boolean} [args.options.skipProtection]
 * @param {string}  [args.options.branch]
 * @param {string}  [args.options.checkName]
 * @param {string}  args.owner
 * @param {string}  args.repo
 * @param {(msg: string) => void} [args.log]      defaults to console.log
 * @param {(msg: string) => void} [args.errLog]   defaults to console.error
 * @returns {Promise<{ outcome: string, result?: BranchProtectionResult, reason?: string }>}
 */
export async function maybeConfigureBranchProtection({
  ghCli,
  tty,
  options = {},
  owner,
  repo,
  log = console.log,
  errLog = console.error,
}) {
  const branch = options.branch ?? 'main';
  const checkName = options.checkName ?? DEFAULT_CHECK_NAME;
  const autoProtect = Boolean(options.autoProtect);
  const skipProtection = Boolean(options.skipProtection);
  const interactive = tty?.isInteractive ? tty.isInteractive() : false;

  const decision = decideProtectionFlow({
    autoProtect,
    skipProtection,
    isInteractive: interactive,
  });

  if (decision.action === 'conflict') {
    errLog(`hubos-review: ${decision.message}`);
    return { outcome: 'conflict', reason: 'flag-conflict' };
  }

  if (decision.action === 'skip-flag') {
    log('Skipping branch protection per --skip-protection flag.');
    return { outcome: 'skipped', reason: 'flag-skip' };
  }

  let shouldApply = false;
  if (decision.action === 'auto-flag') {
    log("Applying branch protection ('--auto-protect' flag).");
    shouldApply = true;
  } else if (decision.action === 'auto-non-tty') {
    log(
      'Non-TTY context detected — applying branch protection automatically ' +
        '(pass --skip-protection to opt out).',
    );
    shouldApply = true;
  } else if (decision.action === 'prompt-tty') {
    let yes;
    try {
      yes = await tty.promptYesNo(
        `Configure branch protection for '${branch}' now? ` +
          `(adds '${checkName}' as required status check)`,
        true,
      );
    } catch (err) {
      errLog(
        `hubos-review: failed to prompt for branch protection (${err.message}). ` +
          'Skipping. Re-run with --auto-protect or --skip-protection to be explicit.',
      );
      return { outcome: 'skipped', reason: 'prompt-error' };
    }
    if (!yes) {
      log(
        'Skipping branch protection per user choice. ' +
          "Run 'hubos-review install codex-gate --auto-protect' later to configure.",
      );
      return { outcome: 'skipped', reason: 'user-declined' };
    }
    shouldApply = true;
  }

  if (!shouldApply) {
    // Defensive — should never happen because decideProtectionFlow is exhaustive.
    return { outcome: 'skipped', reason: 'no-action' };
  }

  // ─── Apply ─────────────────────────────────────────────────────────────
  const result = await configureBranchProtection({
    ghCli,
    owner,
    repo,
    branch,
    checkName,
  });

  // Map result.status → outcome (1:1 except 'applied'/'noop' both => "applied success" UX).
  if (result.status === 'applied') {
    log(result.message);
    log(
      `Required status checks now: [${(result.mergedContexts || []).join(', ')}]`,
    );
    return { outcome: 'applied', result };
  }
  if (result.status === 'noop') {
    log(result.message);
    return { outcome: 'noop', result };
  }
  if (result.status === 'forbidden') {
    errLog(result.message);
    errLog('To configure manually, ask an admin to run:');
    errLog('');
    errLog(result.manualCommand || '(no manual command available)');
    errLog('');
    return { outcome: 'forbidden', result };
  }
  if (result.status === 'not-found') {
    errLog(result.message);
    return { outcome: 'not-found', result };
  }
  errLog(`Branch protection failed: ${result.message}`);
  return { outcome: 'error', result };
}
