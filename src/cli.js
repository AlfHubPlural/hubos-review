/**
 * CLI builder and dispatcher for hubos-review.
 *
 * Exported as a function (not a top-level program) so that tests can
 * instantiate fresh Command instances and exercise parsing/dispatch
 * deterministically without process.exit() leaking across tests.
 */

import { Command, Option } from 'commander';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { install, installWithProtection } from './commands/install.js';
import { update } from './commands/update.js';
import { status } from './commands/status.js';
import { verify } from './commands/verify.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Read package.json once at module load to avoid filesystem hits per invocation.
 * Falls back to "0.0.0-dev" if the file cannot be read (e.g., running from
 * a stripped artifact in unusual deployment scenarios).
 */
function readPackageVersion() {
  try {
    const pkgPath = resolve(__dirname, '..', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    return pkg.version ?? '0.0.0-dev';
  } catch {
    return '0.0.0-dev';
  }
}

/**
 * Builds the commander program. Pure factory so tests can spin up isolated
 * instances per assertion.
 *
 * @returns {Command} a configured commander program.
 */
export function buildProgram() {
  const program = new Command();

  program
    .name('hubos-review')
    .description(
      'Standalone CLI to install portable PR review gates (codex-gate, etc.) on any GitHub repo.\n' +
        'Part of the hub-os ecosystem. See https://github.com/AlfHubPlural/hubos-review',
    )
    .version(readPackageVersion(), '-v, --version', 'Output the current version')
    .helpOption('-h, --help', 'Display help for command')
    .showHelpAfterError('(add --help for additional information)');

  // install [gate]
  program
    .command('install')
    .description('Install a PR review gate in the current repo (one-shot setup)')
    .argument('[gate]', 'Gate name to install (e.g., codex-gate)', 'codex-gate')
    .addOption(new Option('--force', 'Overwrite existing installation').default(false))
    .addOption(
      new Option('--dry-run', 'Show what would be installed without writing files').default(false),
    )
    .addOption(
      new Option('--target <path>', 'Target repository directory (defaults to CWD)').default(null),
    )
    .addOption(
      new Option('--bundle-version <slug>', 'Bundle version to install (defaults to v1)').default(
        'v1',
      ),
    )
    // ─── Story CICD-002-D — branch protection flags ─────────────────────
    .addOption(
      new Option('--auto-protect', 'Apply branch protection without prompting').default(false),
    )
    .addOption(
      new Option('--skip-protection', 'Skip branch protection configuration entirely').default(
        false,
      ),
    )
    .addOption(
      new Option('--branch <name>', 'Branch to protect (defaults to main)').default('main'),
    )
    .action(async (gate, opts) => {
      // --dry-run intentionally bypasses branch protection: a dry run should
      // never call gh api. Story B semantics preserved.
      if (opts.dryRun) {
        const rc = install({
          gate,
          force: opts.force,
          dryRun: opts.dryRun,
          target: opts.target,
          version: opts.bundleVersion,
        });
        if (rc !== 0) {
          process.exit(rc);
        }
        return;
      }
      const rc = await installWithProtection({
        gate,
        force: opts.force,
        dryRun: opts.dryRun,
        target: opts.target,
        version: opts.bundleVersion,
        autoProtect: opts.autoProtect,
        skipProtection: opts.skipProtection,
        branch: opts.branch,
      });
      if (rc !== 0) {
        process.exit(rc);
      }
    });

  // update
  program
    .command('update')
    .description('Bump installed gate to the latest available version')
    .action(() => update());

  // status
  program
    .command('status')
    .description('Show installed gate version vs latest available version')
    .action(() => status());

  // verify (Story CICD-002-C — real pre-flight check)
  program
    .command('verify')
    .description('Run pre-flight checks (gh auth, GitHub App, repo state)')
    .addOption(new Option('--json', 'Emit machine-readable JSON output').default(false))
    .addOption(
      new Option('--gate <name>', 'Gate name to verify (only codex-gate in MVP)').default(
        'codex-gate',
      ),
    )
    .addOption(
      new Option('--target <path>', 'Target repository directory (defaults to CWD)').default(null),
    )
    .addOption(
      new Option('--branch <name>', 'Protected branch name to check').default('main'),
    )
    .addOption(
      new Option('--bundle-version <slug>', 'Bundle version to compare against').default('v1'),
    )
    .action(async (opts) => {
      const rc = await verify({
        json: opts.json,
        gate: opts.gate,
        target: opts.target,
        branch: opts.branch,
        bundleVersion: opts.bundleVersion,
      });
      if (rc !== 0) {
        process.exit(rc);
      }
    });

  // Unknown sub-command handler — commander emits 'command:*' before exiting.
  // We override the exit code via configureOutput + exitOverride to deliver
  // AC-8 (exit code 1 for invalid sub-commands).
  program.on('command:*', (operands) => {
    const unknown = operands[0];
    console.error(`hubos-review: unknown command '${unknown}'.`);
    console.error("Run 'hubos-review --help' to see available commands.");
    process.exit(1);
  });

  return program;
}

/**
 * Run the CLI with the given argv array.
 *
 * @param {string[]} argv typically process.argv
 * @returns {Promise<Command>} resolves once parsing completes.
 */
export async function run(argv) {
  const program = buildProgram();
  await program.parseAsync(argv);
  return program;
}
