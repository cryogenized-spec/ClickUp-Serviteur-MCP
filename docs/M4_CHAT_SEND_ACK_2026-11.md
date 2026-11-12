# M4 — ClickUp Chat delivery acknowledgement integrity (12 Nov 2026)

**Scope:** Source-only reliability improvement for the existing unified ClickUp Serviteur MCP, no new connector or ClickUp write. This directly supports [issue #120](https://github.com/cryogenized-spec/ClickUp-Serviteur-MCP/issues/120).

Official ClickUp v3 [Create a Chat message](https://developer.clickup.com/reference/createchatmessage) documents HTTP **201 Created** and the [Chat API](https://developer.clickup.com/docs/chat) remains experimental. Response-shape assumptions must be checked against authorized live readback; source-unit tests alone do not establish delivery.

## Problem

Previously, the generic HTTP adapter treated **any** HTTP 2xx as a successful Chat send provided the JSON body was nonempty. For example, a synthetic HTTP 200/202 response `{"id":"foo"}` could produce a success even though ClickUp documents only 201 for message creation. A response with HTTP 201 but missing or malformed top-level message ID could also be treated as success. Some write-response parse failures lost the useful but non-sensitive HTTP status in model-visible diagnostics.

## Limited correction

- Only exact HTTP **201** can yield a Chat acknowledgement. Any other 2xx is conservatively `CLICKUP_WRITE_OUTCOME_UNKNOWN`, not automatic delivery success. This does **not** mean that the message was definitely rejected or absent.
- On 201, require a nonblank, safely formatted top-level `id` to allow later readback. A missing/malformed ID, invalid JSON, missing JSON content type, body-limit failure or read timeout keeps the **unknown** status. Do **not** POST again when delivery is uncertain.
- Preserve existing preflight channel verification, OAuth Workspace scope, user credential, ClickUp native audit and 4xx/5xx error classification. Do not change other POST/GET response semantics.
- If a Chat POST was issued, its ambiguous acknowledgement now produces sanitized `endpoint_category: "chat_message_send"`, `http_status` when a response was received, and `write_outcome: "unknown"`. Raw response data, private message text, tokens and channel IDs remain excluded.
- Regression fixtures use documented 201 and cover HTTP 200/202/204/205/206; missing/wrong `id`; invalid/mismatched JSON; preflight and no-blind-POST-repeat guarantees.

## Remaining gate

**This is not private Chat delivery acceptance.** The source returns a 201+ID acknowledgement without yet proving the message's author, content and recipient by readback. The independently approved **internal staging self-DM send/readback** in [CHAT_STAGING_ACCEPTANCE_2026-11.md](CHAT_STAGING_ACCEPTANCE_2026-11.md) is required before [#120](https://github.com/cryogenized-spec/ClickUp-Serviteur-MCP/issues/120) can be closed. No staff notification should be sent as a smoke test.

The current company deployment is not modified by a source PR; promotion remains a separate owner-directed manual release after exact-head CI and acceptance gates.
