# hubos-review

> Standalone CLI to install portable PR review gates (codex-gate, etc.) on any GitHub repo.
> Part of the **hub-os ecosystem** by [Alfredo Carneiro Júnior](https://github.com/AlfHubPlural).

[![npm](https://img.shields.io/npm/v/@hubplural/hubos-review/beta.svg)](https://www.npmjs.com/package/@hubplural/hubos-review)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Node.js ≥ 20](https://img.shields.io/badge/node-%E2%89%A520-brightgreen.svg)](https://nodejs.org/)

---

## Status

**v0.4.0 (beta) — Story E landed.** EPIC-CICD-002 is feature-complete. The 4 sub-commands are now ALL real: `install`, `verify`, `status`, `update`. `status` audits drift (sha256 vs install record, npm registry, branch protection); `update` bumps the installed gate in place with local-modification protection.

| Sub-command | What it does today | Landed in |
|---|---|---|
| `install codex-gate` | Copies 3 frozen artifacts + writes `.aiox/cicd-version` + (Story D) configures branch protection | ✅ Story B (v0.2.0) + Story D (v0.3.0) |
| `verify` | Runs 8 pre-flight checks with severity-based exit codes (CRITICAL/HIGH FAIL → exit 1) | ✅ Story C (v0.3.0) |
| `status` | Reads `.aiox/cicd-version` → per-file sha256 check + npm registry lookup + branch protection probe | ✅ Story E (v0.4.0) |
| `update` | Bumps installed gate to latest bundle with diff + TTY prompt + local-modification guard | ✅ Story E (v0.4.0) |

---

## Quick start

```bash
# Install globally (beta channel during MVP — D-002-11)
npm install -g @hubplural/hubos-review@beta

# Inside any git repo:
cd ~/your-repo
hubos-review install codex-gate
```

That single command:

1. Copies `.github/workflows/codex-gate.yml`, `.aiox-core/development/tasks/qa-bot-loop.md`, and `.claude/rules/bot-review-integration.md` from the bundled `codex-gate` v1 snapshot.
2. Writes `.aiox/cicd-version` (JSON) with per-file SHA-256 hashes so drift can be detected later.
3. Prints next steps (branch protection — Story D — and verification — Story C).

Requires **Node.js ≥ 20** (tested on 20 and 22 in CI). Target must be a **git repo** (the command aborts otherwise).

---

## Install Codex Gate — detailed usage

```bash
hubos-review install codex-gate [options]
```

| Flag | Default | What it does |
|---|---|---|
| `--force` | off | Overwrite the existing `.aiox/cicd-version` and reinstall every bundle file. Use after `hubos-review update` is released (Story E) or to recover from a corrupted install. |
| `--dry-run` | off | List every file that would be copied (with `OVERWRITES existing` markers when applicable) and exit. **No filesystem changes are made.** Combine with `--force` to preview a reinstall. |
| `--target <path>` | CWD | Target a different repo. The path must still be a git repo. |
| `--bundle-version <slug>` | `v1` | Pick a specific bundle version. Only `v1` ships today. |
| `--auto-protect` | off | Apply branch protection without prompting (Story D). Useful in CI/automation. Mutually exclusive with `--skip-protection`. |
| `--skip-protection` | off | Skip branch protection entirely (Story D). The bundle files are still copied. Mutually exclusive with `--auto-protect`. |
| `--branch <name>` | `main` | Branch to protect (Story D). |

### Idempotence

Running `hubos-review install codex-gate` twice without `--force` is a no-op on the second run — the command detects the existing `.aiox/cicd-version` and exits cleanly (exit code 0) without overwriting anything. To reinstall, pass `--force`.

### Committing `.aiox/cicd-version`

`.aiox/cicd-version` is **intentionally tracked in git** (decision D-002-8 in the parent epic). It records which bundle version is installed and the SHA-256 of every artifact, so anyone reading the repo can audit drift. After `install`, remember to:

```bash
git add .aiox/cicd-version .github/workflows/codex-gate.yml \
        .aiox-core/development/tasks/qa-bot-loop.md \
        .claude/rules/bot-review-integration.md
git commit -m "chore: install codex-gate v1 via hubos-review"
```

### Example: dry-run output on a fresh repo

```
$ hubos-review install codex-gate --dry-run
hubos-review install codex-gate v1 — DRY RUN (no writes)
Target repo: /Users/you/your-repo
Bundle: /Users/you/your-repo/node_modules/@hubplural/hubos-review/bundles/codex-gate/v1

Files that would be copied:
  codex-gate.yml
    from: ...bundles/codex-gate/v1/codex-gate.yml
    to:   /Users/you/your-repo/.github/workflows/codex-gate.yml
  qa-bot-loop.md
    from: ...bundles/codex-gate/v1/qa-bot-loop.md
    to:   /Users/you/your-repo/.aiox-core/development/tasks/qa-bot-loop.md
  bot-review-integration.md
    from: ...bundles/codex-gate/v1/bot-review-integration.md
    to:   /Users/you/your-repo/.claude/rules/bot-review-integration.md

Would be created: /Users/you/your-repo/.aiox/cicd-version

No filesystem changes were made.
```

### Exit codes

| Code | When |
|---|---|
| 0 | Success, dry-run, already-installed (idempotence), or branch protection skipped/declined |
| 1 | Target is not a git repo, bundle is missing/corrupt, or unexpected filesystem error |
| 2 | Conflicting flags: `--auto-protect` AND `--skip-protection` both passed (Story D) |

---

## Verify before install (Story C)

`hubos-review verify` runs an **8-check pre-flight** against the target repo before you commit to running `install`. It is a read-only diagnostic — it never writes to the filesystem and never modifies anything on GitHub.

```bash
hubos-review verify                    # human-readable ASCII table
hubos-review verify --json             # machine-readable for CI/automation
hubos-review verify --target ../other  # check a different repo
hubos-review verify --gate codex-gate  # explicit gate (only value in MVP)
hubos-review verify --branch develop   # check a non-default branch
```

### The 8 checks

| # | Check | Severity | Blocks install? |
|---|---|---|---|
| **C1** | `gh` is authenticated and token has `repo` + `read:org` scopes | CRITICAL | yes (exit 1) |
| **C2** | target is a git repo with an origin remote pointing at github.com | CRITICAL | yes (exit 1) |
| **C3** | the Codex GitHub App (`chatgpt-codex-connector`) is installed on the repo | CRITICAL | yes (exit 1) |
| **C4** | the protected branch (`main` by default) exists | HIGH | yes (exit 1) |
| **C5** | the authenticated user has admin permission on the repo | HIGH | yes (exit 1) |
| **C5b** | no pre-existing `.github/workflows/codex-gate.yml` differs from the bundle | HIGH | yes (exit 1) |
| **C6** | the bundle version installed in `.aiox/cicd-version` (if any) is current | MEDIUM | no (warning) |
| **C7** | other workflows in `.github/workflows/` are surfaced (informational) | LOW | no (warning) |

### Exit code policy (severity-based)

| Outcome | Exit code |
|---|---|
| All CRITICAL/HIGH `PASS` (MEDIUM/LOW may warn) | 0 |
| Any CRITICAL or HIGH `FAIL` | 1 |
| `--gate` value not supported (only `codex-gate` in MVP) | 1 |

`WARN` is reserved for CRITICAL/HIGH checks that detect a likely-OK state without conclusive proof (e.g., C3 on a freshly-authorized repo with zero PR history) — those do **not** flip the exit code; they show amber in the table and proceed.

### Detecting the Codex App (C3) — empirical note

The official GitHub endpoint to list App installations on a repo (`GET /repos/{owner}/{repo}/installation`) requires a JWT signed by the App's private key, which is not available to a user-token CLI like `gh`. As a workaround, `verify` infers the App's presence by scanning the most recent 100 PR review comments and issue comments for the bot login `chatgpt-codex-connector[bot]`. This is empirically validated:

- A repo with the App installed and any prior PR will produce at least one hit → C3 `PASS`.
- A repo without the App will never produce a hit → C3 `WARN` (not `FAIL`, because a fresh repo with the App authorized but zero PRs would otherwise be a false negative).

The WARN row links to `https://github.com/apps/chatgpt-codex-connector/installations/new` so the user can confirm authorization manually.

### Example output (success path)

```
$ hubos-review verify
hubos-review verify — pre-flight check for codex-gate
Repo: AlfHubPlural/some-repo

CHECK ID  CHECK                           SEV       STATUS  DETAILS
--------------------------------------------------------------------------------
C1    gh auth + scopes                CRITICAL  PASS    authenticated as AlfHubPlural (read:org, repo)
C2    git repo + GitHub remote        CRITICAL  PASS    origin: git@github.com:AlfHubPlural/some-repo.git
C3    Codex App installed             CRITICAL  PASS    App detected via 17 prior review comment(s) from chatgpt-codex-connector[bot].
C4    branch 'main' exists            HIGH      PASS    branch 'main' present on AlfHubPlural/some-repo.
C5    admin access                    HIGH      PASS    user has admin permission on AlfHubPlural/some-repo.
C5b   codex-gate.yml conflict         HIGH      PASS    no pre-existing workflow file.
C6    bundle version (outdated)       MEDIUM    PASS    bundle v1 (no prior install detected).
C7    workflows orphan                LOW       PASS    no other workflows present.

Result: PASS — ready to run 'hubos-review install codex-gate'.
```

---

## Branch protection (Story D)

After copying the bundle files, `hubos-review install codex-gate` calls the GitHub API to add `codex-review-gate` to the target repo's required status checks on `main`. The exact endpoint:

```
GET  /repos/{owner}/{repo}/branches/{branch}/protection
PUT  /repos/{owner}/{repo}/branches/{branch}/protection
```

The PUT body is a **merge**, not a replace: any existing required status checks (`gitleaks`, `Vercel`, your CI, etc.) are preserved. Only `codex-review-gate` is added. If it's already present, the PUT is skipped entirely (idempotent).

### Decision matrix

The default behavior depends on whether the CLI is running in an interactive terminal:

| Context | No flag | `--auto-protect` | `--skip-protection` |
|---|---|---|---|
| TTY (laptop, real terminal) | Prompt `Y/n` (default Y) | Apply, no prompt | Skip, no prompt |
| Non-TTY (CI, pipe, script) | **Apply automatically** with explicit log | Apply, no prompt | Skip, no prompt |

The non-TTY auto-apply is what makes the tool usable in CI/automation pipelines without flags. To opt out in CI, pass `--skip-protection` explicitly.

`--auto-protect` + `--skip-protection` together is a usage error and exits **2**.

**Fix OBS-D-1 (Story E v0.4.0):** the flag-conflict check now runs **before** any side effects. Earlier versions copied the 3 bundle files first and only then surfaced the conflict, leaving the target dir in an unexpected partially-installed state on exit 2. As of v0.4.0, exit 2 means the filesystem is untouched (no bundle files copied, no `.aiox/cicd-version` written).

### Merge behavior — keeping your existing checks

If the target repo already has branch protection with other required checks (e.g. `gitleaks scan`, `Run unit tests`, `Vercel`), they are **preserved**. The new `codex-review-gate` is appended:

```
Before:  ["gitleaks scan", "Run unit tests"]
After:   ["gitleaks scan", "Run unit tests", "codex-review-gate"]
```

If the target repo has no branch protection at all, a minimal configuration is created with sensible defaults (strict status checks, enforce_admins off, no PR review requirement) — empirically aligned with the `hub-os` baseline configuration.

### When you lack admin rights (graceful degradation)

If your GitHub token cannot write branch protection (HTTP 403), the CLI:

1. **Does NOT fail the install** — the bundle files were copied successfully.
2. Prints the exact `gh api -X PUT ... <<EOF ... EOF` command you can hand to an admin to run.
3. Exits 0 (you can run it again later when you have admin, or `--skip-protection` to silence the attempt).

### Stamping `.aiox/cicd-version`

When branch protection is applied (or already present), the CLI updates `.aiox/cicd-version` with a `branchProtection` block under the gate:

```json
{
  "gates": {
    "codex-gate": {
      "bundleVersion": "v1",
      "branchProtection": {
        "configured": true,
        "checkName": "codex-review-gate",
        "branch": "main",
        "configuredAt": "2026-05-13T10:00:00.000Z",
        "previousContexts": ["gitleaks scan", "Run unit tests"],
        "mergedContexts": ["gitleaks scan", "Run unit tests", "codex-review-gate"]
      }
    }
  }
}
```

This is committed to the repo (D-002-8) and `hubos-review status` (Story E) reads it to audit drift across repos.

### Example — applying protection in CI

```bash
# In a CI step: install + auto-apply protection, exit 0 on any non-fatal error.
hubos-review install codex-gate --auto-protect
```

### Example — applying protection on a custom branch

```bash
hubos-review install codex-gate --auto-protect --branch=develop
```

### Example — manual command output (when not admin)

```
$ hubos-review install codex-gate --auto-protect
codex-gate v1 installed successfully.
3 files copied to /Users/you/your-repo.
.aiox/cicd-version created (remember to git add and commit this file — D-002-8).
Applying branch protection ('--auto-protect' flag).
Cannot write branch protection on someorg/repo@main (HTTP 403). You probably do not have admin access. The 3 bundle files are still installed.
To configure manually, ask an admin to run:

gh api -X PUT /repos/someorg/repo/branches/main/protection \
  -H "Accept: application/vnd.github+json" \
  --input - <<'EOF'
{
  "required_status_checks": { "strict": true, "contexts": [..., "codex-review-gate"] },
  "enforce_admins": false,
  "required_pull_request_reviews": null,
  "restrictions": null
}
EOF
```

---

## Check installed status (Story E)

`hubos-review status` audits an installed gate **in place**: it reads `.aiox/cicd-version`, recomputes SHA-256 for each tracked file, asks the npm registry for the latest published version, and (when an admin token is available) probes branch protection.

```bash
hubos-review status                       # human-readable table
hubos-review status --json                # machine-readable JSON
hubos-review status --no-registry-check   # offline mode (skip npm view)
hubos-review status --target=../other     # audit a different repo
hubos-review status --branch=develop      # probe protection on a non-default branch
```

### What it reports

| Section | Detail |
|---|---|
| Package + installed version | From `.aiox/cicd-version` (the `package` + `version` fields stamped at install time) |
| Per-file integrity | For each tracked file: `[OK]` if sha matches install record, `[!]` if locally modified, `[U]` if bundle has a newer version, `[X]` if missing from disk |
| Latest available | Resolved via `npm view @hubplural/hubos-review version --json` — falls back to "offline" gracefully on any error |
| Branch protection | `[OK]` if `codex-review-gate` is a required check, `[!]` if not configured, `[?]` if the user lacks admin access or there's no GitHub remote |

### Exit codes

| Code | When |
|---|---|
| 0 | Healthy — all hashes match (or merely locally-modified, which is a warning not an error) |
| 1 | `.aiox/cicd-version` is missing OR a tracked file is gone from disk (critical drift) |
| 2 | USAGE error (e.g., `--target` points at a non-existent directory) |

**Note:** "locally modified" is a `WARN`, not a `FAIL`. The user may have legitimately edited the workflow. `status` shows the drift without blocking — `update --force-update` can reset.

### Example output

```
$ hubos-review status
hubos-review status
Target repo: /Users/you/your-repo
Lock file: .aiox/cicd-version (committed per D-002-8)

Package: @hubplural/hubos-review
Installed version: 0.4.0
Installed at: 2026-05-13T19:55:32.988Z

Gate: codex-gate v1
  Bundle version: v1
  Installed at: 2026-05-13T19:55:32.988Z
  Files (3):
    [OK] .github/workflows/codex-gate.yml (sha256 match)
    [!]  .aiox-core/development/tasks/qa-bot-loop.md (locally modified — sha256 differs from installed record)
    [OK] .claude/rules/bot-review-integration.md (sha256 match)

Latest available: @hubplural/hubos-review@0.4.0 (up-to-date)

Branch protection:
  [OK] 'codex-review-gate' is required check on 'main'

Result: WARN
  1 file(s) locally modified.
  Inspect with 'git diff' or run 'hubos-review update --dry-run' to preview a clean reinstall.
```

---

## Update installed gate (Story E)

`hubos-review update` bumps the installed gate to the latest bundle shipped by the CLI. It detects local modifications (sha256 mismatch with the install record) and refuses to overwrite them without `--force-update` — a safeguard against accidentally clobbering legitimate customizations.

```bash
hubos-review update                       # interactive (TTY) or auto-apply (non-TTY)
hubos-review update --dry-run             # preview what would change, no writes
hubos-review update --auto-update         # CI-friendly: apply without prompt
hubos-review update --force-update        # overwrite local modifications (data loss!)
hubos-review update --no-registry-check   # offline mode (skip npm view)
hubos-review update --target=../other     # update a different repo
```

### Decision matrix

| Context | No flag | `--auto-update` | `--dry-run` |
|---|---|---|---|
| TTY (laptop) | Show diff + prompt `Y/n` (default Y) | Apply without prompt | Preview only — no writes |
| Non-TTY (CI, pipe) | Apply automatically with log | Apply without prompt | Preview only — no writes |

`--auto-update` is the recommended flag for CI/automation. `--dry-run` short-circuits writes even when bundle changes exist, so it's safe in all contexts.

### Local modification protection

When a tracked file's on-disk SHA-256 does NOT match the hash recorded in `.aiox/cicd-version`, `update` aborts with exit 1 by default:

```
$ hubos-review update
Aborting update: locally modified files detected.
Files with local modifications:
  .github/workflows/codex-gate.yml (sha256 differs from installed record: sha256:14ad… → sha256:abcd…)

Use --force-update to overwrite local modifications.
Or inspect with 'git diff' / 'hubos-review status' first.
```

`--force-update` overrides this. It clobbers the local edits with the bundle's pristine version. Use sparingly.

### Exit codes

| Code | When |
|---|---|
| 0 | Up-to-date, update applied successfully, dry-run completed, or user declined the interactive prompt |
| 1 | Local modifications detected without `--force-update`, OR no gate installed, OR bundle source corrupt |
| 2 | USAGE error (e.g., `--target` points at a non-existent directory) |

### Lock file refresh (post-update)

After a successful update, `.aiox/cicd-version` is rewritten with:

- New `version` (the CLI's `package.json` version at update time)
- New `installedAt` (ISO 8601 — the update timestamp, NOT the original install time)
- New `gates.codex-gate.bundleVersion` (if the bundle ships a newer `vN`)
- New per-file `sha256` values
- **Preserved** `branchProtection` block (update never touches GitHub state)

Remember to `git add .aiox/cicd-version` along with the refreshed gate files after `update`.

---

## Why `hubos-review` and not `aiox`?

If you already have the [AIOX framework](https://github.com/SynkraTech/aiox) installed and recognize the `aiox` CLI, the question is fair:

| | `aiox` | `hubos-review` |
|---|---|---|
| **Scope** | AI-orchestrated full-stack development framework (agents, stories, workflows) | Installer for portable PR review gates on GitHub repos |
| **Distributed via** | npm package `aiox` (or framework bundle) | npm package `@hubplural/hubos-review` |
| **Binary name** | `aiox` | `hubos-review` |
| **Lifecycle** | Long-lived (drives the dev loop end-to-end) | Run once per repo (install) + occasional bumps (update/status) |
| **Coexistence** | ✅ Both can be installed globally at the same time | ✅ Both can be installed globally at the same time |

**Short version:** `aiox` orchestrates **how** you build software (agents, stories, gates as a development process). `hubos-review` is a tiny **distribution tool** that drops a battle-tested PR review gate (currently `codex-gate`) into any GitHub repo with one command. They are independent and complementary.

This package is also intentionally **separate from the AIOX framework codebase** — it lives in [`AlfHubPlural/hubos-review`](https://github.com/AlfHubPlural/hubos-review), is owned by Alf, and evolves on its own cadence.

---

## Roadmap (EPIC-CICD-002)

Tracked in the parent epic: [EPIC-CICD-002 — Codex Gate One-Shot Install (Portable Replication)](https://github.com/SynkraTech/hub-os/blob/main/docs/stories/epic-EPIC-CICD-002-codex-gate-portable.md) in the `hub-os` repo.

| Story | Title | Status |
|---|---|---|
| **CICD-002-A** | Skeleton CLI + 4 stubs | Done (v0.1.0) |
| **CICD-002-B** | Bundle & versioning of the `codex-gate` package + real `install` | Done (v0.2.0) |
| **CICD-002-C** | Pre-flight check (`gh auth`, Codex App, repo state) | Done (v0.3.0) |
| **CICD-002-D** | Branch protection via `gh api` + graceful fallback | Done (v0.3.0) |
| **CICD-002-E** | `status` + `update` + Fix OBS-D-1 (closes the epic) | Done (v0.4.0) |

Each story incrementally fills in real behavior behind the stubs — without changing the public CLI surface defined here. EPIC-CICD-002 is **feature-complete** as of v0.4.0.

---

## Architecture (high-level)

```
hubos-review/
├── bin/hubos-review.js       # entrypoint (shebang, thin)
├── src/
│   ├── cli.js                # commander program builder + dispatcher
│   ├── index.js              # public programmatic API
│   ├── lib/
│   │   ├── bundle.js                # bundle discovery + manifest + SHA-256 helpers
│   │   ├── branch-protection.js     # Story D: gh api GET/merge/PUT + matrix logic
│   │   └── tty.js                   # Story D: TTY detection + interactive prompt
│   └── commands/
│       ├── install.js        # real (Story B + D): copies bundle + applies protection
│       ├── update.js         # stub → Story E
│       ├── status.js         # stub → Story E
│       └── verify.js         # stub → Story C
├── bundles/                  # frozen artifact snapshots shipped in the npm tarball
│   └── codex-gate/v1/
│       ├── manifest.json     # files + SHA-256 + target paths
│       ├── codex-gate.yml
│       ├── qa-bot-loop.md
│       └── bot-review-integration.md
├── scripts/
│   └── sync-bundles.mjs      # integrity + drift checker (wired into prepublishOnly)
├── tests/                    # vitest specs (cli, install, sync-bundles)
├── .github/workflows/ci.yml  # lint + test + smoke (Node 20 & 22)
├── eslint.config.js
├── vitest.config.js
├── package.json
├── LICENSE                   # MIT
└── README.md
```

Tech stack (chosen for the skeleton — Story A):

- **CLI parser:** [`commander`](https://github.com/tj/commander.js) — mature, small, idiomatic.
- **Test runner:** [`vitest`](https://vitest.dev) — fast, ESM-native, familiar to anyone coming from Jest.
- **Language:** Plain JS (ESM) + JSDoc. No build step in v0.1.x.
- **Linter:** ESLint flat config.

---

## Development

```bash
git clone git@github.com:AlfHubPlural/hubos-review.git
cd hubos-review
npm install

npm test           # vitest
npm run lint       # eslint
node bin/hubos-review.js --help   # exercise the binary in-tree
```

To exercise the published-package path locally:

```bash
npm pack                                                    # → hubplural-hubos-review-0.2.0.tgz
npm install -g ./hubplural-hubos-review-0.2.0.tgz
hubos-review --help
```

### Bundle integrity

The `codex-gate` bundle ships inside the npm tarball as a frozen snapshot of the source artifacts. `scripts/sync-bundles.mjs` verifies that every file in `bundles/codex-gate/v1/` still matches the SHA-256 recorded in its `manifest.json`. The hook is wired into `prepublishOnly` so a publish from a tampered checkout fails fast:

```bash
npm run sync-bundles:check                            # integrity only
npm run sync-bundles -- --source-root /path/to/hub-os # also detects drift vs source-of-truth
```

---

## Contributing

This is a personal/operations tool for the `hub-os` ecosystem. External contributions welcome via issue/PR, but the roadmap and scope are owned by Alf and tracked through the EPIC-CICD-002 stories above.

---

## License

[MIT](./LICENSE) © 2026 Alfredo Carneiro Júnior
