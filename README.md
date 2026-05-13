# hubos-review

> Standalone CLI to install portable PR review gates (codex-gate, etc.) on any GitHub repo.
> Part of the **hub-os ecosystem** by [Alfredo Carneiro Júnior](https://github.com/AlfHubPlural).

[![npm](https://img.shields.io/npm/v/@hubplural/hubos-review/beta.svg)](https://www.npmjs.com/package/@hubplural/hubos-review)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Node.js ≥ 20](https://img.shields.io/badge/node-%E2%89%A520-brightgreen.svg)](https://nodejs.org/)

---

## Status

**v0.3.0 (beta) — Story D landed.** `install codex-gate` now also configures branch protection on the target repo via `gh api` (with TTY auto-detect and graceful degradation when the user lacks admin). `verify`/`update`/`status` will follow in Stories C and E.

| Sub-command | What it does today | Coming in |
|---|---|---|
| `install codex-gate` | Copies 3 frozen artifacts + writes `.aiox/cicd-version` + (Story D) configures branch protection | ✅ Story B (v0.2.0) + Story D (v0.3.0) |
| `update` | Prints stub message, exit 0 | [Story E](#roadmap) |
| `status` | Prints stub message, exit 0 | [Story E](#roadmap) |
| `verify` | Prints stub message, exit 0 | [Story C](#roadmap) |

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

This is committed to the repo (D-002-8) and lets `hubos-review status` (Story E) audit drift across repos.

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
| **CICD-002-D** | Branch protection via `gh api` + graceful fallback | InReview (v0.3.0) |
| CICD-002-C | Pre-flight check (`gh auth`, Codex App, repo state) | Ready (parallel with D) |
| CICD-002-E | `update` + `status` + end-to-end idempotency | Planned |

Each story incrementally fills in real behavior behind the stubs — without changing the public CLI surface defined here.

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
