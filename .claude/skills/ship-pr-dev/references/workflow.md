# Ship PR Workflow

Use this workflow as a bounded delivery loop. The main agent owns code changes and Git operations. Read-only helpers may inspect, audit, or summarize, but they do not mutate the repository.

The target state is not "opened PR". The target state is a PR a human can merge: latest commit pushed, required checks green when accessible, local verification fresh, independent review gate clear, and remaining risks documented.

## Phase A - Preflight

1. Confirm the repository root and current branch.
2. Detect the base branch from PR metadata, upstream metadata, `origin/HEAD`, `origin/main`, then local `main`, in that order.
3. Fetch the remote when safe so `<base>...HEAD` is current.
4. Capture `git status --short` and identify unrelated dirty files.
5. If on the default branch with local changes, create a feature branch before editing unless the user asked for local-only work.
6. Read repository guidance: `AGENTS.md`, `CLAUDE.md`, `CONTRIBUTING`, `.github/`, package config, CI config, and relevant docs.
7. If the user referenced an issue, ticket, spec, or PR, read it when accessible.

Stop if unrelated local changes cannot be safely separated. Do not stash or discard them without explicit user approval.

## Phase B - Intent And Scope

Write a short intent statement in `ship-state.json`:

- user-visible goal
- non-goals
- target base branch
- exact comparison range, normally `<base>...HEAD`
- expected verification
- expected PR audience

Use this statement to prevent accidental scope expansion. If the branch already contains extra work, classify it as:

- `in_scope`
- `harmless_supporting`
- `scope_drift`
- `unrelated_dirty`

Only commit `in_scope` and `harmless_supporting` files.

Classify impacted surfaces:

- frontend: UI components, routes/pages, styles, design tokens, visible assets, `.tsx`, `.jsx`, `.vue`, `.svelte`, `.css`, `.scss`, `.less`, mobile UI, or any user-visible interaction layer
- backend/API: request handlers, services, jobs, SDKs, schemas, API contracts, webhooks
- DB/data: migrations, models, indexes, backfills, seed data, warehouse/export logic
- security/privacy: auth, permissions, secrets, PII, logs, uploads/downloads, external calls
- tests-only/docs-only/tooling-only

## Phase C - Implementation Or Cleanup

Make the smallest coherent changes needed to finish the requested work. Prefer existing project patterns over new abstractions. Add or update tests when the change affects behavior, contracts, workflows, permissions, data, UI state, or edge cases.

For frontend changes, verify the user path rather than only the component compile. When browser or visual tooling is available, inspect the rendered state for the changed workflow.

For backend changes, check request/response contracts, migrations, data compatibility, auth, permissions, background jobs, and deploy order.

For test-only changes, verify the test would fail before the fix when practical, or state why that was not practical.

Do not ask "should I continue?" between ordinary phases. Ask only for human decision gates from `readiness-gates.md`.

## Phase D - Verification

Discover checks from:

- package scripts
- CI workflows
- Makefile or task runner
- language-specific config
- existing docs

Run checks in this order when relevant:

1. formatting or static quick checks
2. lint
3. typecheck
4. targeted tests for changed behavior
5. broader test suite
6. build
7. migration or schema checks
8. frontend visual/browser smoke checks

Record skipped checks with a concrete reason, not a vague note.

## Phase E - Read-Only Review Board

Run the review board from `review-board.md` for any non-trivial diff. Mark it `N/A` only for docs-only, typo-only, metadata-only, or a one-file very low-risk change.

Integrate board output:

- deduplicate findings
- reject false positives with a short reason
- fix valid Critical/High findings
- fix Medium findings when reasonable, otherwise record them as non-blocking known issues only when they do not affect merge safety
- treat Low findings as polish unless cheap and low-risk

Keep review-board helpers read-only. The main agent applies fixes.

## Phase F - Frontend Gate

If the diff is frontend, run a frontend-focused `review-code-dev` pass before opening or updating the PR. The pass must focus on the impacted user path and cover loading, empty, error, focus, keyboard, ARIA, overflow, responsive behavior, theming, forms, double-submit, and visible regressions.

Do not invoke frontend design sub-skills directly from `ship-pr-dev`. `review-code-dev` owns any frontend specialist dependencies. If `review-code-dev frontend` cannot run for a frontend diff, stop with a blocked handoff.

Do not loop indefinitely on the frontend gate. Fix blocking findings, rerun affected frontend checks, then let the final `review-code-dev`, local verification, and CI provide the remaining gates.

## Phase G - Mega Review Gate

Run `review-code-dev` only after the branch is coherent enough to review. It should inspect the branch/base diff, not the whole repository. The review is independent:

- fresh context or subagent when available
- read-only
- no source edits
- artifacts saved by `review-code-dev`
- final findings verified by the review lead

If `review-code-dev` finds P0/P1/P2 issues, fix them in the main ship loop, not inside the review. Then rerun verification and rerun the review gate if loop caps allow.

## Phase H - Commit And PR

Before committing:

- re-check status
- stage only intentional files
- inspect staged diff
- keep generated artifacts out of the commit unless they are intentional product files
- use a commitzen message

For large changes, prefer coherent commits that remain reviewable. Do not rewrite existing public branch history without explicit approval.

Create or update a PR only after local verification, review board, frontend gate when relevant, and `review-code-dev` are acceptable. Create a draft/blocked PR only when the user explicitly wants the work visible despite known blockers.

## Phase I - CI To Green

After the PR exists or is updated:

1. Find the latest pushed commit SHA.
2. Wait for required and relevant checks until none are queued or in progress.
3. For each failed, cancelled, or errored check, read the useful logs and find the first causal error rather than cascade failures.
4. Decide whether the failure is caused by the diff, pre-existing, or environmental. Fix diff-caused failures. Fix pre-existing failures when the fix is scoped and low-risk; otherwise block with evidence.
5. Run the corresponding local validation when possible.
6. Commit with a targeted conventional message, push, and restart CI monitoring.

Stop after 3 distinct correction attempts for the same check. Do not disable checks, skip tests, use `--no-verify`, or weaken validation to get green CI.

## Phase J - Final Local Freshness Check

When CI is green on the latest commit, make sure local evidence is still fresh. If source code changed after the last local checks or review gate, rerun the affected verification. If only PR text changed, record why checks are still fresh.

## Phase K - Handoff

The final handoff should be boring and precise:

- PR URL
- latest commit SHA
- branch and base
- what changed
- checks run
- CI result on latest commit
- review gate result
- frontend gate result when relevant
- remaining human decisions
- known residual risk

Never claim "all clean" if any required check was skipped for a reason other than irrelevance.
