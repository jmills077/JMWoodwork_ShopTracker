---
name: feedback-ladder-pr-review
description: Review pull request diffs using the Feedback Ladder tagging system. Use this skill when performing code reviews on PRs or branch diffs.
---

# Overview

This skill provides a structured PR review process using the **Feedback Ladder** -- a tagging system that categorizes every review comment by severity and blocking status.

# Review Focus

- Assess changed code for **functionality**, **code style**, **performance**, and **maintainability**.
- Prioritize changed lines and nearby impacted code paths.
- **In scope includes uncommitted local changes** (staged, unstaged, and untracked files), not just what's already committed or pushed -- see the diff-obtaining step in Workflow below. Treat them exactly like committed changes for tagging purposes.
- Identify **newly introduced** issues and **worsened existing** issues.
- Do not perform a full-app audit unless explicitly requested.
- If context is missing, state assumptions and request only the minimum additional files needed.
- Do not comment on formatting, linting, or syntax errors -- these are caught by automated checks. (In this repo the only automated check is `npm run typecheck`, run locally -- there is no CI, linter or test suite. Don't nit formatting anyway, but missing in-app verification of a behavioral change is fair game.)
- This repo deploys by hand to Cloudflare Workers + D1. A schema change must come as a new file in `migrations/`, never an edit to an existing one -- once deployed, a migration has been applied to the live database and is never re-run.
- Judge against **this repo's** conventions, not your own preferences. Read the repo's agent/contributor docs (`CLAUDE.md`, `AGENTS.md`, `CONTRIBUTING.md`, `.claude/rules/`, or equivalents) before tagging style or architecture comments.

## Cross-Layer Consistency

When a change spans multiple layers or packages (e.g. client and server, a shared types/validation package, a library and its consumers), **verify that assumptions are consistent across all of them**. Common pitfalls:

- **Feature flags / config:** A flag or config value may encode data (a URL, an object) rather than just on/off. Verify consumers read the value correctly, not just its truthiness.
- **Shared types:** If a shared type changes, verify every consumer is updated.
- **API contracts:** If an endpoint changes its response shape, parameters, or error codes, verify callers adapt.
- **Validation:** If shared validation changes, verify both client-side and server-side validation use it consistently.
- **Environment variables:** If a new env/config value is introduced on one side, verify the other side handles its presence or absence correctly.

# Response Style

- Be concise, technical, and evidence-based.
- Avoid generic educational content unless needed to justify a block.
- Do not claim failures without clear evidence from the diff/context.

# Avoiding False Positives

Before tagging a comment as `boulder` or higher, verify each of the following. Failure to do so leads to invalid blocking comments that waste the author's time.

- **Understand the error handling pipeline.** Before claiming an error type is wrong, trace how errors propagate (middleware, global handlers, framework conventions). A domain error may be converted to the right response downstream. Don't suggest replacing it if the conversion already happens.
- **Verify library/framework limitations before suggesting alternatives.** If code uses an indirect pattern, check whether the direct approach is actually possible (types, API surface, version) before flagging it.
- **Read the spec literally -- do not infer restrictions that aren't stated.** If the spec doesn't prohibit something, the absence of a guard is a `question`, not a `boulder`.
- **Respect stated project constraints and exceptions.** Repo docs, session context, or the PR description may declare exceptions to general rules. Don't flag explicitly exempted violations.
- **Understand the data layer's mechanics.** Before suggesting a new index, query rewrite, or caching layer, verify the existing setup can't already serve the case (e.g. a compound index serving a reverse-order sort).

# Feedback Ladder

Every review comment **must** be tagged with exactly one of the tags below. Use the format:

```
`<tag> <comment>`
```

## Tags (ordered by severity)

| Tag | Blocking? | Meaning |
|---|---|---|
| `question` | Yes | Request for additional information on why a change was made or what impact it has. Does not necessarily require code changes, but requires an answer. |
| `dust` | No | Nit-pick. A requested change that does not impact the usability of the changed code in any way (e.g., variable naming unless it violates a specific convention). |
| `sand` | No | **Requires future discussion.** Items that may need adjustment in the future but work fine for now and may not be an issue. |
| `pebble` | No | **Requires future action.** No functionality issues now, but will need adjustment in the future and requires a follow-up issue if not addressed in this PR (e.g., performance problems, hotfixes that are a band-aid over a larger problem). |
| `boulder` | Yes | **Right idea, bad execution.** Bugs in the implementation or unhandled edge cases. The approach is correct but adjustments are needed before production (e.g., UI changes not matching spec, edge cases causing runtime errors). |
| `mountain` | Yes | **Bad idea.** Issues with the underlying approach. The PR's fundamental design is flawed and a rework would require a complete overhaul (e.g., incorrect schema design, UI that does not meaningfully help customers). |

## Rules

- **All** comments must be tagged. No untagged comments.
- Only the tags listed above are valid.
- For `sand`, `pebble`, `boulder`, and `mountain` tags, include a concise explanation of **why** the comment is at that severity level.
- Do not over-escalate. Use the lowest appropriate tag.

# Initial Information Gathering

Before starting the review, you **must** ask the user the following **three** questions unless the information was already provided. Ensure these questions allow their own answers and are asked in a **single** request for information.

**Question 1: PR Link**
- Ask: "What is the PR link? (leave blank if none)"
- If provided, use `gh` CLI to fetch PR details (diff, base branch, linked issues).
- If left blank, proceed without a PR link.

**Question 2: Related Issues**
- Ask: "Are there any issues this PR/branch resolves? Paste issue numbers or links, or leave blank if none."
- Accept a comma-separated list of issue numbers or URLs.
- If left blank, proceed without issue validation.

**Question 3: Base Branch**
- If a PR link was provided, say the base branch will be pulled from the PR and ask: "Press enter to confirm, or type a custom branch to override."
- If no PR link was provided, ask: "What is the base branch to diff against?" and offer the repo's default branch (`gh repo view --json defaultBranchRef -q .defaultBranchRef.name`, or `git symbolic-ref --short refs/remotes/origin/HEAD`) as the default, allowing a custom branch (e.g. for stacked PRs).

# Workflow

1. Gather initial information (see above).
2. Obtain the diff. **Prefer a local diff over `gh pr diff` whenever the branch is checked out locally** -- `gh pr diff` and `git diff <base_branch>...HEAD` (three-dot) only reflect *pushed, committed* history. Neither shows staged or unstaged local edits. Instead:
   ```bash
   merge_base=$(git merge-base <base_branch> HEAD)
   git diff "$merge_base"          # base..working-tree: committed AND uncommitted (staged + unstaged) changes
   git status --porcelain          # check for untracked new files, which `git diff` never shows
   ```
   `git diff "$merge_base"` (a single ref, not a range) diffs that commit against the *current files on disk*, so it picks up local edits on top of HEAD. If `git status --porcelain` shows untracked files relevant to the change, read them directly and call them out as new files in the review.
   - Only fall back to `gh pr diff <number>` when you don't have the branch locally -- in that case, note in the review that it covers pushed commits only.
3. If resolved issues were provided, fetch their descriptions with `gh issue view` to understand the expected scope.
4. Read through changed files, loading additional context only as needed.
5. Produce tagged comments grouped by file, referencing specific lines.
6. Summarize with counts per tag level and an overall blocking/non-blocking verdict.
7. If resolved issues were provided, include a section assessing whether the PR adequately addresses each issue.
8. Write the full review to a markdown file (see Output File below).

# Output File

The review **must** be written to a markdown file in the `.reviews/` directory at the repository root.

Create `.reviews/` if it does not exist. If `git check-ignore -q .reviews/x` fails (not ignored), add `.reviews/` to `.git/info/exclude` so review files never get committed -- don't edit the repo's `.gitignore` for this.

**Filename convention:**
- If a PR number is available: `.reviews/pr-<number>.md` (e.g., `.reviews/pr-123.md`)
- If no PR, use the branch name: `.reviews/<branch-name>.md`, replacing `/` with `-` (e.g., `feature/foo` becomes `feature-foo`)

**File structure:**

```markdown
# Review: PR #<number> | <branch-name>

- **Date:** <YYYY-MM-DD>
- **Base Branch:** <base_branch>
- **Resolved Issues:** <list or "None">

## Summary

| Tag | Count |
|---|---|
| mountain | 0 |
| boulder | 0 |
| pebble | 0 |
| sand | 0 |
| dust | 0 |
| question | 0 |

**Verdict:** Blocking / Non-blocking

## Comments

### `<file_path>`

- `<tag> <comment>` (line <number>)

### `<file_path>`

- `<tag> <comment>` (line <number>)

## Issue Coverage

<!-- Only if resolved issues were provided -->
- **#<issue>**: Addressed / Partially addressed / Not addressed -- <brief explanation>
```

The file is the canonical output -- do not duplicate the full review in chat, just confirm the file was written and highlight any blocking items.

# Resolution Process

After the review file is generated, the user will respond to comments **directly in the review file**. Each comment becomes its own **thread** -- a back-and-forth conversation nested under the original item.

## Thread Format

Each thread is a flat list of nested items under the original tagged comment. The conversation alternates between user and reviewer responses. **Never delete or modify previous entries in the thread** -- always append.

```markdown
- `boulder` This component doesn't handle the empty array case (line 42)
  - Why do you think that's an issue? The parent always passes a non-empty array.
  - The parent passes `items ?? []` on line 38, so an empty array is possible when `items` is nullish.
  - Resolved

- `question` Why was this moved from a useEffect to useMemo? (line 18)
  - Because the computation is synchronous and doesn't need side-effect semantics
  - Are you sure? The original useEffect was triggering a fetch call.
  - Good catch, I missed that. I'll revert this change.
  - Resolved

- `mountain` This schema design won't scale past 10k records (line 95)
  - It's actually fine because we partition by tenant, so no single partition exceeds 1k records
  - Fair point, the partition strategy addresses the concern.
  - Resolved
```

## Resolved Items

When a thread is resolved (the last entry is "Resolved" or the reviewer accepts the rebuttal), the reviewer **must** update the original tag line to mark it resolved during re-review:

```markdown
- `(RESOLVED) boulder` This component doesn't handle the empty array case (line 42)
  - Why do you think that's an issue? The parent always passes a non-empty array.
  - The parent passes `items ?? []` on line 38, so an empty array is possible when `items` is nullish.
  - Resolved
```

The `(RESOLVED)` prefix is added to the **original tag line only**. The rest of the thread remains untouched.

## Handling Rebuttals

When the user provides rebuttals and asks you to re-review:

- **You are allowed and expected to push back** if the user's reasoning is incorrect. Do not simply accept all rebuttals.
- Evaluate each rebuttal on its technical merits. If the user is right, acknowledge it and append your acceptance to the thread. If the user is wrong, append your counter-argument.
- The reverse is equally true -- the original review comment may have been wrong. Be willing to retract when presented with valid reasoning.
- **Never delete or overwrite** previous thread entries. Always append to the thread.
- A thread is only resolved when the last entry is "Resolved" or both parties agree.
- After re-review, update the **Summary** table counts. Resolved items should not count toward the totals.
