# ClickUp Webhook Ingestion — Security Design and Release Gates

**Status: security foundation only, NOT deployable.** No public route is wired into `src/index.ts`; no webhook subscriptions are created; no callback URL, credential or secret is committed. `src/clickup/webhook-verification.ts` is intentionally an **unmounted pure module**. A future release must satisfy every gate below before it can become reachable.

## Why this needs a separate architecture

ClickUp's webhook API sends unsolicited HTTPS POST requests, unlike Serviteur's user-initiated, authenticated MCP tools. A public receiver would be a new trust boundary. Successful signature verification only proves that the holder of one webhook secret signed those bytes. It does **not** authorize reading or changing any ClickUp object, establish the event's Workspace/List scope, or authenticate a current Serviteur user.

References:
- https://developer.clickup.com/docs/webhooks
- https://developer.clickup.com/docs/webhooksignature
- https://developer.clickup.com/docs/webhookhealth
- https://developers.cloudflare.com/kv/concepts/how-kv-works/
- https://developers.cloudflare.com/workers/runtime-apis/context/

## Invariants

1. **Opt-in only.** No generic webhook executor and no arbitrary model-supplied endpoint URL. A future dedicated `clickup_subscribe_to_task_changes` tool must require `mcp:write`, exact authorised Workspace/List binding, an allowlist of event names (no wildcard `*` by default), and user confirmation. It must calculate its callback URL from a server-controlled origin, never from prompt text.
2. **Per-subscription secrets.** The secret returned by ClickUp Create Webhook belongs to one registration and one OAuth user. Store it encrypted server-side with the subscription ID, owner generation, Workspace, allowed List and event types. Never return the secret in any MCP result, diagnostic, error, log or GitHub action.
3. **Raw-byte authentication.** Before JSON parsing, verify the exact body bytes using HMAC-SHA256 and the single `X-Signature` hexadecimal header. Reject oversized bodies, malformed signatures and wrong webhook IDs. Never stringify parsed JSON for verification. The unmounted verifier provides this primitive and limits the body to 128 KiB.
4. **Atomic anti-replay.** ClickUp recommends `webhook_id:history_item_id` as an event key. When history IDs are absent, derive a deterministic digest of the exact authenticated body. Claim these keys in **one strongly consistent Durable Object storage transaction** before acknowledging delivery. Reject or safely acknowledge duplicates. Cloudflare KV is eventually consistent and must not be used for the atomic claim.
5. **Re-check current authorization.** The subscribed user may lose ClickUp access, disconnect OAuth, change selected List or be removed from the approved staff allowlist. A consumer must re-resolve the current OAuth credential and Workspace/List grant, then re-fetch the relevant ClickUp object under that credential. An event payload's `task_id`, `list_id`, `before`, `after`, `user` and `history_items` are all untrusted data.
6. **No automatic mutations.** A signed event is not user authorization to update a task, create a comment, notify staff, or issue a model turn. Initially, events may only create bounded internal change notifications explicitly opted into by their owner.
7. **Queue-and-ack.** Make the signature check, subscription check and atomic event claim part of the request. Acknowledge 2xx only after durable persistence or reliable enqueue. Do not depend on a floating promise. For processing exceeding Workers `waitUntil` limits, use a dedicated Cloudflare Queue/consumer with retries and dead-letter handling.
8. **Origin and exposure isolation.** The callback route must be mounted only on a named, isolated production/staging Worker once explicitly enabled. Keep the existing OAuth and MCP endpoints unaffected. Never reuse an MCP bearer token as a webhook secret or allow the webhook route to call MCP operations.
9. **Retention and observability.** Store only the event key, subscription reference, event name, relevant resource ID, processing state and timestamps. Do not log raw event bodies or header signatures. Add a per-subscription quota/circuit-breaker and a clear manual disable path.
10. **Operator-controlled deployment.** The company Worker workflow must remain manual, isolated and gated by mandatory tests, CodeQL and exact-head review. No PR introduces a new secret binding or public route automatically.

## ClickUp delivery caveats

ClickUp has no fixed outbound IP address for these calls; relying on an IP allowlist is insufficient. ClickUp may retry failed requests up to five times and can suspend unhealthy webhooks. A `410` immediately suspends a webhook; a `401` may do so as well. The receiver must respond promptly and must never return success before durable processing. Idempotency and explicit webhook status checks are mandatory.

## Required staged implementation sequence

**Gate 1 (this PR):** pure raw-body HMAC verifier + strict, minimized payload parser + synthetic security tests. No reachable route.

**Gate 2:** add a dedicated encrypted subscription store/Durable Object keyed to an OAuth principal, with transactional replay protection, generation revocation, tests for duplicate parallel deliveries, multi-subscription isolation and persistence failure. No reachable route.

**Gate 3:** mount one disabled-by-default callback handler behind a separate explicit environment feature flag and a fixed server-generated path. Verify a known subscription, signature, event type, payload identity, scope and request budget before parsing; test wrong route, missing config, replay, invalid signature, mixed Workspace, transient failure and no-leak logging.

**Gate 4:** implement **separate, narrowly named** subscription management tools and user-controlled staging registration. Verify the returned ClickUp `webhook.id` and secret in encrypted durable storage, never show either secret or untrusted endpoint in results. Test that a failed registration creates no usable local subscription.

**Gate 5:** implement read-only notifications from a durable Queue after independent ClickUp readback under current user authority; no automatic writes. Exercise the staging endpoint with non-sensitive disposable tasks; validate retries, suspension, revocation, idempotency and backpressure.

**Gate 6:** explicit owner-controlled production activation only after all security gates pass and an approved rollback plan exists.

## Current non-goals

- No live webhook subscriptions, exposed callback, Cloudflare Queue, Durable Object migration, OAuth changes, or background monitoring.
- No generic `clickup_execute_operator`, dynamic operation catalogue, or API-token arguments.
- No claims that unit tests or staging tests prove a production webhook integration.

## Security test sign-off

Before a receiver is reachable, independently verify at minimum: unaltered raw HMAC, altered body/signature rejection, per-subscription secret mismatch, forged webhook ID, duplicate delivery across concurrent Workers, changed List membership, revoked user OAuth, expired subscription, unknown event name, missing durable store, timeouts, 429, invalid content type, oversized body, and no plaintext secrets in telemetry or MCP tool outputs.
