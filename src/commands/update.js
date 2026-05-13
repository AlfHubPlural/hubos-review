/**
 * Stub: `hubos-review update`.
 *
 * Real behavior lands in EPIC-CICD-002 Story E (update + status):
 *   - read .aiox/cicd-version in target repo
 *   - diff against latest manifest in this CLI's bundle
 *   - apply bump (or abort if hash mismatch — drift protection)
 *
 * For now: echo the request and exit 0.
 */
export function update() {
  console.log(
    'hubos-review update: Not yet implemented — coming in EPIC-CICD-002 Story E (update + status).',
  );
  return 0;
}
