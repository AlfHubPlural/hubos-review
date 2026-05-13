/**
 * Stub: `hubos-review status`.
 *
 * Real behavior lands in EPIC-CICD-002 Story E (update + status):
 *   - read .aiox/cicd-version in target repo
 *   - compare with latest manifest available in CLI's bundle
 *   - emit summary (installed version, available version, drift hashes)
 *
 * For now: echo the request and exit 0.
 */
export function status() {
  console.log(
    'hubos-review status: Not yet implemented — coming in EPIC-CICD-002 Story E (update + status).',
  );
  return 0;
}
