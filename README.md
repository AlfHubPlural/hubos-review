# hubos-review

> Standalone CLI to install portable PR review gates (codex-gate, etc.) on any GitHub repo.
> Part of the **hub-os ecosystem** by [Alfredo Carneiro Júnior](https://github.com/AlfHubPlural).

[![npm](https://img.shields.io/npm/v/@hubplural/hubos-review/beta.svg)](https://www.npmjs.com/package/@hubplural/hubos-review)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Node.js ≥ 20](https://img.shields.io/badge/node-%E2%89%A520-brightgreen.svg)](https://nodejs.org/)

---

## Status

**v0.1.0 (beta) — Skeleton release.** All sub-commands are stubs that print informational messages and exit cleanly. Real behavior lands progressively in EPIC-CICD-002 stories B through E.

| Sub-command | What it does today | Coming in |
|---|---|---|
| `install [gate]` | Prints stub message, exit 0 | [Story B](#roadmap) |
| `update` | Prints stub message, exit 0 | [Story E](#roadmap) |
| `status` | Prints stub message, exit 0 | [Story E](#roadmap) |
| `verify` | Prints stub message, exit 0 | [Story C](#roadmap) |

---

## Quick start

```bash
# Install globally (beta channel during MVP — D-002-11)
npm install -g @hubplural/hubos-review@beta

# See available sub-commands
hubos-review --help

# Each sub-command currently announces the story that will deliver it
hubos-review install codex-gate
hubos-review verify
hubos-review status
hubos-review update
```

Requires **Node.js ≥ 20** (tested on 20 and 22 in CI).

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
| **CICD-002-A** | Skeleton CLI + 4 stubs (this release) | InReview |
| CICD-002-B | Bundle & versioning of the `codex-gate` package | Planned |
| CICD-002-C | Pre-flight check (`gh auth`, Codex App, repo state) | Planned |
| CICD-002-D | Branch protection via `gh api` + graceful fallback | Planned |
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
│   └── commands/
│       ├── install.js        # stub → Story B
│       ├── update.js         # stub → Story E
│       ├── status.js         # stub → Story E
│       └── verify.js         # stub → Story C
├── tests/cli.test.js         # vitest specs for dispatcher + each stub
├── .github/workflows/ci.yml  # lint + test + smoke (Node 20 & 22)
├── eslint.config.js          # flat config
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
npm pack                                                    # → hubplural-hubos-review-0.1.0.tgz
npm install -g ./hubplural-hubos-review-0.1.0.tgz
hubos-review --help
```

---

## Contributing

This is a personal/operations tool for the `hub-os` ecosystem. External contributions welcome via issue/PR, but the roadmap and scope are owned by Alf and tracked through the EPIC-CICD-002 stories above.

---

## License

[MIT](./LICENSE) © 2026 Alfredo Carneiro Júnior
