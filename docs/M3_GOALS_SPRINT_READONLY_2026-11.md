# M3 — OAuth-scoped Goals and Sprint/List task snapshots (2026-11-11)

**Scope:** Three named, read-only TypeScript MCP capabilities. This is a source-only milestone; it does not authorize Cloudflare deployment or ClickUp writes.

## Contract and evidence

Official ClickUp v2 reference:
- [Get Goals](https://developer.clickup.com/reference/getgoals): `GET /api/v2/team/{team_id}/goal`, optional `include_completed`.
- [Get Goal](https://developer.clickup.com/reference/getgoal): `GET /api/v2/goal/{goal_id}`, includes Goal targets (key results).
- [Get Tasks](https://developer.clickup.com/reference/gettasks): `GET /api/v2/list/{list_id}/task`, maximum 100 tasks per page; `include_timl=false` only includes home-List tasks.
- [ClickUp Sprint reporting](https://help.clickup.com/hc/en-us/articles/6310087298327-Monitor-and-report-on-your-sprints): Sprints are represented by Lists in Sprint Folders; native Sprint velocity and burn charts are Dashboard cards, not equivalent to sampled task reads.

## Tools

`clickup_get_workspace_goals`: Workspace OAuth grant required; use `include_completed`, `max_results`, `goal_offset` (local slice, not invented server cursor). Verify schema, unique Goal identifiers and any explicit upstream Workspace ancestry. Return incomplete flag when sliced or nested content is clipped. Reject malformed or foreign records.

`clickup_get_goal_details`: Workspace OAuth grant required; **first list the current authorized Workspace's Goals with completed included** and prove exact Goal ID membership. Only then GET the individual Goal. Compare ID and any explicit Workspace ancestry; bound `key_results`, announce omitted Targets. Do not treat an arbitrary UUID as authority. Existing Goal permissions and plan availability remain upstream-controlled.

`clickup_get_sprint_task_snapshot`: Verify an exact authorized List before any task read; works for both an ordinary List and a Sprint List but **does not independently certify which**. Use ClickUp task pages with `include_closed=true`, `subtasks=true` and `include_timl=false` to avoid cross-home-List disclosure. Reject rows with a mismatched home List. Return only task ID/title/status/points, a count and a sum for the bounded sample. Return page and offset continuation; no native Sprint committed-points, velocity, burnup, burndown, scope-change or full-period metrics are claimed.

## Verification

- Schema closed, per-tool read effect and registered operation count.
- Workspace-only Goals access; same-Workspace Goal list membership proof before detail access.
- Malformed, duplicate, foreign and mismatched Goals/Targets rejected without unsafe follow-up.
- List-scoped Sprint snapshot tests; strict home List check and zero POST/PUT/DELETE calls.
- Local Goals and Sprint page/offset continuations, incomplete flags, no invented full-Sprint KPI.
- Strict CI, build, OAuth smoke, audit, CodeQL on **exact PR HEAD**; source-review gate.
- No live ClickUp Goals/Sprint feature or company Worker deployment asserted. Live availability is dependent on each Workspace/plan.

## Next acceptance gate

Review the exact merged source commit, complete issue #120's isolated staging self-DM acceptance, and deploy any changes only through the protected manual workflows when approved.
