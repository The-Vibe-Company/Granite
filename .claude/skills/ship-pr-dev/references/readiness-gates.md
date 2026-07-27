# PR Readiness Gates

Use these gates to decide whether the PR can be presented as merge-ready.

## Hard Blocks

Stop before push or mark the PR blocked when any of these are true:

- unresolved merge conflicts
- failing required or relevant checks
- unreviewed P0/P1 `review-code-dev` findings
- confirmed P2 findings without a documented accepted-risk reason
- frontend diff without a frontend-focused `review-code-dev` gate
- blocking frontend gate findings not fixed
- CI unavailable or not green on the latest pushed commit for a `ship` or `update-pr` run, unless the user explicitly requested local-only work
- secrets in the diff, logs, fixtures, or config
- destructive migration without rollback/deploy-order notes
- auth, billing, permissions, export, or privacy behavior changed without tests or clear verification
- frontend critical path changed without at least one rendered or interaction-level check when tooling is available
- PR branch includes unrelated user work that cannot be safely separated
- push/PR credentials are missing
- use of `--no-verify`, skipped tests, disabled checks, weakened lint rules, or equivalent bypasses

## Required Evidence

`verification.md` should include:

- exact command
- pass/fail/skipped
- why it was selected
- important output summary
- timestamp or sequence marker
- whether code changed after the command

`review-gate.md` should include:

- `review-code-dev` mode
- base branch
- artifact path
- finding counts by severity
- fixed findings
- accepted-risk findings
- reason if the review had to run inline instead of in a subagent

`review-board.md` should include:

- whether the board ran with subagents, inline equivalent, or N/A
- selected angles
- findings fixed
- false positives rejected
- remaining non-blocking notes

`frontend-gate.md` should include for frontend diffs:

- `review-code-dev frontend` mode or equivalent frontend-focused review mode
- impacted user paths
- blocking findings fixed
- remaining non-blocking notes

`ci.md` should include for pushed PRs:

- latest pushed SHA
- PR URL
- check names and final states
- failed check log summary and first causal error when applicable
- fix attempts per check

## Severity Policy

- P0: never ship.
- P1: never present as merge-ready until fixed or conclusively false positive.
- P2: fix by default. If not fixed, document why it is accepted risk and make the PR non-merge-ready unless the human explicitly accepts it.
- P3: fix when cheap. Otherwise list in PR notes as follow-up or polish.

## Verification After Changes

Any source change after a passing test, build, or review can stale that evidence. Re-run the affected verification. If only PR text, changelog, or comments changed, say why verification remains fresh.

## Loop Limits

Default caps:

- 3 implementation/fix cycles
- 2 full verification cycles after source changes
- 2 `review-code-dev` gate runs
- 1 frontend-focused gate pass plus targeted fixes; rerun only if the first pass found blocking issues and the tool supports a cheap rerun
- 3 correction attempts for the same CI check

When a cap is reached, stop and produce a blocked handoff with the current evidence and the smallest next action.

## Human Decision Gates

Ask or stop when the next step changes ownership or risk:

- splitting mixed unrelated work
- rewriting public history
- dropping files
- accepting unresolved P2 risk
- shipping with unavailable checks
- creating a draft PR despite blockers
- changing the target base branch
- treating a frontend diff as merge-ready without frontend review coverage from `review-code-dev`
- accepting CI failure as unrelated or environmental

Routine commit, normal push, and PR creation are part of this skill when the user asked to ship a PR.
