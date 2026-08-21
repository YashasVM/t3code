# T3 Code upstream review feed

This branch is an automated review surface for `pingdotgg/t3code` changes that may need to be reconciled into `YashasVM/t3code`.

## Canonical machine endpoint

Read `review-site/feed.json` from this branch. Treat it as the source of truth.

## Agent workflow

1. Read `feed.json` and remember `generated_at`, `cursor.upstream_head`, and every review `id` already processed.
2. Prioritize `recommended_actions` by `priority`: `critical`, `high`, `medium`, then `low`.
3. For every review with `action_required: true`, inspect the referenced upstream commit/PR and the current target branch before changing code.
4. Preserve user-specific changes in `YashasVM/t3code`; never solve an upstream conflict by silently deleting custom features.
5. Apply changes on a dedicated update branch, not directly on `main`.
6. Run the smallest relevant tests first, then broader typecheck/lint/build checks when the touched surface warrants it.
7. If a finding is uncertain, mark it blocked and request evidence rather than guessing.
8. Do not auto-merge a high/critical-risk change. Prepare the patch/PR and report what still needs human approval.
9. When an upstream PR is still open, do not treat it as shipped. Use its review only as advance compatibility information unless explicitly asked to cherry-pick it.
10. When an upstream commit lands on `main`, reconcile it against the user's fork and personal patches.

## Review object expectations

Each item in `reviews` should contain, when applicable:

- `id`: stable identifier such as `commit:<sha>` or `pr:<number>:<head-sha>`
- `type`: `commit` or `pull_request`
- `title`, `url`, `sha`/`pr_number`
- `risk`: `low`, `medium`, `high`, or `critical`
- `verdict`: concise outcome
- `findings`: concrete code-review findings, not just a summary
- `compatibility`: impact on `YashasVM/t3code` and its custom changes
- `action_required`: boolean
- `agent_instruction`: exact next action
- `tests`: checks that should be run after applying the action

## Safety rule

This feed is advisory. A review can recommend code changes, but the consuming agent must validate the current repository state before editing or merging.
