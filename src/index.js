/**
 * Public programmatic API for @hubplural/hubos-review.
 *
 * For now, exposes the CLI builder so consumers can embed it (rare —
 * primary use is the binary). All four sub-commands are real as of
 * Story CICD-002-E (v0.4.0) — install, verify, status, update.
 */

export { buildProgram, run } from './cli.js';
export { install, installWithProtection } from './commands/install.js';
export { update } from './commands/update.js';
export { status } from './commands/status.js';
export { verify } from './commands/verify.js';
export {
  configureBranchProtection,
  maybeConfigureBranchProtection,
  decideProtectionFlow,
  mergeCheckIntoBody,
  normalizeForPut,
  buildManualCommand,
  detectOwnerRepo,
  parseGithubRemote,
  createDefaultGhCli,
  DEFAULT_CHECK_NAME,
} from './lib/branch-protection.js';
export { createTtyHelpers, defaultTty } from './lib/tty.js';
export {
  createRegistryClient,
  defaultExec as defaultRegistryExec,
  compareVersions,
  parseSemver,
} from './lib/registry.js';
export {
  diffInstalledVsBundle,
  hasBundleChanges,
  hasLocalModifications,
  shortSha,
} from './lib/diff.js';
