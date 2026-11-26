# Signed-webhook task index automatic synchronization — 26 November 2026

**State:** Source-only candidate, draft PR #171, stacked on the persistent-index foundation PR #170. Not merged or deployed.

## Purpose and existing infrastructure

Use ClickUp's existing signed webhook subscriptions to invalidate exact task/comment
records and refresh them through the same Cloudflare Worker, per-user ClickUp OAuth
connection, SQLite-backed Durable Object and shared API quota. No new application,
external database product, privileged token or writable ClickUp operation is added.

The operator can enable event-driven execution with
`CLICKUP_INDEX_AUTOSYNC_ENABLED=true`. Omission or any other value leaves
background synchronization off. The normal webhook receiver and its seven-day
retained event register continue operating independently.

## Authority and event flow

1. The public `/clickup/webhook` route verifies the native ClickUp HMAC and
   resolves the webhook's operator-created registration. Only the verified
   registration, **not webhook body fields**, supplies `workspaceId` and
   `subject` for the private Durable Object ingress envelope.
2. The internal ingress stores the registration identity in the exact existing
   Workspace/actor Durable Object partition, rejecting a conflicting owner.
   It accepts legacy array ingress during migration.
3. The event hint is inserted with stable replay identity; **only newly inserted
   hints** invalidate task or comment checkpoints. Repeated deliveries do not
   reopen already-synchronized work.
4. A native Durable Object alarm is scheduled, preserving the existing
   seven-day event-expiry alarm. Each alarm scans a bounded batch of still-dirty
   task IDs, while all remaining work persists in SQLite.
5. Before accessing ClickUp, the background worker rederives the **current**
   user-specific read grant from the original OAuth vault and live staff policy.
   Its principal is authenticated by the signed subscription owner established
   during ingress, not by an arbitrary task/user ID or a model argument. The
   existing ClickUp REST adaptor rechecks native task and home-List/Workspace
   authorization and reserves quota on every task/comment GET.
6. Projected, bounded task/comment fields are stored in the same private index
   with observation timestamps. Partial comment histories never advance the
   full-collection sync checkpoint; changed/removed or inaccessible content is
   handled using the foundation's consistency rules.
7. On transient failures, SQLite stores a retry deadline and attempt number.
   The next native alarm retries later. A new signed event clears the previous
   deferral. HTTP 429 waits use a one-minute retry; other delays grow up to
   one hour. Temporary OAuth failure causes the alarm to stop using credentials
   and pause, not attempt an unauthorized read.

## Exclusions and limitations

- This source does **not** turn on the new feature in production. The Worker
  operator must review, deploy and enable the flag separately.
- Comment histories longer than 50 returned items remain explicitly partial
  and are deferred; full unbounded, persisted multi-page reconciliation is a
  subsequent increment.
- This does not build or expose a user-facing cache-read MCP tool or P1–P4
  attention ranking. Ordinary ChatGPT queries still require existing tools.
- Existing webhook event acknowledgement and independent review consumers
  remain unchanged.
- No ClickUp task/comment mutation or other connected-app write occurs.
- Cached content must never be served to a caller without current ClickUp
  permission verification; no such serving route exists in this increment.
- A disconnected/revoked OAuth principal stops refresh operations; the worker
  may periodically retry according to durable backoff until the situation
  changes. Follow-up lifecycle cleanup and retention policy require review.
- This design relies on internal-only Durable Object RPC routing; external
  clients cannot supply the signed registration identity. An exact-head
  specialist security review must confirm that trust boundary before merge.

## Deployment acceptance gates

- Phase 1 PR #170 accepted and merged before the production merge of #171.
- Strict CI, TypeScript split checks, formatting, lint, full Vitest, Worker
  dry-run/smoke, and CodeQL successful on the exact finalized PR SHA.
- Real SQLite tests verify backoff selection, missing/deleted data, stale
  observation, webhook replay and provider-scope invalidation.
- Synthetic signed ingress demonstrates an alarm is scheduled with the
  bound actor, while missing or revoked OAuth cannot cause a provider read.
- Specialist Codex review of the final SHA; all significant findings fixed.
- Initial controlled deployment with autosync **off**, then owner-authorized
  flag activation and read-only diagnostics (pending index jobs, API 429s,
  retained hints). No fabricated live-read acceptance before actual checks.

## Next follow-up increment

Persist complete multi-page comment reconciliation and implement missed-webhook
periodic backfill, then build the historical chronology and P1–P4 attention
curation on verifiable, fresh index state.
