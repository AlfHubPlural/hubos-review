# QA Bot Review Loop Task

> **Story:** [CICD-E — Unified Bot Review Loop Command](../../../docs/stories/CICD-E-unified-bot-review-loop.story.md)
> **Phase:** Post-PR Review Loop (between `*create-pr` and merge)
> **Owner Agent:** @aiox-master (default) | @dev (when invoked from inside SDC) | @qa (when invoked from QA Loop)
> **Command:** `*qa-bot-loop [bot-name]` (default `bot-name=codex`)
> **Resume:** `*qa-bot-loop {storyId} --resume`
> **Rule:** [`bot-review-integration.md`](../../../.claude/rules/bot-review-integration.md)

---

## Purpose

Consume the commit status published by a bot review gate workflow (e.g., `codex-gate.yml`) and orchestrate the AIOX side of the review loop:

- **F-1 solved:** Auto-detect when the bot finishes reviewing (no email-watching).
- **F-2 solved:** Ingest the review structurally (no copy-paste).
- **F-3 solved:** Apply deterministic iteration counter rules (no manual ambiguity).
- **F-4 solved:** Auto-return to SDC when P1/P2 found (no manual "voltar ao SDC").

This task does NOT reimplement bot detection — it consumes the signal already produced by `.github/workflows/{bot}-gate.yml` (D-A of CICD-E).

---

## CRITICAL CONSTRAINTS

- **Do NOT regress** `.github/workflows/codex-gate.yml` to the REST Statuses API (CICD-F migrated it to Checks API on 2026-05-11; `conclusion: neutral` is now native — do not re-emulate via description substring).
- **Do NOT use the global** `/pulls/{n}/comments` endpoint (LL-2 — leaks stale data across reviews).
- **Do NOT skip the `commit_id == HEAD_SHA` filter** when reading reviews (LL-3 — fix-up flow becomes non-idempotent without it).
- **Do NOT increment the iteration counter** outside the 4 deterministic rules (D-G of CICD-E).
- **Do NOT post PR comments** outside escalation path (D-E of CICD-E) — caminho feliz is silent on the PR.

---

## Inputs

| Name | Required | Description |
|---|---|---|
| `bot-name` | No (default `codex`) | Identifier of the bot. Each bot has a registered config in "Supported Bots" below. |
| `storyId` | Inferred | Story currently in InReview status (read from active story file). |
| `prNumber` | Inferred | PR number open for this branch (`gh pr view --json number --jq .number`). |
| `--resume` | No flag | If set, do NOT re-initialize state file; load existing state and continue from `lastSha` + `iterationCount`. |

---

## Supported Bots

> Add new bots here with the same structure (per "Bot Integration Contract" in `bot-review-integration.md`).

### `codex` (default)

```yaml
botName: codex
checkName: codex-review-gate
botLogin: chatgpt-codex-connector[bot]
cleanSignal: reaction +1 on PR issue
priorityRegex: 'P([1-3])\s*Badge|img\.shields\.io/badge/P([1-3])-'  # case-insensitive
severityMapping:
  P1: REJECT       # blocking (CRITICAL)
  P2: REJECT       # blocking (HIGH)
  P3: PASS+backlog # non-blocking; logged via codex-gate.yml to label cicd-p3-backlog
commentEndpoint: '/repos/{owner}/{repo}/pulls/{n}/reviews/{review_id}/comments'
expectedReviewState: COMMENTED
```

---

## Procedure

### Step 0 — Pre-flight checks

```bash
# 0.1: Ensure gh is authenticated
gh auth status >/dev/null 2>&1 || { echo "ERROR: gh not authenticated"; exit 2; }

# 0.2: Confirm a PR is open for the current branch
PR_NUMBER=$(gh pr view --json number --jq .number 2>/dev/null) || {
  echo "ERROR: No open PR for current branch. Run @devops *create-pr first."; exit 2;
}

# 0.3: Confirm story is in InProgress or InReview
STORY_FILE=$(find docs/stories -name "*.story.md" -newer .git/HEAD 2>/dev/null | head -1)
[ -z "$STORY_FILE" ] && { echo "WARN: Could not auto-detect active story; proceeding with --story arg"; }
```

