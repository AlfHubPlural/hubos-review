/**
 * Public programmatic API for @alfhubplural/hubos-review.
 *
 * For now, exposes the CLI builder so consumers can embed it (rare —
 * primary use is the binary). All sub-commands remain stubs in v0.1.0
 * (Story CICD-002-A); real behavior lands in Stories B/C/D/E.
 */

export { buildProgram, run } from './cli.js';
export { install } from './commands/install.js';
export { update } from './commands/update.js';
export { status } from './commands/status.js';
export { verify } from './commands/verify.js';
