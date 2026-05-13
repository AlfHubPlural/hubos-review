/**
 * `hubos-review install [gate]` — copy a gate bundle into a target repo.
 *
 * Story: CICD-002-B (AC-1 through AC-14, except AC-10/AC-11/AC-12/AC-14
 * which are operational/handoff items owned by @devops/@po).
 *
 * Behavior:
 *   1. Resolve target directory (CWD or --target=<path>) and verify it is
 *      a git repo (AC-9). Refuse to write anything otherwise.
 *   2. Load + integrity-check the requested bundle (defensive — AC-5/AC-7).
 *   3. If `.aiox/cicd-version` already exists and --force was NOT given,
 *      abort with exit code 0 and a clear message (AC-2 idempotence).
 *   4. In --dry-run, list every operation that WOULD happen and return 0
 *      (AC-4 — no writes).
 *   5. Otherwise, copy each bundle file to its target path (mkdir -p as
 *      needed) and write `.aiox/cicd-version` as JSON containing per-file
 *      SHA-256 (AC-1, AC-7).
 *   6. Print the next-steps banner (AC-8).
 *
 * Idempotence + safety: bundle integrity is verified before ANY filesystem
 * write so a corrupted bundle aborts before partial state can exist.
 */

import {
  existsSync,
  mkdirSync,
  copyFileSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { bundleDir, verifyBundleIntegrity, sha256File } from '../lib/bundle.js';
import {
  createDefaultGhCli,
  detectOwnerRepo,
  maybeConfigureBranchProtection,
  DEFAULT_CHECK_NAME,
} from '../lib/branch-protection.js';
import { defaultTty } from '../lib/tty.js';

/**
 * Exit codes are documented in the README install section.
 */
const EXIT = {
  OK: 0,
  USAGE: 1,
  /**
   * Exit 2: user passed conflicting flags (--auto-protect + --skip-protection).
   * Distinct from USAGE so callers can distinguish "fatal usage error" from
   * "ambiguous intent that the user must resolve". Story D AC-1.
   */
  CONFLICT: 2,
};

/**
 * Public API. Throws nothing for "expected" failures — caller (commander)
 * gets a numeric return code. Real errors (bundle missing / fs error)
 * propagate as Error instances so commander/main can format them.
 *
 * @param {{ gate?: string, force?: boolean, dryRun?: boolean, target?: string, version?: string, cwd?: string, now?: () => string }} [opts]
 * @returns {number} exit code
 */
export function install(opts = {}) {
  const gate = opts.gate ?? 'codex-gate';
  const version = opts.version ?? 'v1';
  const force = Boolean(opts.force);
  const dryRun = Boolean(opts.dryRun);
  const cwd = opts.cwd ?? process.cwd();
  const targetDir = resolve(opts.target ? opts.target : cwd);
  const now = typeof opts.now === 'function' ? opts.now() : new Date().toISOString();

  // ─── Step 1: validate target dir is a git repo (AC-9) ────────────────
  if (!existsSync(targetDir)) {
    console.error(`hubos-review install: target directory does not exist: ${targetDir}`);
    return EXIT.USAGE;
  }
  const gitDir = join(targetDir, '.git');
  if (!existsSync(gitDir)) {
    console.error(
      `hubos-review install: target is not a git repository: ${targetDir}\n` +
        "Run 'git init' first, or pass --target=<path> pointing to a git repo.",
    );
    return EXIT.USAGE;
  }

  // ─── Step 2: load + integrity-check bundle ───────────────────────────
  let manifest;
  try {
    manifest = verifyBundleIntegrity(gate, version);
  } catch (err) {
    console.error(`hubos-review install: ${err.message}`);
    return EXIT.USAGE;
  }

  // ─── Step 3: idempotence check (.aiox/cicd-version) ──────────────────
  // Note: --dry-run bypasses the idempotence abort because no writes happen
  // anyway — the user is asking "what would change?", and answering "nothing
  // because we'd refuse" is unhelpful. Dry-run reports the would-overwrite
  // state explicitly (see Step 4 markers).
  const cicdVersionPath = join(targetDir, '.aiox', 'cicd-version');
  let existingState = null;
  if (existsSync(cicdVersionPath)) {
    try {
      existingState = JSON.parse(readFileSync(cicdVersionPath, 'utf8'));
    } catch {
      // Corrupted / non-JSON — treat as existing-but-unparseable, still abort without --force.
      existingState = { _malformed: true };
    }
    if (!force && !dryRun) {
      const gateRecord = existingState?.gates?.[gate];
      const installedAt =
        gateRecord?.installedAt ??
        existingState?.installedAt ??
        '<unknown>';
      const bundleVer = gateRecord?.bundleVersion ?? '<unknown>';
      console.error(
        `${gate} ${bundleVer} already installed (installed at ${installedAt}). ` +
          `Use --force to reinstall.`,
      );
      // AC-2: exit code 0 — not a fatal error, just nothing to do.
      return EXIT.OK;
    }
  }

  // Compute the plan: source → destination pairs + per-file hashes.
  const bundlePath = bundleDir(gate, version);
  const plan = manifest.files.map((file) => ({
    name: file.name,
    source: join(bundlePath, file.bundlePath),
    destination: join(targetDir, file.targetPath),
    targetPath: file.targetPath,
    sha256: file.sha256,
  }));

  // ─── Step 4: dry-run handling (AC-4) ─────────────────────────────────
  if (dryRun) {
    console.log(`hubos-review install ${gate} ${version} — DRY RUN (no writes)`);
    console.log(`Target repo: ${targetDir}`);
    console.log(`Bundle: ${bundlePath}`);
    if (existingState && !force) {
      console.log('');
      console.log(
        'Note: .aiox/cicd-version already exists — a real run without --force would abort.',
      );
      console.log("       Pass '--force --dry-run' to preview a reinstall.");
    }
    console.log('');
    console.log('Files that would be copied:');
    for (const item of plan) {
      const destExists = existsSync(item.destination);
      const marker = destExists ? ' (OVERWRITES existing)' : '';
      console.log(`  ${item.name}`);
      console.log(`    from: ${item.source}`);
      console.log(`    to:   ${item.destination}${marker}`);
    }
    console.log('');
    const cicdVerb = existingState ? 'updated' : 'created';
    console.log(`Would be ${cicdVerb}: ${cicdVersionPath}`);
    console.log('');
    console.log('No filesystem changes were made.');
    return EXIT.OK;
  }

  // ─── Step 5: copy files + write cicd-version (AC-1, AC-3, AC-7) ──────
  const installedFiles = [];
  for (const item of plan) {
    mkdirSync(dirname(item.destination), { recursive: true });
    copyFileSync(item.source, item.destination);
    const actualHash = sha256File(item.destination);
    // Defensive: re-hash the freshly copied file. If FS truncated or modified it,
    // the bundle integrity check guarantees the source was correct.
    if (actualHash !== item.sha256) {
      console.error(
        `hubos-review install: post-copy hash mismatch for ${item.name}.\n` +
          `  expected: ${item.sha256}\n` +
          `  actual:   ${actualHash}\n` +
          `Filesystem may be unreliable — aborting before .aiox/cicd-version is written.`,
      );
      return EXIT.USAGE;
    }
    installedFiles.push({
      name: item.name,
      targetPath: item.targetPath,
      sha256: actualHash,
    });
  }

  // Read package metadata for the cicd-version stamp.
  const pkgMeta = readPackageMeta();

  const cicdVersion = {
    package: pkgMeta.name,
    version: pkgMeta.version,
    installedAt: now,
    gates: {
      ...(existingState && !existingState._malformed && existingState.gates ? existingState.gates : {}),
      [gate]: {
        bundleVersion: version,
        installedAt: now,
        sourceHash: Object.fromEntries(installedFiles.map((f) => [f.name, f.sha256])),
        files: installedFiles.map((f) => ({
          name: f.name,
          targetPath: f.targetPath,
          sha256: f.sha256,
        })),
      },
    },
  };

  mkdirSync(dirname(cicdVersionPath), { recursive: true });
  writeFileSync(cicdVersionPath, JSON.stringify(cicdVersion, null, 2) + '\n', 'utf8');

  // ─── Step 6: success banner (AC-8) ───────────────────────────────────
  const action = existingState ? 'reinstalled' : 'installed';
  console.log(`${gate} ${version} ${action} successfully.`);
  console.log(`${plan.length} files copied to ${targetDir}.`);
  console.log(
    `.aiox/cicd-version ${existingState ? 'updated' : 'created'} (remember to git add and commit this file — D-002-8).`,
  );
  if (opts.skipNextSteps !== true) {
    console.log(
      "Next: configure branch protection via 'hubos-review install codex-gate --auto-protect' (Story D)" +
        " or run 'hubos-review verify' to check pre-flight status (Story C).",
    );
  }
  return EXIT.OK;
}

/**
 * Async wrapper around `install()` that also handles branch protection
 * (Story CICD-002-D). Returns a numeric exit code suitable for the CLI.
 *
 * Behavior:
 *   1. Runs the synchronous `install(...)` first. If it returns a non-zero
 *      code, propagates it immediately — branch protection is NOT attempted.
 *   2. If the install was a no-op (already installed, no --force), branch
 *      protection is STILL evaluated — the user may be re-running just to
 *      configure protection after an earlier install that skipped it.
 *   3. Decides skip/apply via `maybeConfigureBranchProtection` (matrix in
 *      decideProtectionFlow).
 *   4. Updates `.aiox/cicd-version` `gates.<gate>.branchProtection` field
 *      when protection was applied successfully (AC-11).
 *   5. ALWAYS returns 0 unless install itself failed or the user passed
 *      conflicting flags (--auto-protect + --skip-protection → exit 2).
 *
 * Branch protection failures (403, 404, network) DO NOT fail the overall
 * install — AC-9 graceful degradation. They log explanatory messages and
 * continue. The bundle files remain installed.
 *
 * @param {object} [opts]   same as install(...) plus:
 * @param {boolean} [opts.autoProtect]
 * @param {boolean} [opts.skipProtection]
 * @param {string}  [opts.branch]
 * @param {string}  [opts.checkName]
 * @param {object}  [opts.ghCli]     defaults to createDefaultGhCli()
 * @param {object}  [opts.tty]       defaults to defaultTty
 * @param {Function} [opts.detectOwnerRepoFn]  defaults to detectOwnerRepo
 * @returns {Promise<number>} exit code
 */
export async function installWithProtection(opts = {}) {
  // Step 1: run the synchronous install. Suppress the "Next steps" banner
  // because we'll print a more targeted summary at the end.
  const installRc = install({ ...opts, skipNextSteps: true });
  if (installRc !== EXIT.OK) {
    return installRc;
  }

  const cwd = opts.cwd ?? process.cwd();
  const targetDir = resolve(opts.target ? opts.target : cwd);
  const gate = opts.gate ?? 'codex-gate';

  // Step 2: detect owner/repo for the target directory.
  const detectFn = opts.detectOwnerRepoFn ?? detectOwnerRepo;
  let ownerRepo = null;
  try {
    ownerRepo = await detectFn({ cwd: targetDir });
  } catch {
    ownerRepo = null;
  }

  // If we can't determine owner/repo, we can't talk to gh api. But the
  // user might still have passed --skip-protection, which is a valid path.
  if (!ownerRepo) {
    // Honor explicit flag conflicts before we bail out — keeps the exit
    // code matrix predictable.
    if (opts.autoProtect && opts.skipProtection) {
      console.error(
        'hubos-review: Cannot use --auto-protect and --skip-protection together.',
      );
      return EXIT.CONFLICT;
    }
    if (opts.skipProtection) {
      console.log('Skipping branch protection per --skip-protection flag.');
      return EXIT.OK;
    }
    console.error(
      'hubos-review: Could not determine GitHub owner/repo from the target.\n' +
        '  The target must have an `origin` remote pointing at github.com.\n' +
        '  Branch protection step skipped. Files were installed successfully.',
    );
    return EXIT.OK;
  }

  // Step 3: run the protection flow.
  const ghCli = opts.ghCli ?? createDefaultGhCli();
  const tty = opts.tty ?? defaultTty;

  const flow = await maybeConfigureBranchProtection({
    ghCli,
    tty,
    options: {
      autoProtect: opts.autoProtect,
      skipProtection: opts.skipProtection,
      branch: opts.branch ?? 'main',
      checkName: opts.checkName ?? DEFAULT_CHECK_NAME,
    },
    owner: ownerRepo.owner,
    repo: ownerRepo.repo,
  });

  if (flow.outcome === 'conflict') {
    return EXIT.CONFLICT;
  }

  // Step 4: stamp .aiox/cicd-version with branchProtection state when applied.
  if (flow.outcome === 'applied' || flow.outcome === 'noop') {
    try {
      stampBranchProtectionResult({
        targetDir,
        gate,
        result: flow.result,
        now:
          typeof opts.now === 'function'
            ? opts.now()
            : new Date().toISOString(),
      });
    } catch (err) {
      // Non-fatal: the bundle is installed, branch protection is configured;
      // we just couldn't write the stamp. Warn and continue.
      console.error(
        `hubos-review: branch protection applied but failed to update .aiox/cicd-version: ${err.message}`,
      );
    }
  }

  return EXIT.OK;
}

/**
 * Mutate `.aiox/cicd-version` to record the branchProtection result on the
 * specified gate. Pure file I/O — no network or process.
 *
 * @param {{ targetDir: string, gate: string, result: object, now: string }} args
 */
function stampBranchProtectionResult({ targetDir, gate, result, now }) {
  const cicdVersionPath = join(targetDir, '.aiox', 'cicd-version');
  if (!existsSync(cicdVersionPath)) {
    // The install path always writes this file, so it should exist. Defensive.
    return;
  }
  let state;
  try {
    state = JSON.parse(readFileSync(cicdVersionPath, 'utf8'));
  } catch {
    // Corrupted state — leave untouched. (Would already be a problem the user
    // notices independently.)
    return;
  }
  if (!state.gates) state.gates = {};
  if (!state.gates[gate]) state.gates[gate] = {};
  state.gates[gate].branchProtection = {
    configured: true,
    checkName: result.checkName,
    branch: result.branch,
    configuredAt: now,
    previousContexts: result.previousContexts ?? [],
    mergedContexts: result.mergedContexts ?? [],
  };
  writeFileSync(cicdVersionPath, JSON.stringify(state, null, 2) + '\n', 'utf8');
}

/**
 * Read the CLI's own package.json (the one that ships in the npm tarball).
 * Used to stamp `package` + `version` into the target's .aiox/cicd-version.
 */
function readPackageMeta() {
  try {
    const pkgPath = join(packageRootFromHere(), 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    return {
      name: pkg.name ?? '@hubplural/hubos-review',
      version: pkg.version ?? '0.0.0-dev',
    };
  } catch {
    return { name: '@hubplural/hubos-review', version: '0.0.0-dev' };
  }
}

/**
 * Resolve the CLI package root (mirrors bundle.js logic — duplicated locally
 * to keep this module focused, but they should resolve to the same dir).
 */
function packageRootFromHere() {
  // src/commands/install.js → ../../package.json
  return resolve(dirname(new URL(import.meta.url).pathname), '..', '..');
}
