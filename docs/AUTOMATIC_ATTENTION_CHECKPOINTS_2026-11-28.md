# Autonomous attention-state checkpoints (28 November 2026)

## Purpose

Keep **backend processing checkpoints** for ClickUp activity current without ChatGPT,
a scheduled prompt, or an explicit user tool call. This is an incremental extension
of the existing signed webhook ingress, actor/Workspace SQLite Durable Object,
and optional `CLICKUP_INDEX_AUTOSYNC_ENABLED=true` alarm-driven task index.

The change does **not** pretend that processing an event means the user read a
notification. Reporting/delivery acknowledgement remains a separate concern.

## Server-side flow

1. Existing signed webhook ingress durably persists a deduplicated event hint and
   invalidates the corresponding indexed task/comment section.
2. The existing Durable Object alarm wakes independently of the MCP client,
   re-derives the actual ClickUp OAuth grant from the registered webhook owner,
   and refreshes task/comments with current ClickUp permissions.
3. Only after the relevant indexed sections are complete and not stale does the
   alarm atomically update the `automatic_attention` table and record independent
   `backend-attention` consumer receipts.
4. The checkpoint contains the task ID, last accepted event receipt time and key,
   sync time, source task revision, owner classification, whether the latest
   processed batch warrants the user's attention, and a monotonic revision.
5. The next alarm compares event identities against the persisted compound
   high-water mark. No new movement -> no new checkpoint revision. Duplicate
   webhook deliveries -> no new revision.
6. A webhook arriving during an upstream read invalidates the task's dirty
   generation. The alarm must not advance the attention checkpoint for the
   stale generation; an independent alarm processes the new one.
7. The read-only `clickup_get_automatic_attention_state` MCP tool **only reads**
   this state, and first re-verifies that the requesting user can currently
   access that exact task. It does not advance a checkpoint.

## Delegation and routing

A task not assigned to the current ClickUp OAuth user and explicitly waiting
on a different colleague in the private follow-up ledger is classified
`delegated`. Routine external changes to that task are recorded without
automatically assigning an action to the original technician.

An individual structured @mention or verified new assignment can set
`needs_attention=true`, even on a previously delegated case.
Other owned external changes produce an attention candidate. The backend does
not infer intent from free-form comments or declare a customer issue resolved.

## Important boundaries

- This is system-maintained **processing state**, not a definitive read/unread
  state. The existing general attention report and independent
  `afternoon-briefing` consumer remain distinct. No claim of confirmed
  notification delivery is made, and this patch alone does not deduplicate
  user-facing report delivery.
- Only *new* signed events are considered for the checkpoint; existing legacy
  events and tasks not yet indexed are not silently presumed processed.
- A missing or incomplete comment refresh, network error, OAuth revocation,
  stale task snapshot or ClickUp rate limit must not be treated as success.
- Webhook retention is bounded to seven days / 5,000 hints in each partition.
  A high-water mark does not replace independent periodic reconciliation.
- Access is scoped to the configured actor/Workspace Durable Object and the
  individual's freshly authorised ClickUp task read; nothing changes ClickUp.
- In production, autosync must already be deployed and explicitly enabled
  with `CLICKUP_INDEX_AUTOSYNC_ENABLED=true`. A source-code merge does not
  prove the runtime flag is enabled.

## Acceptance and deployment

Run `npm run format:check`, `npm run lint`, `npm run typecheck`,
`npm test`, and `npm run build` against the final exact commit.
Validate same-millisecond events, duplicate ingress, delegations, actual
reassignments, failed or partial sync, and isolation from other event consumers.
Review in a PR and deploy through the repository's existing controlled Worker
deployment. Confirm live state with a freshly authorized
`clickup_get_automatic_attention_state` read after a signed webhook change.
