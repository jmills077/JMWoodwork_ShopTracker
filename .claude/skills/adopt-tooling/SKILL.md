---
name: adopt-tooling
description: Copy skills/agents from the ai-tooling repo (github.com/alex-laycalvert/ai-tooling) into the current repo's .claude/ and adapt them to this repo, or pull upstream updates into copies adopted earlier. Use when asked to "adopt", "install", "add", or "update" one of the ai-tooling skills/agents (e.g. `/adopt-tooling ai-triage`, `/adopt-tooling update`, "add ai-triage from github.com/alex-laycalvert/ai-tooling").
---

# Adopt tooling into this repo

**Target:** the current repo root (`git rev-parse --show-toplevel`), into `.claude/skills/`
and `.claude/agents/`.

**Source:** a fresh clone, so only committed + pushed work is ever copied. URL, first match:
the one the user gave → `source:` in `.claude/ai-tooling.lock` →
`https://github.com/alex-laycalvert/ai-tooling.git`.

```bash
SRC=$(mktemp -d) && git clone -q "$URL" "$SRC"   # full clone: update diffs against old commits
```

It holds `skills/<name>/` and `agents/<name>.agent.md`. Remove `$SRC` when done.

## 1. Pick what to copy

No argument → list what's in `$SRC/skills` and `$SRC/agents` (name + description) and ask.

Resolve dependencies transitively so nothing arrives broken:

- an agent's `skills:` frontmatter → those skills;
- any other skill or agent `name` mentioned in a file's body (e.g. a dispatcher that
  launches `triage-fix`) → that item.

Always include `skills/adopt-tooling` itself, so anyone in this repo can run
`/adopt-tooling update` later.

Show the final list before copying. If an item already exists in the target and is **not**
in `.claude/ai-tooling.lock`, it's the repo's own — ask before overwriting.

## 2. Copy

```bash
mkdir -p .claude/skills .claude/agents
cp -R "$SRC/skills/<name>" .claude/skills/
cp "$SRC/agents/<name>.agent.md" .claude/agents/
```

Write/update `.claude/ai-tooling.lock`:

```
source: <URL>
commit: <git -C "$SRC" rev-parse HEAD>
items:
  - skills/adopt-tooling
  - skills/ai-triage
  - agents/triage-fix.agent.md
```

## 3. Adapt

The files are written generically and defer to the repo's docs ("repo conventions win").
Adapting means making those deferrals concrete **where this repo's docs don't already
answer them**. Read `CLAUDE.md`, `AGENTS.md`, `CONTRIBUTING.md`, `.claude/rules/`,
`package.json`/`Makefile`/CI config, then for each copied file find every place that says
"the way the repo's docs describe", "the repo's quality gates", "whatever ... the repo
provides", etc., and settle it:

- **Already answered in the repo's docs** → leave the generic text; it will read them.
  Don't duplicate — duplicates drift.
- **Not answered, but discoverable** (test/lint/typecheck commands, how to start the app and
  on which ports, base branch, test-login mechanism, which browser-automation tools exist,
  commit convention) → inline the concrete answer into the copied file.
- **Not answered, not discoverable, or a judgment call** (which branches are protected,
  whether issues are public, which roles to test as) → ask the user. Batch the questions.
- **Doesn't apply here** (e.g. in-app repro for a library with no app; GitHub labels in a
  repo that tracks issues elsewhere) → rewrite or delete that part, and say what you changed.

Workflow changes the user asks for (different labels, an extra phase, a different review
bar) are edits to the copies — make them directly. Don't adapt `adopt-tooling` itself.

Finish with a short per-file summary of what was adapted and anything left generic on
purpose. Don't commit unless asked.

## Update (`/adopt-tooling update`)

Read `.claude/ai-tooling.lock`, clone `source:` as above. For each item:

```bash
git -C "$SRC" diff <lock commit> HEAD -- <item>
```

Apply that upstream diff to the local copy **by intent, not by line** — the local copy has
been adapted, so hunks won't apply verbatim. Where an upstream change collides with a local
adaptation, keep the adaptation and fold the upstream intent in around it; if they truly
conflict, ask. Items deleted upstream → ask before deleting locally. New upstream
dependencies → offer to adopt them (step 1). Then bump `commit:` in the lock and summarize
what changed per file.
