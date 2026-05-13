/**
 * Stub: `hubos-review verify`.
 *
 * Real behavior lands in EPIC-CICD-002 Story C (pre-flight check):
 *   - `gh auth status` passes
 *   - CWD is a git repo with branch `main`
 *   - GitHub App `chatgpt-codex-connector` authorized on the target repo
 *   - admin permission warning (non-blocking)
 *
 * For now: echo the request and exit 0.
 */
export function verify() {
  console.log(
    'hubos-review verify: Not yet implemented — coming in EPIC-CICD-002 Story C (pre-flight check).',
  );
  return 0;
}
