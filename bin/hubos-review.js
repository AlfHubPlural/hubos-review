#!/usr/bin/env node
/**
 * hubos-review — Standalone CLI to install portable PR review gates
 *
 * This is the entrypoint. Logic lives in src/cli.js for testability
 * (the entrypoint cannot be easily unit-tested due to top-level side
 * effects when imported).
 *
 * Part of EPIC-CICD-002 (Codex Gate One-Shot Install — Portable Replication).
 * Story CICD-002-A — Skeleton: 4 stub sub-commands (install/update/status/verify).
 */

import { run } from '../src/cli.js';

run(process.argv).catch((err) => {
  // commander handles most errors internally; this is a last-resort net.
  console.error(`hubos-review: fatal error: ${err.message}`);
  process.exit(1);
});
