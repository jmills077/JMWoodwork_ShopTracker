---
name: ai-triage
description: Drive a bug issue through the AI triage pipeline (investigate -> reproduce -> fix -> verify), using GitHub issue labels as the state machine. Use when asked to triage, reproduce, fix, or verify a bug issue, to advance an issue carrying an `ai-triage:*` label, or when invoked as `/ai-triage <issue#>`.
---

# AI bug triage pipeline

You are the **dispatcher**. You do not investigate, reproduce, fix, or verify anything
yourself — you read one label, launch the one agent that label calls for, and report the
resulting label.

That division is the whole design. Each phase runs in a **fresh agent context** so the
agent that verifies a fix has never seen it being written. If you do a phase's work
inline, you have destroyed the property the pipeline exists for.

**Repo:** confirm which repo you are writing to with
`gh repo view --json nameWithOwner -q .nameWithOwner` before any write. All `gh api` paths
below use `{owner}/{repo}`, which `gh` fills in from the current checkout.

**Repo conventions win.** Read the repo's agent/contributor docs (`CLAUDE.md`, `AGENTS.md`,
`CONTRIBUTING.md`, `.claude/rules/`, or equivalents) for base branch, branching, commit
format, quality gates, test placement, and how to run the app. Where they are specific,
they override the defaults in this skill and the phase agents.

### This repo (Shop Tracker)

The repo has no `CLAUDE.md`/`CONTRIBUTING.md`; these are its conventions. `README.md` has
the architecture and run instructions.

- **GitHub:** issues, labels and PRs all live on the `origin` repo. `gh` must be installed
  and authenticated, and `gh repo view` must resolve to `origin`; if it doesn't, run
  `gh repo set-default` against `origin` first.
- **Base branch:** `main`.
- **Commits:** a plain imperative sentence, no prefix (`Fix quote total when tax is zero`),
  matching `git log`. Put `Fixes #<N>` in the commit/PR body, not the title.
- **Never deploy or touch Cloudflare.** Forbidden: `npm run deploy`, `wrangler deploy`,
  `npm run db:migrate:remote`, `npm run db:seed:remote`, `wrangler login`, and any
  `wrangler` command with `--remote`. The owner deploys by hand. Everything here runs locally.
- **Quality gates:** `npm run typecheck` (Worker, browser script and scripts). There is no
  test runner, linter, formatter or CI yet — so the `Yes (Test)` route does not exist, and
  the proof a fix works is the in-app repro re-walked clean. Once a test runner is added,
  the test requirements in the phase agents apply again.
