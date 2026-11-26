# Persistent task index foundation — 26 November 2026

## Goal and authority

Add a read-only-derived persistent index to the existing ClickUp Serviteur Worker.
ClickUp remains the authoritative source for task contents, comments, assignments
and authorization. The index is a private optimization and continuity aid, not
another task-management application or independent permission system.

This document describes the first incremental PR. The agreed end-state includes
event-driven refresh, reconciliation, extended chronology and curated P1–P4
attention reports; those are **not** delivered by this first increment.

## Implemented first increment (source candidate, not deployed)

The existing actor/Workspace-partitioned `CLICKUP_WEBHOOK_EVENTS` SQLite
Durable Object gains three tables:

- `task_snapshots`: keyed by task ID, with projected title, status, priority,
  due date, selected description text, assigned user IDs, List ID, source
  modification timestamp and time of the authenticated GET.
- `comment_snapshots`: keyed by task ID and comment ID, with bounded comment
  text, author, timestamp, resolved/assigned state and structured mentions.
  Raw attachment URLs, credentials and unrelated provider metadata are omitted.
- `task_refresh`: independent task and comment invalidation timestamps and
  successful verification timestamps.

The webhooks' existing signature verification, deduplication keys, acknowledgement
and independent-consumer semantics remain intact. Ingestion marks relevant
records dirty. A successfully authorized `clickup_get_task` or
`clickup_get_task_comments` invocation captures a projected snapshot after its
normal authoritative ClickUp read, using best-effort private Durable Object RPCs.
A partial comment scan inserts observed unique comments but does not mark
comment synchronization complete. The ordinary MCP read returns ClickUp's
authoritative response, never a cached substitute.

The existing internal diagnostics route reports indexed task/comment counts and
pending refresh counts. A private index lookup is present for future consumers,
but no public MCP tool can serve this cached data in the first increment.

## Consistency rules

- Unique primary keys and SQLite UPSERT prevent duplicate task/comment records.
- Read-observation timestamps protect against overwriting newer snapshots
  with late-arriving older reads; task source-update timestamps are also compared.
- A webhook delivered after a read started does not become fresh merely because
  that read subsequently returned. Independent dirty/check timestamps expose it.
- Partial or failed reads do not clear comment refresh state.
- Event retention remains seven days and 5000 retained hints per partition.
  Task/comment snapshot retention, reconciliation and pruning need a later
  explicit decision and implementation.

## Security and exclusions

No ClickUp writes, new external network paths, additional identities, new
Cloudflare products or public data endpoints are introduced. The index is
partitioned by the existing OAuth actor/Workspace Durable Object identity.
Cache capture only follows a task read verified by the current user's ClickUp
OAuth authorization and home-List policy. Cached content is **not** sufficient
to establish present access. A later index-read feature must always validate
current scope and freshness before releasing any cached content.

The first PR does **not** provide automatic webhook-triggered task/content
refresh, missed-webhook reconciliation, historic thread indexing, semantic
classification, P1–P4 briefings, or a faster no-ClickUp request path. These are
separate reviewed increments.

## Acceptance gates

1. Prettier, ESLint, split strict TypeScript checks, full Vitest suite, Worker
   build, OAuth smoke checks and dependency audit pass for the exact PR head.
2. Synthetic tests cover projection/minimization, structured mentions,
   task/comment dirty-state differences, idempotent SQLite syntax, and
   same-List capture selection.
3. PR review confirms private-only storage access, no regression to webhook
   acknowledgement, and no misleading claims of an automatically refreshed cache.
4. No production deployment until the exact reviewed commit is merged through
   the established owner workflow and followed by the protected company deployment.

## Next increment

Add a deduplicated refresh queue consuming dirty task IDs and retrieving their
authoritative task/comment pages with current OAuth authority, coordinated
upstream rate-limit handling and durable resumable processing. Reconciliation
and P1–P4 curation follow only after refresh correctness is demonstrated.
