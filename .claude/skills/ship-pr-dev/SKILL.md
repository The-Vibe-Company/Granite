---
name: ship-pr-dev
description: "Ship PR: autonomous pull request readiness workflow. Use when the
  user asks to ship work, prepare a branch for review, create or update a PR,
  get changes ready to merge, clean up a branch before PR, monitor/fix CI, run
  final verification, or make a PR that a human can confidently merge. This
  skill may edit code, run tests, commit, push, create/update a PR, and iterate
  on failing checks, but it must use review-code-dev as the independent
  read-only review gate, route frontend scrutiny through review-code-dev, and
  never merge the PR itself."
metadata: {}
allowed-tools: Bash Read Edit Write Glob Grep Agent
---

# Ship PR

Ship PR is the delivery orchestrator for producing a PR that is ready for a human to merge. It can change code and Git state, but the merge decision stays human. Treat the final output as a clean handoff: tested branch, green local verification, green CI when accessible, independent review passed or explicitly blocked, and a PR body that tells the reviewer exactly what changed and how it was verified.

## Protected Invariants

1. Never merge the PR, enable auto-merge, force-push, reset hard, drop user work, or rewrite existing non-WIP commits unless the user explicitly asks for that exact operation.
2. Stage only intentional files. Never use broad staging when unrelated local changes exist.
3. Keep `review-code-dev` independent and read-only. Do not edit source code inside the review run.
4. For frontend diffs, route the frontend pass through `review-code-dev frontend` before PR handoff. `ship-pr-dev` must not depend on or invoke frontend design sub-skills directly; `review-code-dev` owns those dependencies.
5. A PR is merge-ready only when local verification passes, CI is green on the latest pushed commit when CI is accessible, and `review-code-dev` has no unresolved P0/P1 findings. Fix P2 findings by default unless they are clearly accepted risk or false positive. Track P3 findings in the PR notes if they remain.
6. If checks cannot be run, credentials are missing, the branch cannot be pushed, CI cannot be inspected, or a review gate is unresolved, stop with a blocked handoff rather than pretending the PR is ready.
7. Do not publish secrets. If a secret is discovered, redact it, stop push/PR work, and give rotation guidance.
8. Do not use `--no-verify`, skip tests, disable lint/check rules, or bypass CI to make the PR appear green.
9. Write local shipping artifacts only under `plans/ship-pr-dev/runs/<timestamp>-<repo-slug>/`, and make sure that path is ignored by Git before writing there.

## References

Read only the files needed for the invocation:

- `references/workflow.md` - the phase-by-phase PR shipping loop.
- `references/review-board.md` - read-only specialist review board angles and output format.
- `references/readiness-gates.md` - stop conditions, verification expectations, and review gate policy.
- `references/pr-template.md` - PR body structure and final handoff format.

Also read the `review-code-dev` skill before the review gate. In this workspace it lives at `skills/review-code-dev/SKILL.md`; in another runtime, resolve the installed skill named `review-code-dev`.

## Workflow Summary

### Phase 0 - Invocation Contract

Classify the ask:

| Cue | Mode | Goal |
| --- | --- | --- |
| "create a PR", "ship this", "make it merge-ready" | `ship` | finish, verify, review, push, open/update PR, and monitor CI |
| "cleanup before PR", "get this branch clean" | `prepare` | fix and verify locally, create PR only if the user clearly wants it |
| "update this PR", "fix CI", "make checks green" | `update-pr` | sync branch, fix feedback or CI, re-verify, update PR |
| "do not push", "local only" | `local-handoff` | stop before push and return exact local readiness state |

If the user did not specify a base branch, infer it from the upstream/default branch: prefer the PR target, then `origin/HEAD`, then `origin/main`, then local `main`. Always compare branch changes with `<base>...HEAD`. If the repository has no Git metadata, stop and explain that `ship-pr-dev` needs a Git repository.

### Phase 1 - Run Setup

Before writing artifacts:

```bash
SKILL_DIR="<directory containing this SKILL.md>"
RUN_META="$(mktemp -t ship-pr-dev-run.XXXXXX.json)"
python "$SKILL_DIR/scripts/prepare_ship_run.py" --cwd . > "$RUN_META"
RUN_DIR="$(python -c 'import json,sys; print(json.load(open(sys.argv[1]))["run_dir"])' "$RUN_META")"
```

Use `RUN_DIR` for `ship-state.json`, `context.json`, `verification.md`, `review-board.md`, `frontend-gate.md`, `review-gate.md`, `ci.md`, `pr-body.md`, and any scratch notes. Do not commit `RUN_DIR`.

Collect deterministic branch context early:

```bash
python "$SKILL_DIR/scripts/collect_ship_context.py" --cwd . --output "$RUN_DIR/context.json"
```