- **Worktree setup:** `npm install`, then `cp .dev.vars.example .dev.vars` (sign-in password
  `shop`, Todoist off — **never copy the main checkout's `.dev.vars`**, it may hold the real
  Todoist token and syncing would write to the shop's real Todoist), then
  `npm run setup:local`. Each worktree gets its own local D1 in its own `.wrangler/state/`.

---

## The state machine

| Label | Means | Next phase |
|---|---|---|
| `ai-triage:needs-triage` | untouched bug report | `triage-investigate` |
| `ai-triage:needs-repro` | repro steps written, **unverified** | `triage-reproduce` |
| `ai-triage:ready` | repro **executed**, fix identified | `triage-fix` |
| `ai-triage:in-progress` | fix committed, awaiting verification | `triage-verify` |
| `ai-triage:pr-ready` | repro re-walked clean, review passed, draft PR open | — terminal |
| `ai-triage:needs-context` | blocked on a human answer | — terminal, needs a human |
| `ai-triage:not-suitable` | won't-fix / reporter needs a workaround | — terminal |

**Exactly one `ai-triage:*` label at all times.** Every move adds the new one and removes
the old one in a single `gh issue edit` call — that is one atomic PATCH of the whole label
array, so a half-applied move is not really possible through it.

Anything else is a human's hand-edit, not a failed write, and the dispatcher stops rather
than guessing: **two labels** → report both and change nothing; **zero labels** → see
Dispatch step 2, which decides from the report comment rather than the label.

> **Always read label state with `gh issue view`, never `gh issue list --label`.** The list
> command reads GitHub's search index, which lags writes by minutes and will report stale
> state. Use the full field list from Dispatch step 2 — a shorter one silently drops the
> data the assignment guard needs.

Do not touch any other label — not to apply, remove, or read as a signal.

### Refix: `triage-verify` → `ai-triage:ready`

When Verify fails a gate it sets the label back to **`ai-triage:ready`** — that label
already means "repro verified, fix identified", which is exactly the state a second attempt
starts from — and writes its blocking findings into the report's Log. The dispatcher then
routes to `triage-fix` as normal, and Fix reads those findings from the report like any
other input.

There is no separate refix label and no separate refix route. But the cycle must terminate:
**a phase that finds two or more `NEEDS REFIX` entries already in the Log exits to
`ai-triage:needs-context`** instead of going round again. Two failed verifications means the
fix needs a human, not a third guess.

---

## Dispatch

`/ai-triage <issue#>` runs **one** phase. `/ai-triage <issue#> --run` loops until a
terminal label.

1. **Ensure the labels exist** (once per session — `gh issue edit --add-label` fails on a
   label the repo lacks). Create-if-missing only: **never pass `-f`**, which force-*updates*
   and would silently recolour labels a human already set up.

   ```bash
   for l in needs-triage needs-repro ready in-progress pr-ready needs-context not-suitable; do
       gh label create "ai-triage:$l" >/dev/null 2>&1 || true
   done
   ```

2. **Read the current state.** `--json` returns *only* the fields you name, so ask for the
   ones the checks below need — `assignees` in particular:

   ```bash
   gh issue view <N> --json number,title,state,labels,assignees
   gh api user --jq .login        # the invoker, for the assignee comparison
   ```

   - **Closed** → stop, say so, change nothing.
   - **`.assignees[].login` is non-empty and does not include the invoker** → stop, say so,
     change nothing. Unassigned is fine.
   - **Two `ai-triage:*` labels** → stop, report both, change nothing.
   - **Terminal label** (`pr-ready`, `needs-context`, `not-suitable`) → report it and stop.
     Re-running a terminal phase needs the label reset by hand; say that rather than doing it.
   - **No `ai-triage:*` label at all** → decide from the report comment, not the label.
     No report comment and it is a bug → treat as `needs-triage`. A report comment **does**
     exist → a human removed the label mid-pipeline; stop and report which phase the Log
     last recorded. Never restart `triage-investigate` over an existing report — it rewrites
     Description / Module / Reproducible / Fix, which on a late-phase issue destroys the only
     channel between phases.

3. **Isolate in a worktree** if the next phase is `triage-reproduce`, `triage-fix`, or
   `triage-verify`. `triage-investigate` is read-only and needs none.

   Each issue gets **its own git worktree on its own branch**, separate from the main
   checkout (which is a human's working tree) and from every other issue's worktree. Name
   the branch `ai-triage/<N>-<slug>` (slug: title lowercased, non-alphanumerics to `-`,
   trimmed to ~5 words) so a later phase can find it with `git worktree list`. If one
   already exists for the issue, **reuse it** — never create a second. Get it into a
   runnable state however the repo's docs prescribe.

   **Base branch.** The repo docs' answer if they give one; otherwise the repo's default
   branch (`gh repo view --json defaultBranchRef -q .defaultBranchRef.name`). Override only
   when the person asks — e.g. a hotfix starting point the repo docs define, or a fix
   stacked on an unmerged branch. Pick it **before** creating the branch; changing it later
   means a rebase, which is not this pipeline's job. A start nobody asked for is a merge
   problem for a reviewer.

4. **Launch the one agent** via the Agent tool, `subagent_type` per the table, foreground.
   Give it only: issue number, and (where applicable) worktree path, branch, and base.
   **Pass no findings, no analysis, no summary of prior phases** — the agent reads the
   report comment itself. That is the isolation boundary.

5. **Report** the resulting label in one line. In `--run` mode, loop back to step 2.
   Never advance a label yourself to "unstick" a phase.

6. **Tear down** the worktree (`git worktree remove`) only in these cases:

   | Terminal state | Worktree |
   |---|---|
   | `pr-ready` | **remove** — the branch survives on the remote via the PR |
   | `needs-context` from **Reproduce** | **remove** — nothing was built |
   | `needs-context` from **Fix** or **Verify** | **keep, deliberately** |
   | `in-progress` (not terminal) | keep — Verify needs it |

   **Keeping the worktree on a Fix/Verify `needs-context` is a choice, not an oversight.**
   By then there is a commit on the branch and a half-finished investigation on disk, and
   the human who picks the issue up wants both. **Report the path when you leave one**, and
   remove it once the issue is resolved. To see what has accumulated:
   `git worktree list | grep ai-triage/`.

### Running several issues in parallel

Phases that drive a browser (`triage-reproduce`, `triage-verify`) usually share one browser
instance and one `localhost` cookie jar — one agent logging in evicts another's session.
Run **at most one browser phase at a time**; fill the other slots with `triage-investigate`
(no app) or `triage-fix` (tests only — tell it not to start servers or a browser).

---

## The report comment

One comment per issue, rewritten in place by each phase. It is the **only** channel
between phases, and the only comment the pipeline ever posts on an issue.

The issue may be **visible to customers or the public**, so nothing local goes in it: no
filesystem paths, no port numbers, no worktree state, no user emails. HTML comments are
invisible in the rendered view but plain text via the API, in the edit box, and in "quote
reply". Worktree state is not stored anywhere — it is derived from the branch name on demand.

```markdown
<!-- ai-triage-report -->
## 🤖 AI Triage Report

**Description:** One or two sentences, maximum. What is broken.
**Module:** The owning module, or the cross-cutting concern if it spans several.
**Reproducible:** Yes (In-App) | Yes (Test) | Yes (Manually) | No/Unknown
**How to Reproduce:**
1. …
2. …
**Fix Identified:** Yes | No
**Fix:** High-level, referencing `file:line`. If it cannot be fixed in code because the
data is corrupt, this is instead the manual steps to repair the affected data.

### Suspect code
- `src/x/y.ts:42` — what is wrong here

### Log
- `2026-08-05` **investigate** → `needs-repro` — steps hypothesized from the reporter's context
- `2026-08-05` **reproduce** → `ready` — confirmed in-app as a user with role X

---
_Posted via Claude Code — AI-generated._
```

**Reproducible** values:

- `Yes (In-App)` — observed in a running instance. The goal.
- `Yes (Test)` — the app cannot exercise the trigger locally (a stubbed integration, an
  external service, an environment-only path), so a test that fails against the current
  code pins the exact mechanism instead. **How to Reproduce** names the test and what it
  asserts. A legitimate route to `ready`, not a reason to park at `needs-context`.
  **Not available in this repo until a test runner exists** — see "This repo" above.
- `Yes (Manually)` — needs corrupt or legacy data the app cannot create; **Fix** carries
  the manual data-repair steps.
- `No/Unknown`.

Rules every phase follows:

- **Field order is fixed** and all seven fields are always present. Unknown-yet is `No`,
  `No/Unknown`, or `TBD` — never a missing field.
- **`Log` is append-only.** Add exactly one line, `<date> **<phase>** → <label> — <why>`.
  Never edit or delete another phase's line. Get the date from `date +%F`. It is also the
  refix counter — count existing `NEEDS REFIX` entries before starting a phase.
- **Nothing local.** No filesystem paths, no ports, no usernames beyond the attribution
  footer. Describe test users by role ("an admin", "a user with 2 direct reports").
- **`How to Reproduce` is `N/A`** when `Reproducible: No/Unknown`.
- **The issue body's explicit requirements are scope.** If the reporter names a concrete
  deliverable (a migration, a config change, specific copy), no phase may write "X is not
  required" into the report on its own judgment. Disagree in the report and either keep
  it in scope or exit to `needs-context` asking whether it is still wanted.
- Keep the `<!-- ai-triage-report -->` marker as the first line and the attribution footer
  as the last.

### Writing it: find-and-PATCH by marker

**Never use `gh issue comment --edit-last`.** It edits the authenticated user's *last*
comment — if a human comments on the issue between phases, the next phase silently
overwrites their words. Match the marker and PATCH by id:

```bash
N=<issue-number>
REPORT=${TMPDIR:-/tmp}/ai-triage-report-$N.md   # write the full comment body here first

ID=$(gh api "repos/{owner}/{repo}/issues/$N/comments" --paginate \
     --jq '.[] | select(.body | startswith("<!-- ai-triage-report -->")) | .id' | head -1)

if [ -z "$ID" ]; then
    gh issue comment "$N" --body-file "$REPORT"
else
    gh api --method PATCH "repos/{owner}/{repo}/issues/comments/$ID" -F body=@"$REPORT"
fi
```

To read the existing report, same query with `.body` instead of `.id`.

---

## Running the app locally

Reproduce and Verify need a live instance. Start it **from the issue's worktree** on ports
no other instance is using (other worktrees and a human's own dev servers may be running).
Background it, then poll until it answers before driving it.

`npm run dev` uses the human's ports (8787, inspector 9229), so never use it. Pick a free
pair and run wrangler directly:

```bash
npx wrangler dev --port <P> --inspector-port <Q>   # e.g. P=8800+N%100, Q=P+1000; check both are free with lsof first
until curl -s -o /dev/null "http://localhost:<P>/login"; do sleep 1; done
```

Drive it with the Chrome DevTools MCP tools (`mcp__plugin_chrome-devtools-mcp_chrome-devtools__*`:
`new_page`, `take_snapshot`, `fill`, `click`, `list_console_messages`,
`list_network_requests`). The server log is the wrangler process's output.

**Sign-in** is a single shared password (`shop`, from `.dev.vars`) — there are no users or
roles. A "user-specific" bug is really data-specific: recreate the reporter's data
(species, projects, phases, settings) in the worktree's own local database. The weekly
price cron can be fired by hand with the `curl` in `README.md` (adjust the port); it reads
Parkerville's live pages. If the environment cannot exercise the trigger at all (e.g. a real
Todoist response), say so — with no test runner there is no `Yes (Test)` route, so that is
`needs-context`.

### Stopping the app — kill by port, never by name

**Never pattern-kill a dev server.** `pkill -f 'npm run dev'`, `killall node` and friends
are forbidden. Every dev server in every worktree — including a human's own, running in
checkouts you know nothing about — shares the same command line. A name pattern cannot tell
yours from theirs, so it kills theirs too.

The port is the only thing that is uniquely yours. Kill exactly what listens on it:

```bash
for port in <your ports>; do
    lsof -tiTCP:"$port" -sTCP:LISTEN | xargs kill 2>/dev/null
done
```

Then confirm each is free (`lsof -iTCP:<port> -sTCP:LISTEN` prints nothing) and say so. If a
port is still held after a few seconds, re-run with `kill -9` — still scoped to your port.
Killing a background shell **you** started, by its own id, is also fine.

### Shared-resource rules

Here each worktree's local D1 lives in its own `.wrangler/state/`, so a worktree's data is
its own. The human's data is the main checkout's `.wrangler/state/` and the real Cloudflare
database — never touch either.

- **Never** run `db:reset:local`, `rm -rf .wrangler`, or any seed/migrate script outside the
  issue's own worktree, and never run any `--remote` command (see "This repo").
- **Never** sync to Todoist or set a Todoist token — it is the shop's real account.
- Prefix anything you create with the issue number (`AI-1234 Test Record`) so it is
  identifiable and cleanable.
- Prefer reading existing data over creating new data. If reproducing genuinely requires
  destructive setup, stop and exit to `needs-context` saying exactly what it needs.

---

## Attribution

- **Commits and PR titles:** a plain imperative sentence (see "This repo"), with
  `Fixes #<N>` in the body. Commits carry the `Co-Authored-By` trailer your harness specifies.
- **Comments and PR bodies:** end with `_Posted via Claude Code — AI-generated._`
- Never impersonate a customer or the original reporter.

---

## Guardrails

- **Never** close an issue.
- **Never** touch a closed issue, or one assigned to someone other than the invoker.
- **Never** advance a label past a phase that reported failure — a red gate is red.
- **Never** push to the default branch or any protected/release branch.
- Any phase may exit to `needs-context`. That is a success, not a failure: a specific
  unanswered question costs one reply, a guess costs a reviewer's afternoon.
