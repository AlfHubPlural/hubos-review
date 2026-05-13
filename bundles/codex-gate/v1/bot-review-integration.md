# Bot Review Integration — Detailed Rules

> **Story:** [CICD-E — Unified Bot Review Loop Command](../../docs/stories/CICD-E-unified-bot-review-loop.story.md) (AC#6)
> **Replaces:** `coderabbit-integration.md` (now redirect — see backward compat note at end)
> **Scope:** Unified rules for bot review loop integration (CodeRabbit + Codex + future bots)

This file consolidates self-healing review loop integration for all bots that participate in the AIOX SDC + QA Loop. Each bot section is self-contained; the "Shared Self-Healing Protocol" applies to all.

---

## CodeRabbit

### Self-Healing Configuration

#### Dev Phase (@dev — Story Development Cycle Phase 3)

```yaml
mode: light
max_iterations: 2
timeout_minutes: 30
severity_filter: [CRITICAL, HIGH]
behavior:
  CRITICAL: auto_fix
  HIGH: auto_fix (iteration < 2) else document_as_debt
  MEDIUM: document_as_debt
  LOW: ignore
```

**Flow:**
```
RUN CodeRabbit → CRITICAL found?
  YES → auto-fix (iteration < 2) → Re-run
  NO → Document HIGH as debt, proceed
After 2 iterations with CRITICAL → HALT, manual intervention
```

#### QA Phase (@qa — QA Loop Pre-Review)

```yaml
mode: full
max_iterations: 2
timeout_minutes: 30
severity_filter: [CRITICAL, HIGH]
behavior:
  CRITICAL: auto_fix
  HIGH: auto_fix
  MEDIUM: document_as_debt
  LOW: ignore
```

**Flow:**
1. Pre-commit review scan
2. Self-healing loop (max 2 iterations — aligned with Shared Self-Healing Protocol and CICD-E AC#6)
3. Manual QA analysis (architectural, traceability, NFR)
4. Gate decision (verdict)

### Severity Handling Summary

| Severity | Dev Phase | QA Phase |
|----------|-----------|----------|
| CRITICAL | auto_fix, block if persists | auto_fix, block if persists |
| HIGH | auto_fix, document if fails | auto_fix, document if fails |
| MEDIUM | document_as_tech_debt | document_as_tech_debt |
| LOW | ignore | ignore |

### WSL Execution (Windows)

```bash
# Self-healing mode (automatic in dev tasks)
wsl bash -c 'cd /mnt/c/.../aiox-core && ~/.local/bin/coderabbit --severity CRITICAL,HIGH --auto-fix'

# Manual review
wsl bash -c 'cd /mnt/c/.../aiox-core && ~/.local/bin/coderabbit -t uncommitted'

# Prompt-only mode
wsl bash -c 'cd /mnt/c/.../aiox-core && ~/.local/bin/coderabbit --prompt-only -t uncommitted'
```

### Integration Points

| Workflow | Phase | Trigger | Agent |
|----------|-------|---------|-------|
| Story Development Cycle | 3 (Implement) | After task completion | @dev |
| QA Loop | 1 (Review) | At review start | @qa |
| Standalone | Any | `*coderabbit-review` command | Any |

### Focus Areas by Story Type

| Story Type | Primary Focus |
|-----------|--------------|
| Feature | Code patterns, test coverage, API design |
| Bug Fix | Regression risk, root cause coverage |
| Refactor | Breaking changes, interface stability |
| Documentation | Markdown quality, reference validity |
| Database | SQL injection, RLS coverage, migration safety |

### Report Location

CodeRabbit reports saved to: `docs/qa/coderabbit-reports/`

### Configuration Reference

Full config in `.aiox-core/core-config.yaml` under `coderabbit_integration` section.

---

## Codex Bot (`chatgpt-codex-connector[bot]`)

> **Empirically validated** during CICD-A (PRs #69-#99, 51 inline comments inspected) and migrated to Checks API during CICD-F (2026-05-11, check-run id `75420717933` on PR #99 as pre-merge fixture).
> Source workflow: `.github/workflows/codex-gate.yml` (Checks API since CICD-F; originally REST Statuses API since CICD-A commit `eb28c44` 2026-05-08).

### Bot Identity

- **Login:** `chatgpt-codex-connector[bot]`
- **Type:** GitHub App (OpenAI's automated code review)
- **Status check name:** `codex-review-gate` (constant — referenced by branch protection on `main`)

### Empirical Findings (CICD-A)

#### 1. Priority badge format

Each Codex inline comment starts with a shields.io badge:
```
**<sub><sub>![P{N} Badge](https://img.shields.io/badge/P{N}-{color}?style=flat)</sub></sub>  {Title}**
```

Where `P{N}` is one of: `P1` (orange, CRITICAL) | `P2` (yellow, HIGH) | `P3` (green, LOW — never observed empirically).

#### 2. Empirical priority distribution (PRs #69-#98)

| Severity | Count | % |
|---|---|---|
| **P1** | 25 | 49% |
| **P2** | 26 | 51% |
| **P3** | 0 | 0% |

P3 was never observed in production reviews. Defensive parsers MUST still recognize P3 — but absence in tests is not a blocker.

#### 3. "Clean" behavior (no suggestions)

When Codex has nothing to flag:
- **Does NOT submit a review** (no `pull_request_review` event fires)
- **Adds reaction `+1` (👍)** at issue level on the PR

This is the **rationale for the dual-trigger pattern** below.

#### 4. Review state when suggestions exist

- `state = "COMMENTED"` (never `APPROVED` or `CHANGES_REQUESTED`)
- Review body is generic ("Here are some automated review suggestions...")
- Real suggestions live in **inline review comments**, not in the review body

#### 5. Detection regex (defensive, validated against 51 real comments → 100% coverage)

```regex
P([1-3])\s*Badge|img\.shields\.io/badge/P([1-3])-
```

Tolerant to: case-insensitive matching, whitespace variation, both text "P1 Badge" and URL `badge/P1-` formats.

### Dual-Trigger Pattern (rationale: LL-1)

`codex-gate.yml` MUST trigger on BOTH events:

```yaml
on:
  pull_request_review:
    types: [submitted]
  pull_request:
    types: [opened, synchronize, reopened]
    branches:
      - main
```

Without `pull_request` trigger, clean PRs (where bot only adds reaction +1) leave the gate eternally pending.

### Endpoint Scoping (LL-2 + LL-3)

When fetching comments / reviews, ALWAYS scope to the correct entity:

| Use Case | Endpoint | Reason |
|---|---|---|
| Comments of a specific review | `GET /repos/{owner}/{repo}/pulls/{n}/reviews/{review_id}/comments` | LL-2: global `/comments` returns ALL reviews → stale data poisons new reviews |
| Reviews for a specific SHA | `GET /repos/{owner}/{repo}/pulls/{n}/reviews` then filter `commit_id == HEAD_SHA` | LL-3: in fix-up flows, prior-commit reviews short-circuit decisions for the new SHA |

Empirically validated on PR #99 review `4253036883` against commit `1490544f`.

### Severity Mapping (Codex → Gate Verdict)

> **Updated by CICD-F (2026-05-11):** gate publishes via the Checks API (`conclusion: ...`), no longer the REST Statuses API. Native `neutral` replaces the legacy `(neutral)` substring workaround on description (LL-4 RESOLVED — see archive note below).

| Bot output | Gate `conclusion` | Verdict | Description |
|---|---|---|---|
| P1 or P2 found | `failure` | REJECT | "{N} P1 + {M} P2 blocking suggestions" |
| Only P3 found | `success` | PASS | "No blocking issues; {K} P3 logged to backlog" |
| No badges, review with empty body | `success` | PASS | "No blocking suggestions" |
| No review + reaction `+1` | `success` | PASS | "Codex approved (no suggestions)" |
| 5min timeout, bot silent | `neutral` (native) | NEUTRAL | "Codex did not respond within 5 minutes" — non-blocking |

### LL-4 (archive) — Statuses API `neutral` workaround [RESOLVED 2026-05-11 via CICD-F]

> Historical context preserved for audit trail. Do NOT reintroduce the workaround.

Prior to CICD-F, the gate used the REST Statuses API, which only accepts `error | failure | pending | success`. The "neutral" verdict (5-minute timeout, bot silent) was emulated as `state=success` with the **literal substring** `(neutral)` in the description, forcing parsers to inspect the description string in addition to the state. CICD-F migrated `codex-gate.yml` to the Checks API, where `conclusion: neutral` is a first-class value. Empirically validated via check-run id `75420717933` on PR #99 during F.2.8 pre-merge dry run (gate published `conclusion: neutral` natively, no description substring). The parser in `qa-bot-loop.md` Step 2 now reads `conclusion` directly (with `ascii_downcase` normalization, since `gh pr view --json` returns uppercase `CONCLUSION` for CheckRun nodes) and falls back to StatusContext `state` for other bots that may not yet have migrated.

---

## Shared Self-Healing Protocol

> Conventions adopted by EPIC-CICD-001 and inherited by all bot integrations. **Do NOT modify without `*correct-course`** on the epic.

### Severity → Block Decision

| Severity | Blocks merge? | Action |
|---|---|---|
| **P1** (CRITICAL) | **YES** | Auto-fix in dev loop; escalate after `max_iterations` |
| **P2** (HIGH) | **YES** | Auto-fix in dev loop; escalate after `max_iterations` |
| **P3** (LOW) | NO | Log to backlog (GitHub Issue with label `cicd-p3-backlog`) |

P1+P2 both block — Alf's decision (2026-05-08).

### Loop Limits

| Parameter | Value | Rationale |
|---|---|---|
| `max_iterations` | **2** | After 2 unresolved cycles, escalate manually |
| `timeout_minutes` (async bots) | **5** | Bot has 5min to respond after PR event |
| `polling_interval_seconds` | **60** | Active session polls `statusCheckRollup` every 60s while `PENDING` |
| Escalation threshold | `iteration >= max_iterations` | Stops loop, posts escalation PR comment |

### Iteration Counter Rules (D-G of CICD-E)

Counter increments are **deterministic** with manual override available via `*set-iter-counter`:

1. **Fix-up on same PR** (same storyId, same prNumber, new SHA) → does NOT increment
2. **New SHA with new review event** → increments
3. **Workflow not yet running on protected main** → forces `iterationCount=0` (does not count)
4. **Verdict BLOCKED** → escalates immediately, regardless of counter

Each decision is recorded in `decisions[]` of `.aiox/qa-loop-state.json` with `{iteration, sha, counted: bool, reason: "rule-{N}"}`.

**Manual override:** `*set-iter-counter {storyId} {value} --reason "..."` records `{type: "manual-override", setBy: "operator", reason}` in `decisions[]`.

### Escalation Flow

When `iterationCount >= max_iterations` without resolution:
1. Loop stops automatically (no more review cycles attempted)
2. PR comment is created (or updated in-place if `syncedToComment` already exists) with:
   - Story ID
   - Iterations consumed
   - Last 3 verdicts
   - Unresolved P1/P2 list with file/line refs
   - Link to `.aiox/qa-loop-state.json` or relevant handoff
3. Operator (Alf) is notified for manual decision
4. State file updated: `lastVerdict: "ESCALATED"`, `syncedToComment: {commentNumber}`

### State File (`.aiox/qa-loop-state.json`)

Schema v1.0 (gitignored — runtime only):

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

Required fields: `schemaVersion`, `storyId`, `prNumber`, `iterationCount`, `maxIterations`, `lastSha`, `lastVerdict`, `decisions[]`, `syncedToComment`.

Writes MUST be atomic (`tmp file + rename` in same directory).

### Happy Path

```
@devops *create-pr
  → PR opened
  → bot gate workflow runs (dual-trigger pattern)
  → commit status published on {botName}-review-gate
  → *qa-bot-loop {bot}  (or just *qa-bot-loop with default bot=codex)
    → fetchBotReviewStatus(prNumber, botName)
      → verdict=PASS    → SDC proceeds
      → verdict=REJECT  → fetchBlockingSuggestions(prNumber, reviewId)
                        → return to @dev with structured {p1, p2, suggestions}
                        → @dev fixes → new push
                        → update state (D-G iteration counter rules)
                        → loop
      → verdict=NEUTRAL → proceed without blocking
      → iterationCount >= maxIterations → escalation + PR comment
```

---

## Bot Integration Contract (multi-bot abstraction — AC#12)

> Required reading for anyone integrating a new bot into `*qa-bot-loop`.

To integrate a new bot, configure these fields:

| Field | Description | Example (Codex) |
|---|---|---|
| `botName` | CLI argument for `*qa-bot-loop {botName}` | `codex` |
| `checkName` | Check Run / Status Context name (must match the workflow's check-run `name` field) | `codex-review-gate` |
| `checkApi` | Which GitHub API the gate publishes to. `checks` (post-CICD-F, native `neutral`) or `statuses` (legacy, requires description-substring workaround for `neutral`) | `checks` |
| `botLogin` | GitHub user login of the bot account | `chatgpt-codex-connector[bot]` |
| `cleanSignal` | How the bot signals "no issues" | Reaction `+1` on the issue (no review event) |
| `priorityRegex` | Regex to extract priority badges from comment bodies (case-insensitive) | `P([1-3])\s*Badge\|img\.shields\.io/badge/P([1-3])-` |
| `severityMapping` | Map of bot priorities → Gate verdict | P1/P2 → REJECT, P3 → PASS+backlog, none → PASS |
| `commentEndpoint` | Review-scoped endpoint to fetch comments | `/repos/{owner}/{repo}/pulls/{n}/reviews/{review_id}/comments` |
| `expectedReviewState` | The `state` value the bot uses on its `PullRequestReview` (orthogonal to the gate's `conclusion`) | `COMMENTED` |
| `expectedCheckConclusion` | Map of gate-published `conclusion` values (Checks API) when `checkApi: checks`. The `*qa-bot-loop` parser uses this to translate the published signal into a verdict | `blocking: failure`, `clean: success`, `silent: neutral` |

### Integration steps

1. **Create the gate workflow** in `.github/workflows/{bot}-gate.yml` following `codex-gate.yml` as reference (dual-trigger, review-scoped lookups, `-f context="{checkName}"`).
2. **Document the bot section** in this file (under "## {Bot Name}" — mirror Codex section structure).
3. **Add bot config** to the `*qa-bot-loop` task definition (`.aiox-core/development/tasks/qa-bot-loop.md`) under "Supported Bots".
4. **Validate empirically** by exercising `*qa-bot-loop {botName}` against a fixture PR (per LL-6).
5. **Verify branch protection** registers the new check (handoff to @devops).

### Anti-patterns (do NOT do these)

- ❌ Use the global endpoint `/pulls/{n}/comments` (violates LL-2 — stale data leaks across reviews)
- ❌ Ignore `commit_id` filter when reading reviews (violates LL-3 — fix-up flow becomes non-idempotent)
- ❌ Add a single trigger (`pull_request_review` only) — clean PRs hang forever (violates LL-1)
- ❌ Bypass the state file and store iteration counter elsewhere (violates D-B)
- ❌ Reintroduce the REST Statuses API for the Codex gate (regression of CICD-F — Checks API is the current contract; `conclusion: neutral` is native, do not re-emulate via a description substring on a `success` status)

---

## References

| Reference | Location |
|---|---|
| Story (Bot Review Loop) | `docs/stories/CICD-E-unified-bot-review-loop.story.md` |
| Story (Codex Gate Origin) | `docs/stories/CICD-A-codex-bot-review-gate.story.md` |
| Story (Checks API Migration + BUG-3) | `docs/stories/CICD-F-checks-api-migration.story.md` |
| Epic (CI/CD Automation) | `docs/stories/epic-cicd-automation.md` |
| Workflow (Codex gate, in production — Checks API since CICD-F) | `.github/workflows/codex-gate.yml` |
| Task (`*qa-bot-loop`) | `.aiox-core/development/tasks/qa-bot-loop.md` |
| Task (`*set-iter-counter`) | `.aiox-core/development/tasks/set-iter-counter.md` |
| State file schema | `.aiox/qa-loop-state.json` (gitignored) |
| Backward compat redirect | `.claude/rules/coderabbit-integration.md` |

---

## Backward Compatibility Note

This file replaced `.claude/rules/coderabbit-integration.md` on **2026-05-09** (CICD-E). The old file remains as a redirect (header pointing here) so that existing references continue to work. The file `coderabbit-integration.md` is also kept in the rules registry (`.aiox-core/core/doctor/checks/rules-files.js` `EXPECTED_RULES`) intentionally — removing it would fail `aiox doctor`.

References in the codebase (templates `coderabbit-integration` section IDs, `claude-rules.md` registry entries) refer to the *integration concept*, which is now hosted here. They do NOT need to be renamed.
