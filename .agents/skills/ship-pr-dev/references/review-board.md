# Read-Only Review Board

Use the review board before the final `review-code-dev` gate for any non-trivial diff. The board is a fast independent pass that finds issues early, while `review-code-dev` remains the final authority.

## When To Skip

Mark `Review board: N/A` only for:

- docs-only changes
- typo-only changes
- metadata-only changes with no runtime behavior
- one-file very low-risk changes

Otherwise run the board with subagents when available, or run the same grid inline and record `Review board: local equivalent`.

## Specialist Angles

Choose distinct angles based on the impacted surfaces. Do not launch multiple reviewers for the same question.

- Architecture/coherence: existing patterns, module boundaries, public APIs, duplication, dead code, refactor scope.
- Bug/regression: null/undefined, async, cache, state, dates/timezones, API/DTO mapping, permissions, existing workflows.
- Test coverage: missing tests for new logic, bugfixes, behavioral refactors, API, DB, UI interaction, and regression paths.
- Frontend UX/accessibility/responsive: loading/empty/error states, focus, keyboard, ARIA, overflow, responsive layout, theming, forms, double-submit.
- Security/privacy: auth, permissions, secrets, PII/PHI, logs, URLs, storage, injection, uploads/downloads, external calls.
- CI investigator: use only for a failing CI check whose cause is not obvious.
- External finding validation: use only for complex, ambiguous, architectural, security/privacy, or likely false-positive findings from other tools.

## Reviewer Brief

Each read-only reviewer receives:

- comparison range: `<base>...HEAD`
- changed files
- diff stat
- files or folders they own
- exact review angle
- explicit instruction not to modify files

## Output Format

Require each reviewer to output:

```markdown
Verdict: PASS | PASS_WITH_NOTES | FAIL

Findings:
- severity: Critical | High | Medium | Low
  file: path/to/file.ext:123
  issue: <concrete problem>
  evidence: <proof from diff or existing code>
  impact: <bug, regression, debt, user risk, or security risk>
  fix: <minimal proposed correction>

False positives / non-issues:
- <verified point and reason>

Validation:
- <exact tests or commands recommended>
```

## Integration Rules

The main agent owns synthesis:

- deduplicate findings
- verify evidence before editing
- reject false positives with a short reason
- fix valid Critical and High findings
- fix Medium findings when reasonable; otherwise record why they are non-blocking
- treat Low findings as optional polish unless cheap and low-risk

Write the integrated result to `RUN_DIR/review-board.md`.
