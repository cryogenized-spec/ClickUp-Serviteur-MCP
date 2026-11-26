# Actor-local follow-up action ledger (draft, 26 November 2026)

## Provenance and deployment

This is a **source-only** stacked increment built on PR #172 (which itself
depends on #171 and #170). It is not merged, deployed or live until the
protected deployment process has verified the exact merged SHA.

Existing Cloudflare Workers and the **same SQLite-backed
`ClickUpWebhookEvents` Durable Object** are reused. No D1 database,
external service, new OAuth scope, webhook subscription or ClickUp write is
required. The Durable Object is already partitioned by approved Workspace and
the authenticated GitHub/ClickUp actor.

## Why this is distinct from the task index

The task index records *authoritative ClickUp snapshots* and dirty markers.
The follow-up ledger records *curated workflow decisions and verified or
explicitly-noted actions*. They are not interchangeable. A new webhook must
never automatically mean "awaiting response", "customer contacted" or
"resolved" without sufficient evidence.

## Native MCP surface

- `clickup_get_followup_state(task_id, max_results?, followup_before_revision?)`:
  validates current ClickUp task access under the actual connected user's OAuth
  credential before reading the private follow-up state and paginated history.
  The response includes current task status/owner from the live task read, not
  from cached follow-up notes.
- `clickup_record_followup_action(task_id, followup_action_key,
  followup_action_kind, followup_state_after, followup_expected_revision,
  followup_note?, followup_evidence_comment_id?,
  followup_waiting_on_user_id?, followup_next_check_at_ms?)`: checks
  current task access before appending to the private register. The exact
  action key provides idempotent retries; optimistic revision rejects stale
  parallel updates. `instruction_sent` requires an exact comment ID which
  the MCP independently finds on the task using the existing live comment
  pagination. A prepared draft alone cannot be recorded as sent.
  Other action types are explicitly human-curated observations unless
  comment evidence is provided and independently verified.

No tool alters ClickUp, calls a customer, sends email, or acknowledges a webhook
event. The register has an atomic append-only action history and an updated
current-state projection. User notes and staff IDs remain in the private
per-actor/Workspace partition; no customer data is committed to public GitHub.

## States

`detected`, `verified`, `action_required`, `action_taken`,
`awaiting_response`, `response_received`, `resolved`.

Action kinds: `observation`, `draft_prepared`, `instruction_sent`,
`response_received`, `followup_checked`,
`resolution_confirmed`, `note`.

Use an exact stable idempotency key, e.g. `comment:1500260000111534`, for
the same documented action. A repeated key and byte-equivalent normalized
payload returns the original revision without duplicating history; a conflicting
key or stale expected revision is rejected rather than silently overwritten.
`followup_waiting_on_user_id` and `followup_next_check_at_ms` are optional;
omitting them clears those fields in the **new** follow-up projection.

## Important coverage limits

- These are **per-actor private records**, not a shared multi-staff ledger.
  Existing OAuth isolation is intentional; sharing a coordinated workspace
  obligation register would require an explicit scoped data model and review.
- The current implementation creates the durable record and authenticated
  tools; it **does not yet auto-log** all existing ClickUp mutations, deduce
  obligations from comment text, send reminders, or carry state over from
  old work. It is not a webhook consumer or a substitute for the 15:00 watch.
- The SQLite index supports querying due task IDs privately, but a
  model-facing overdue list must reauthorize *each* task before returning it.
  No overdue enumeration tool is exposed in this increment.
- No silently inferred conversation evidence or false delivery claims.

## Validation required before merge

Run formatting, lint, strict TypeScript, Vitest (including actual SQLite
tests), Cloudflare Worker build and existing security checks. Review OAuth
boundaries, replay semantics and task/comment read consistency. Then submit
for protected merge and deployment with exact-SHA validation.