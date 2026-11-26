# Automatic observation of confirmed own task comments — candidate (26 November 2026)

## Purpose / scope

This stage extends the persistent private actor+Workspace follow-up ledger merged
in PRs #170–#174. It observes **only an actual, successfully posted ClickUp
task comment whose exact ID and author were subsequently verified through the
connected user's own live OAuth token**. Unlike an internal draft, this is a
verified provider write. It is NOT evidence of notification delivery, customer
contact, reply, staff compliance, or completed work.

This stage modifies neither the destination comment nor any ClickUp task. It
does not alter webhooks, subscriptions, email, reminders, or global event
acknowledgements. Only the existing private SQLite Durable Object is written.

## Supported observations

- Top-level **plain unassigned** task comments: after an existing successful
  native POST, perform one fresh GET of task comments. Verify exact provider
  comment ID, connected-author user ID and original text before attempting
  private observation.
- Top-level **plain assigned** comments: use the current verified assignment
  readback and additionally validate the exact connected author ID.
- **Rich / genuine-mention** top-level comments: reuse the existing robust
  ID, author, structure and assignment readback; rich format that is only
  structurally verifiable is not misrepresented as full mention-identity proof.

Threaded replies and uncertain/timeout/provider-inconclusive writes are not
automatically recorded in this increment. Their original behavior remains.

## Internal record

The actor-local follow-up action kind `verified_comment_posted` requires a
concrete comment ID, just as `instruction_sent` does. Public manual claims of
this kind still independently verify original ClickUp authorship.

The automatic key `verified-comment:<comment_id>` is stable and idempotent.
The private observation first checks for an existing receipt, then reads the
current actor-local follow-up projection and transactionally appends the
observation. If the prior state is `awaiting_response`, `resolved`, or any
other supported state, it remains unchanged; the existing waiting-on member
and next-check date are preserved. With no prior obligation, the neutral
state is `verified`; **no due date or person is invented**.

The tool's successful original ClickUp POST is **never undone, hidden,
replayed or retried** because of a private ledger error. Instead the existing
tool result includes `followup_observation`, with a narrow `recorded`
boolean and an optional bounded reason (e.g. `private_storage_failed` or
`clickup_readback_unverified`). A failed private observation can be
reconciled separately using the exact provider comment ID.

## Acceptance

- Confirm a plain own comment creates exactly one provider POST and one
  persisted private observation only after live author/text readback.
- A forged/foreign author, uncertain readback or invalid ID must never
  produce a verified-sent ledger action.
- Existing obligation states and next-check dates remain intact; no
  false `awaiting_response`, `resolved`, or customer-delivery claims.
- Private storage outage or optimistic revision conflict cannot cause a
  duplicate original comment.
- Historical observations are readable by the same authorized actor using
  existing ledger reads, and replay by action key is idempotent.

## Boundaries / outstanding

No automatic inference from arbitrary ClickUp comments and no full retrospective
backfill. No native Inbox equivalence, no scheduled reminders, no simultaneous
multi-staff shared ledger. The company and staging Workers are independently
deployed through their **manual** GitHub workflows; merged source is not
production verification. Actual OAuth provider acceptance and live readbacks
remain release gates after the exact merged source passes CI and review.
