/**
 * Stub: `hubos-review install [gate]`.
 *
 * Real behavior lands in EPIC-CICD-002 Story B (install logic):
 *   - copy 4 frozen artifacts to the target repo
 *   - write .aiox/cicd-version
 *   - delegate branch protection to Story D
 *
 * For now: echo the request and exit 0 (no side effects).
 *
 * @param {{ gate?: string, force?: boolean }} opts
 */
export function install({ gate = 'codex-gate', force = false } = {}) {
  const flags = force ? ' (--force)' : '';
  console.log(
    `hubos-review install ${gate}${flags}: Not yet implemented — coming in EPIC-CICD-002 Story B (install logic).`,
  );
  return 0;
}
