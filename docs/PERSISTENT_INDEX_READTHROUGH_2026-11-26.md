# Read-through task index reconciliation — 26 November 2026

**Status:** Source-only, separate incremental follow-up to draft PR #171. Neither
this candidate nor its prerequisite PRs has been merged/deployed.

## User goal

Detect tasks that were created or modified while a ClickUp webhook was absent,
delayed or lost, while avoiding repeated whole-Workspace fetches and preserving
ClickUp as the source of truth.

This first incremental implementation uses the **existing authorized**
`clickup_filter_tasks` and `clickup_get_my_tasks` list readers. Whenever one
of these tools already queries a page of ClickUp tasks, Serviteur can privately
compare the page's minimal task identity and source revision with its persistent
task index. It introduces no extra ClickUp GETs on that list query.

## Read-through process

1. Preserve the read-start timestamp before the existing List/Workspace
   authorization and upstream pagination.
2. Preserve the native ClickUp result unchanged for the requesting MCP client.
   Do not substitute indexed content for authoritative provider content.
3. Project only `task_id`, primary `list_id` and `date_updated` from each
   verified page, at most 50 per operation. Do not copy descriptions, signed
   attachment URLs, assignees, comments or other provider payload fields into
   discovery hints.
4. Send the projected page to a private RPC in the same actor/Workspace Durable
   Object already authorized for the normal index capture.
5. Within a SQLite transaction, compare those task revisions to existing
   complete snapshots. A matching/current revision is unchanged; a new or
   changed task with no already-pending refresh becomes dirty. An already
   pending task retains its original retry deadline, even if the same list
   page is read again by an automation.
6. Queue both task and comment refresh for new/changed tasks. The previously
   implemented native Durable Object alarm and per-user OAuth refresh worker
   fetch authoritative task/comment content when its operator flag is enabled.
7. Denial-watermark checks prevent older in-flight list pages from reopening
   tasks already invalidated following definitive ClickUp access loss.

## Limits and truthfulness

- **Not a periodic scan yet.** A missed event is detected only when an
  authorized task-list read subsequently encounters the affected task. Existing
  NeonSales watches may provide those reads but should not be assumed to do so
  unless their actual prompts explicitly invoke filtered/My Tasks reads.
- A comment change that does not advance the task's `date_updated` is not
  guaranteed to be captured by this task-summary check. A later bounded
  comment audit is still required.
- The default task search omits closed work unless its caller explicitly
  opts to include closed records. This increment does not establish complete
  historical or deleted-task reconciliation.
- The existing task-list reader can return incomplete pages. This incremental
  integration covers only the items actually returned to the current request;
  it does not falsely mark a full List/Workspace scan complete.
- Only the current OAuth actor's existing List/Workspace authority determines
  which list pages are eligible. A list summary can enqueue an internal
  **revalidation request**, not grant access to a task's content.
- No new app, database product, network credential, ClickUp write, public RPC,
  user-facing cached read or priority engine is added.

The native ClickUp API documents `date_updated_gt` for Get Tasks, already
exposed by Serviteur's existing `filter_updated_after_ms` argument. Operators
can use overlapping incremental windows with the pre-existing scheduled
read-only watches. The next increment should add a durable pagination cursor,
monotonic scan checkpoint, overlap window, and bounded timed reconciliation
through the same Worker (plus periodic comment freshness auditing).

## Acceptance

- Exact-head CI passes formatting, lint, strict TypeScript, Vitest, Worker
  smoke/build and high/critical dependency audit.
- CodeQL on the exact head is green.
- Real SQLite tests demonstrate missing-task discovery, changed revisions,
  unchanged skip, preservation of retry cooldown, and denial watermark
  behavior across old list pages.
- Auth capture tests demonstrate that minimal hints are used and a foreign
  List is not indexed.
- Specialist reviewer checks the actor/Workspace boundary, read-start
  timestamp, incomplete page handling and false-fresh risk.
- No merge or production deployment is implied.