If `bot-name` is not in "Supported Bots": fail with message
`"Bot '{bot-name}' not configured. Add config block in qa-bot-loop.md or use 'codex' (default)."`

### Step 1 — Load or initialize state file

State file path: `.aiox/qa-loop-state.json`

If `--resume` is set:
1. Read state file. If absent: print `"No state found for {storyId}. Start a new cycle with: *qa-bot-loop {bot-name}"` and exit 1.
2. Validate `schemaVersion == "1.0"`. If different: print upgrade-required message and exit.
3. Load `iterationCount`, `lastSha`, `lastVerdict`, `decisions[]`. Print: `"Resuming loop {storyId} — iter {N}/{maxIter}, last verdict: {lastVerdict}, SHA: {sha}"`.

If NOT `--resume`:
1. If state file exists: archive it to `.aiox/qa-loop-state.{ts}.json.bak` (preserve audit trail).
2. Initialize new state per Schema v1.0 (see "State File Schema" below).

### Step 2 — Fetch bot review status (`fetchBotReviewStatus`)

> **Updated by CICD-F (2026-05-11):** `codex-gate.yml` now publishes a Check Run via the Checks API (not a Status Context via the Statuses API). `conclusion` is native — no more `(neutral)` substring workaround on the description (LL-4 RESOLVED). Empirical finding from F.1.2 + F.2.8: `gh pr view --json statusCheckRollup` returns `conclusion` UPPERCASE for CheckRun nodes (`SUCCESS | FAILURE | NEUTRAL | ...`) — normalize via `ascii_downcase`. StatusContext branch is preserved as fallback for the transition window F.6.0–F.6.2 (when branch protection still references the old context) and for any future bot that hasn't migrated.

```bash
# Output: signal, verdict, headSha (signal = conclusion for CheckRun OR state for StatusContext)
RAW=$(gh pr view "$PR_NUMBER" --json statusCheckRollup,headRefOid)
HEAD_SHA=$(echo "$RAW" | jq -r '.headRefOid')

# Filter the rollup for this bot's check.
# Prefer CheckRun (Checks API, post-CICD-F) and fall back to StatusContext
# (Statuses API, pre-CICD-F or other bots) — both filtered by name with
# ascii_downcase on the returned conclusion/state for case-insensitive matching.
SIGNAL=$(echo "$RAW" | jq -r --arg ctx "${BOT_CHECK_NAME}" '
  (
    .statusCheckRollup[]
    | select(.__typename == "CheckRun" and .name == $ctx)
    | .conclusion // "pending"
  )
  // (
    .statusCheckRollup[]
    | select(.__typename == "StatusContext" and .context == $ctx)
    | .state
  )
  // empty
  | ascii_downcase
')

if [ -z "$SIGNAL" ]; then
  VERDICT="PENDING"
  SIGNAL="pending"
else
  # Single mapping for both CheckRun.conclusion and StatusContext.state.
  # Native `neutral` from Checks API replaces the legacy `(neutral)` substring
  # workaround on description (LL-4 RESOLVED 2026-05-11 via CICD-F).
  case "$SIGNAL" in
    failure|cancelled|timed_out|action_required) VERDICT="REJECT" ;;
    pending) VERDICT="PENDING" ;;
    neutral|skipped)                              VERDICT="NEUTRAL" ;;
    success)                                      VERDICT="PASS" ;;
    *)                                            VERDICT="UNKNOWN" ;;
  esac
fi
```

Returns `{signal, verdict, headSha}` (where `signal` is the normalized lowercase `conclusion` for CheckRun or `state` for StatusContext).

### Step 3 — Branch on verdict

#### Step 3a — `verdict == PASS`

1. Update state file: `lastSha=headSha`, `lastVerdict="PASS"`. Persist atomically (Step 7).
2. Print `"PASS: bot review clean for {bot-name} on {prNumber} @ {headSha}"`.
3. Exit with code 0 — caller (SDC) proceeds to next step.

#### Step 3b — `verdict == NEUTRAL` (gate published `conclusion: neutral`)