### Phase 2 - Plan The Ship Loop

Read `references/workflow.md` and create a concise checklist in `RUN_DIR/ship-state.json`:

- intent and success criteria
- base branch and working branch
- changed files and unrelated dirty files
- frontend/backend/API/DB/auth/security/privacy impact
- required checks
- review board status
- frontend gate status
- review gate status
- CI status
- commit and PR status
- blocker status

Use subagents when available for read-only work that benefits from independence:

- Mandatory: launch `review-code-dev` in a fresh subagent for the final review gate when subagents are available. If no subagent mechanism exists, run it inline and record the fallback.
- Recommended for non-trivial diffs: run a read-only review board from `references/review-board.md` with distinct specialist angles. If no subagent mechanism exists, run the same grid inline and record `Review board: local equivalent`.
- Optional: launch a read-only CI investigator only for failing CI that is not obvious from logs.

### Phase 3 - Implement Or Clean Up

Make the minimal code, docs, and test changes needed to satisfy the user goal and repository conventions. Preserve unrelated user work. If the branch contains mixed unrelated work, either separate only the requested work safely or stop and ask for direction.

Keep the loop bounded:

- up to 3 implementation/fix cycles
- up to 2 full verification cycles after source changes
- up to 2 `review-code-dev` gate runs
- up to 3 correction attempts for the same CI check

If the same failure repeats after two distinct fixes, stop and report the blocker with evidence.

### Phase 4 - Verify

Read `references/readiness-gates.md`. Discover the repo's formatter, lint, typecheck, test, build, migration, and frontend verification commands from local config and CI. Run the strongest practical check set for the diff. Prefer targeted checks first, then broader checks when feasible.

Record exact commands and outcomes in `RUN_DIR/verification.md`. Fresh verification is required after any code change made in the ship loop.

### Phase 5 - Review Board And Frontend Gate

For non-trivial diffs, run the read-only review board before the final `review-code-dev` gate. Use distinct angles only; do not launch multiple helpers on the same question. Deduplicate and classify results in `RUN_DIR/review-board.md`, then fix valid Critical/High findings and reasonable Medium findings.

For frontend diffs, run a frontend-focused `review-code-dev` pass on the impacted UI before opening or updating the PR. Fix blocking frontend findings, then rerun the affected frontend verification. If `review-code-dev` cannot provide frontend review coverage, stop with a blocked handoff unless the user explicitly changes the scope to local-only exploration.

### Phase 6 - Independent Mega Review Gate

Run `review-code-dev` against the branch/base diff after verification is green enough to review. Use a fresh context or subagent whenever available, and pass only the repo path, base branch, changed-file summary, user goal, and requested review depth.

Use `deep` mode when the diff touches auth, billing, data export, migrations, permissions, public APIs, frontend UX, or cross-module architecture. Otherwise use `standard`.

Write the review result and artifact location in `RUN_DIR/review-gate.md`. Fix confirmed P0/P1/P2 issues, then re-run verification and the review gate within the loop caps. Do not publish helper speculation as a blocker unless the lead review verified it.

### Phase 7 - Commit, Push, PR, And CI

Only after verification and review gates are acceptable:

1. Ensure the branch name is safe. If creating a branch, prefer `codex/<short-purpose>` unless the user requested another name.
2. Stage only intentional files.
3. Use a commitzen commit message.
4. Push with upstream tracking using a normal push.
5. Create or update the PR using the available GitHub/GitLab tool, connector, or CLI. If no PR tool is authenticated, stop after push with the exact compare URL when possible.
6. Monitor PR checks until every required or relevant check reaches a final state. For failures, read logs, identify the first causal error, fix, run the corresponding local validation, commit, push, and resume CI monitoring. Stop after 3 distinct correction attempts for the same check.

Read `references/pr-template.md` before writing or updating the PR body. PR titles should be commitzen, for example `feat(ship-pr-dev): add PR readiness workflow`.

### Phase 8 - Final Handoff

Return:

- PR URL or blocked reason
- latest pushed commit
- branch and base
- verification summary
- `review-code-dev` gate summary
- frontend gate status when relevant
- CI summary when accessible
- remaining human decisions, if any
- local artifact path

Say "ready to merge" only when the local checks, CI checks, frontend gate when relevant, and review gate satisfy the readiness gates on the same latest commit.

## Response Shape

If successful:

```markdown
PR ready for human review: <url>

Branch: <branch> -> <base>
Verification: <commands passed>
Review gate: review-code-dev passed, artifacts at <path>
CI: <checks passed on latest commit>
Notes: <human decisions or residual P3s, if any>
```

If blocked:

```markdown
PR not ready yet.

Blocker: <specific blocker>
Verified: <what did pass>
Next action: <smallest concrete next step>
Artifacts: <RUN_DIR>
```
