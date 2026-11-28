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
5. The next alarm queries unprocessed exact event identifiers using the private
   `backend-attention` receipts as its authority. The compound high-water mark
   is retained for inspection, but never used alone to suppress an event;
   late same-millisecond deliveries are therefore still processed. No new
   movement -> no new checkpoint revision. Duplicate deliveries -> no revision.
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

## Delivery-aware extension (28 November clarification)

**User requirement:** The fully autonomous backend must not mistake a ClickUp
GET, an agent tool result, or a completed scheduled-automation run for proof
that the user-facing briefing actually reached its recipient.

A distinct SQLite `attention_delivery_outbox` now retains immutable alert
revisions and the exact event IDs behind each alert. During the same SQL
transaction that advances a successfully verified backend processing
checkpoint, an actionable attention change also creates a **pending**
delivery record. A repeated webhook/alarm cannot duplicate the alert.
Subsequent irrelevant processing cannot erase an earlier undelivered item.

A server-owned delivery-adapter method supports recording an exact published
message ID with the publication timestamp, independently for each alert.
Its receipt method is deliberately **not exposed** as a model tool, public
HTTP route or generic write RPC; neither retrieval nor ChatGPT tool usage
can call it or silently move the delivery checkpoint. A read-only
`clickup_get_automatic_attention_state` response reports pending count
and the most recent confirmed delivery (if any).

**Critical limitation:** ChatGPT's existing scheduled-task integration
currently exposes `delivery_status: unknown` and no platform-authenticated
publication callback accessible to this Worker. Therefore there is **no**
trusted ChatGPT notifier wired to this method yet, and the delivery
checkpoint will remain unconfirmed for ChatGPT output. This is deliberate:
marking items delivered after an MCP read or after the assistant drafts
its response would incorrectly suppress messages never published.

The full no-human/no-model-intervention requirement needs one of these
external capabilities before it can be claimed operational:

1. A native ChatGPT host callback, authenticated and tied to the actual
   published message and the precise alert IDs included; or
2. An alternative, explicitly authorised server-owned delivery channel with
   its own confirmed publish receipt.

Implementing a callback based on `automation completed`, or asking an AI
model to acknowledge before producing its final response, is **not** an
equivalent solution. Even OpenAI Agents API invocation delivery status
identifies a notification accepted by an agent session, not a finished
user-visible answer.

The pending outbox is the correct fail-safe while such a channel is absent.
It must not be reported as a fully integrated ChatGPT delivery receipt.

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