NEUTRAL is now a first-class signal from the Checks API (CICD-F). The gate workflow publishes `conclusion: neutral` on its `clean-or-timeout` job when the 5-min wait elapses without a bot response, OR `conclusion: skipped` when intentionally bypassed. Both map here.

1. Update state: `lastSha=headSha`, `lastVerdict="NEUTRAL"`. Do NOT increment `iterationCount` (NEUTRAL is not a review iteration).
2. Print `"NEUTRAL: bot did not produce a blocking verdict. Proceeding without blocking."`.
3. Exit 0.

#### Step 3c — `verdict == PENDING`

1. If active session: sleep 60s and goto Step 2 (`polling_interval_seconds = 60`).
2. Track total wait; if exceeds `timeout_minutes * 60 = 300s + buffer`: surface a clear "still pending" status to operator.
3. NEVER busy-loop without sleep.

#### Step 3d — `verdict == REJECT` (P1 or P2 found)

1. Find the relevant `review_id` (most recent review by `botLogin` for the current SHA):
   ```bash
   REVIEW_ID=$(gh api "repos/$OWNER/$REPO/pulls/$PR_NUMBER/reviews" \
     --jq "[.[] | select(.user.login==\"$BOT_LOGIN\" and .commit_id==\"$HEAD_SHA\")] | sort_by(.submitted_at) | last | .id")
   ```
2. Apply `fetchBlockingSuggestions` (Step 4).
3. Apply iteration counter rules (Step 5).
4. If `iterationCount >= maxIterations`: trigger escalation (Step 6).
5. Otherwise: hand off to @dev with structured payload (Step 8).

### Step 4 — Fetch blocking suggestions (`fetchBlockingSuggestions`)

CRITICAL: use the **review-scoped** endpoint (LL-2), not the global one.

```bash
# Per LL-2: endpoint MUST be review-scoped, not /pulls/{n}/comments.
# Per gh CLI manual: when --paginate is combined with --jq, each page emits a
# separate JSON document. Use --slurp to flatten all pages into a single array
# BEFORE passing to jq, otherwise multi-page reviews produce multiple top-level
# arrays and downstream `--argjson` operations break (P2 fix from PR #104).
COMMENTS=$(gh api "repos/$OWNER/$REPO/pulls/$PR_NUMBER/reviews/$REVIEW_ID/comments" \
  --paginate --slurp \
  --jq "[.[] | .[] | select(.user.login==\"$BOT_LOGIN\")]")

# Extract priority badges with the regex from rule
P1_LIST=$(echo "$COMMENTS" | jq -c \
  '[.[] | select(.body | test("P1\\s*Badge|img\\.shields\\.io/badge/P1-"; "i")) |
    {priority: "P1", file: .path, line: (.line // .original_line // 0), summary: (.body | split("\n")[0]), url: .html_url}]')
P2_LIST=$(echo "$COMMENTS" | jq -c \
  '[.[] | select(.body | test("P2\\s*Badge|img\\.shields\\.io/badge/P2-"; "i")) |
    {priority: "P2", file: .path, line: (.line // .original_line // 0), summary: (.body | split("\n")[0]), url: .html_url}]')
P3_LIST=$(echo "$COMMENTS" | jq -c \
  '[.[] | select(.body | test("P3\\s*Badge|img\\.shields\\.io/badge/P3-"; "i")) |
    {priority: "P3", file: .path, line: (.line // .original_line // 0), summary: (.body | split("\n")[0]), url: .html_url}]')

P1_COUNT=$(echo "$P1_LIST" | jq 'length')
P2_COUNT=$(echo "$P2_LIST" | jq 'length')
P3_COUNT=$(echo "$P3_LIST" | jq 'length')

BLOCKING_SUGGESTIONS=$(jq -n --argjson a "$P1_LIST" --argjson b "$P2_LIST" '$a + $b')
```

Returns `{p1_count, p2_count, p3_count, blocking_suggestions: [{priority, file, line, summary, url}]}`.

### Step 5 — Iteration counter (4 rules of D-G)

