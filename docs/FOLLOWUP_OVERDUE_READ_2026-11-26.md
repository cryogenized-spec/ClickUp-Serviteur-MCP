# Authorized overdue follow-up retrieval — incremental candidate (26 Nov 2026)

## Provenance and boundaries

This follow-up is based on merged PRs #170–#173 and the verified `main` merge commit
`c6002d012bb518cbc7ad998c202b09eb64fe9e92`. It makes no ClickUp
task/comment changes, sends no notifications and never globally acknowledges
webhook events. No new database, Cloudflare Worker, subscription, OAuth scope or
secret is required. The existing per-actor/per-Workspace SQLite-backed
`ClickUpWebhookEvents` Durable Object continues to hold private obligations.

**IMPORTANT:** This is only a new source branch until merged, deployed and
tested against the actual authorized production Worker. No historical actions
are automatically backfilled. The ledger is curated, not inferred from ClickUp.

## MCP interface

`clickup_get_overdue_followups` is a read-only MCP tool. Its optional fields:

- `max_results`: at most 50 candidates inspected per call, not a lifetime
  limit on the number of records or ClickUp API requests
- `list_id`: optional, reverified against the same OAuth grant; limits
  visible results to that exact home List
- `followup_due_before_ms`: cutoff (defaults to current server time);
  supply the *same* value to continuation requests
- `followup_after_due_ms` and `followup_after_task_id`: paired keyset
  continuation cursor values returned by the preceding response

Results are sorted by `(next_check_at_ms, task_id)`, not by insertion order,
and pages return `incomplete` and the exact next cursor. The cursor makes
continuation more stable than offsets when earlier records are added or
resolved; this is still a changing live view, not a transaction-level snapshot.

## Authorization and accuracy

Private due candidates never reach the model directly. The model-facing adapter
reads the private candidates, then fetches each task **sequentially** using
the connected person's current ClickUp OAuth token and its live home
List/Workspace preflight. Access-denied, removed, or out-of-scope records are
excluded and counted without exposing their IDs or notes. Authentication
failure, rate limit, unexpected schema or transient provider failure aborts
the read rather than silently returning an all-clear.

The adapter re-reads the current private follow-up projection *after* task
authorization and excludes any obligation now resolved or moved to a later
check time. The reported task title, status and assignees come only from the
fresh ClickUp task GET. The report also includes the latest curated action type
and a short note. A note is **not** evidence that a customer has actually
been contacted. Exact action evidence is still checked by the existing
`clickup_record_followup_action` tool for new sent-comment claims.

A page with zero visible results and `incomplete=true` means to continue
rather than treat the queue as empty. Inaccessible records never become
visible because they appear in the actor's own old private ledger.

## Coverage / limits

- This reads only obligations explicitly registered with a due timestamp;
  it is not an automated scan of all ClickUp tasks, native Inbox or reminders.
- Permission checks consume existing individual API quota. The adapter never
  performs concurrent per-task bursts.
- No due result is a durable checkpoint for webhook consumers. For uncertain
  delivery and response scenarios, consult original ClickUp comments/status.
- No background job, timed notification, automated messaging or customer
  contact is enabled by this change.
- For production release, follow the existing manual **staging** and
  **company** GitHub Actions workflows on an exact vetted `main` SHA.
  Repo CI passing alone is not production acceptance.

## Tests / review gates

Real SQLite tests cover due timestamp ties, keyset paging, clearing on
resolution, rescheduling, malformed cursor inputs and due cutoff boundaries.
Catalogue adapter regressions use synthetic ClickUp provider responses to
verify the List-only authorization path, revoked/out-of-scope suppression,
rescheduling during GET, no unchecked provider details, unchanged cursor
continuation and immediate error on a true 429.

Before merging require green Strict CI, green CodeQL and a scoped specialist
review on the exact final head. Before deployment require a signed release
workflow and actual staging OAuth boundary smoke tests.