Apply rules **in order**. The first rule that matches decides.

**Rule 4 (highest priority — short-circuit):** if `verdict == BLOCKED` (e.g., bot reported irrecoverable error), escalate immediately (Step 6) regardless of counter. Record `decisions[]` entry: `{iteration: <prev>, sha: HEAD_SHA, counted: false, reason: "rule-4 blocked"}`.

**Rule 3:** if "gate not yet running on protected main" — heuristic per OBS-1 of CICD-E:
```bash
# Probe both signals INDEPENDENTLY and capture exit status for each gh call.
# IMPORTANT: only auto-zero when BOTH probes succeed AND the data conclusively
# says "gate not yet in production". Any ambiguity falls through to Rule 1/2.
PROTECTED="unknown"
gh api "repos/$OWNER/$REPO/branches/main/protection" --silent >/dev/null 2>&1
PROTECTION_RC=$?
if [ $PROTECTION_RC -eq 0 ]; then
  PROTECTED="yes"
elif [ $PROTECTION_RC -eq 1 ]; then
  # gh exits 1 specifically when protection is absent (404). That's a
  # conclusive "no" — branch unprotected, gate cannot be enforced yet.
  PROTECTED="no"
fi
# else: any other exit code (auth, rate-limit, network) leaves PROTECTED=unknown.

LAST_MAIN_RUN=""
LAST_MAIN_RUN_RC=1
if RUN_OUT=$(gh run list --workflow="${BOT_CHECK_NAME%-review-gate}-gate.yml" \
              --branch=main --limit=1 --json conclusion 2>/dev/null); then
  LAST_MAIN_RUN=$(echo "$RUN_OUT" | jq -r '.[0].conclusion // ""')
  LAST_MAIN_RUN_RC=0
fi

# Auto-zero ONLY in the unambiguous "not yet in production" scenario:
#   PROTECTED == "no"  OR  (run-list succeeded AND last conclusion != "success").
if [ "$PROTECTED" = "no" ] || \
   { [ $LAST_MAIN_RUN_RC -eq 0 ] && [ -n "$LAST_MAIN_RUN" ] && [ "$LAST_MAIN_RUN" != "success" ]; }; then
  ITERATION_COUNT=0
  RULE_REASON="rule-3 gate-not-in-production"
fi
```
**Conservative fallback (R-2 of CICD-E):** if any `gh` call fails or output is ambiguous (`PROTECTED=unknown`, run-list non-zero, empty conclusion), do NOT auto-zero. Continue to Rule 1/2. Operator may force `iter=0` via `*set-iter-counter` after manual inspection. Rationale: a silent reset on a transient API error would let failed review cycles bypass `maxIterations` and never escalate.

**Rule 1:** fix-up on the same PR — `prevPrNumber == prNumber AND prevSha != HEAD_SHA AND prevSha != ""` → do NOT increment. Record `{counted: false, reason: "rule-1 fixup-same-pr"}`.

**Rule 2:** new SHA with new review event — `prevSha == "" OR prevSha == HEAD_SHA-but-new-review` → DO increment. Record `{counted: true, reason: "rule-2 new-sha"}`.

In all cases: append entry to `decisions[]`, persist state, then proceed.

### Step 6 — Escalation flow (when `iterationCount >= maxIterations`)

> Triggered when iteration counter reaches `maxIterations` (default 2) without a `PASS` verdict.

```bash
# Build escalation comment body
LAST3=$(jq -c '.decisions | sort_by(.iteration) | reverse | .[0:3]' .aiox/qa-loop-state.json)

BODY=$(cat <<EOF
**🚨 CICD-E escalation: \`*qa-bot-loop $BOT_NAME\` reached max_iterations=$MAX_ITERATIONS without resolution.**

- Story: \`$STORY_ID\`
- Iterations consumed: \`$ITERATION_COUNT/$MAX_ITERATIONS\`
- Last verdicts: $LAST3

**Unresolved P1 (CRITICAL):** $P1_COUNT
$(echo "$P1_LIST" | jq -r '.[] | "- \(.summary) — [\(.file):L\(.line)](\(.url))"')

**Unresolved P2 (HIGH):** $P2_COUNT
$(echo "$P2_LIST" | jq -r '.[] | "- \(.summary) — [\(.file):L\(.line)](\(.url))"')

State file: \`.aiox/qa-loop-state.json\` (gitignored).
Manual override available: \`*set-iter-counter $STORY_ID 0 --reason "..."\`.
EOF
)

# Post (or update in-place) — idempotent.
# BUG-3 fix (CICD-F, closes CICD-E-G-3): if syncedToComment was manually deleted
# from the PR, the PATCH call below returns 404. Without recovery, the escalation
# silently fails and the operator never sees the alert. Recovery: detect the 404,
# recreate the comment via POST, and persist the new ID atomically before exit.
SYNCED=$(jq -r '.syncedToComment // empty' .aiox/qa-loop-state.json)

post_comment_and_persist() {
  # Creates a fresh issue comment and writes the new ID into syncedToComment
  # using Step 7 atomic-rename pattern. Returns 0 on success, 1 on failure.
  local new_id
  new_id=$(gh api "repos/$OWNER/$REPO/issues/$PR_NUMBER/comments" \
    -f body="$BODY" --jq '.id') || return 1
  jq --arg id "$new_id" '.syncedToComment = ($id|tonumber)' \
    .aiox/qa-loop-state.json > .aiox/qa-loop-state.json.tmp.$$ || return 1
  mv .aiox/qa-loop-state.json.tmp.$$ .aiox/qa-loop-state.json
  echo "$new_id"
}

if [ -z "$SYNCED" ]; then
  post_comment_and_persist >/dev/null \
    || { echo "ERROR: failed to create escalation comment on PR #$PR_NUMBER"; exit 3; }
else
  # Attempt PATCH; capture stderr to distinguish 404 (deleted) from other errors.
  PATCH_ERR=$(gh api -X PATCH "repos/$OWNER/$REPO/issues/comments/$SYNCED" \
    -f body="$BODY" 2>&1 >/dev/null)
  PATCH_RC=$?
  if [ $PATCH_RC -ne 0 ]; then
    if echo "$PATCH_ERR" | grep -qiE 'HTTP 404|Not Found'; then
      # BUG-3 recovery path — comment was manually deleted from the PR.
      echo "WARN: syncedToComment=$SYNCED returned 404 (manually deleted). Recreating."
      post_comment_and_persist >/dev/null \
        || { echo "ERROR: failed to recreate escalation comment on PR #$PR_NUMBER"; exit 3; }
    else
      # Non-404 failure (auth, rate limit, network). Do not silently recreate
      # — that would duplicate comments when the underlying comment still exists.
      echo "ERROR: PATCH escalation comment failed: $PATCH_ERR"
      exit 3
    fi
  fi
fi

# Update state
jq --arg sha "$HEAD_SHA" '.lastVerdict = "ESCALATED" | .lastSha = $sha' .aiox/qa-loop-state.json > .aiox/qa-loop-state.json.tmp.$$
mv .aiox/qa-loop-state.json.tmp.$$ .aiox/qa-loop-state.json

# Notify operator and stop loop (do NOT exit 1 — escalation is a final state, not error)
echo "ESCALATED: max_iterations reached. Comment posted/updated on PR #$PR_NUMBER. Operator decision required."
exit 0
```

The same comment is reused for "state sync" requests (AC#8) — never create duplicate comments.

### Step 7 — Atomic state file write

Always use temp-file + rename in the SAME directory (POSIX atomic on same filesystem):

```bash
write_state_atomic() {
  local target="$1"
  local content="$2"
  local tmp="${target}.tmp.$$"
  printf '%s\n' "$content" > "$tmp" || { rm -f "$tmp"; return 1; }
  mv "$tmp" "$target"
}
```

Schema validation on read: if `schemaVersion != "1.0"` reject the file with a clear upgrade message (do not silently mutate).

### Step 8 — Hand off REJECT to @dev (F-2 + F-4)

Build structured payload and pass to @dev. The payload is the canonical "ingestion result" (no copy-paste required):

```json
{
  "storyId": "CICD-E",
  "prNumber": 99,
  "sha": "1490544f",
  "verdict": "REJECT",
  "iteration": 1,
  "p1_count": 2,
  "p2_count": 0,
  "p3_count": 0,
  "blocking_suggestions": [
    {"priority": "P1", "file": "...", "line": 12, "summary": "...", "url": "https://github.com/.../#issuecomment-..."}
  ],
  "next_action": "fix_p1_p2_then_push"
}
```

The session presents this to @dev so the next iteration of the SDC fixes the listed items and pushes a new SHA. @dev does NOT need to fetch the comments again — they are already extracted.

---

## State File Schema (v1.0)

Location: `.aiox/qa-loop-state.json` (gitignored — runtime only)

```json
{
  "schemaVersion": "1.0",
  "storyId": "CICD-E",
  "prNumber": 99,
  "iterationCount": 0,
  "maxIterations": 2,
  "lastSha": "",
  "lastVerdict": "PENDING",
  "decisions": [],
  "syncedToComment": null
}
```

**Required fields:** `schemaVersion`, `storyId`, `prNumber`, `iterationCount`, `maxIterations`, `lastSha`, `lastVerdict`, `decisions[]`, `syncedToComment`.

**`decisions[]` entry shape:**
```json
{
  "iteration": 1,
  "sha": "1490544f",
  "counted": true,
  "reason": "rule-2 new-sha",
  "type": "auto",
  "timestamp": "2026-05-09T12:34:56Z"
}
```
Manual overrides (from `*set-iter-counter`) use `type: "manual-override"` and `setBy: "operator"`.

**Validation:** Implementations SHOULD expose `validateSchema(state)` as a standalone function (per OBS-2 of CICD-E) so future schema versions (1.1+) can plug in without rewriting the loop. The canonical JSON Schema lives at [`.aiox-core/data/qa-loop-state-schema.json`](../../data/qa-loop-state-schema.json) and can be consumed by any JSON Schema validator (e.g., `ajv`).

---

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Normal exit (PASS, NEUTRAL, REJECT-handed-off-to-dev, or ESCALATED) |
| 1 | Resume requested but state file missing |
| 2 | Pre-flight failed (no PR, no auth, unknown bot) |
| 3 | State file corrupted or wrong schema version |

---

## Acceptance Criteria Mapping

| AC# | Step(s) covered |
|---|---|
| AC#1 | Step 2 — `fetchBotReviewStatus` consumes `statusCheckRollup` |
| AC#2 | Steps 3d, 4, 8 — REJECT path with structured ingestion |
| AC#3 | Step 3a — PASS path |
| AC#4 | Step 6 — escalation with PR comment |
| AC#5 | Step 3b — NEUTRAL, no counter increment |
| AC#7 | Steps 1, 7 — schema v1.0, atomic write |
| AC#8 | Step 6 — same comment reused for state sync (idempotent) |
| AC#9 | Step 5 — 4 deterministic rules of D-G |
| AC#11 | Step 1 — `--resume`; entire task supports `[bot-name]` arg |
| AC#13 | Validated by running this task against the very PR delivering CICD-E |

---

## Notes for the executing agent

- **In YOLO mode (default for `*qa-bot-loop`)**: run Steps 0 → 6 sequentially without prompting; only prompt the operator on ESCALATED.
- **In Interactive mode**: pause before Step 6 to confirm escalation (operator may want to bump max_iterations one-off).
- **Decision audit:** every iteration counter decision (auto OR manual-override) MUST be recorded in `decisions[]` with timestamp.
- **Idempotency:** running `*qa-bot-loop` twice in quick succession with no new SHA is a no-op (state already captures `lastSha`).

---

*Task created by @dev (Dex) on 2026-05-09 implementing CICD-E (Tasks E.2, E.3 partial, E.4, E.5).*
*Updated by @aiox-master (Orion) on 2026-05-11 implementing CICD-F (Tasks F.3 BUG-3 recovery + F.4 parser uses Checks API `conclusion` natively, StatusContext kept as fallback during BP transition window F.6.0–F.6.2).*
