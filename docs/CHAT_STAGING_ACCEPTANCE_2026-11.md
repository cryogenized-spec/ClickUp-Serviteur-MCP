# Private Chat send: staging acceptance checklist (11 November 2026)

**Issue:** [#120](https://github.com/cryogenized-spec/ClickUp-Serviteur-MCP/issues/120).  
**Scope:** Dedicated staging Worker and disposable ClickUp test account/Workspace only. Do **not** perform the test in company staff DMs.

## Source contract

- Send: `POST /api/v3/workspaces/{workspace_id}/chat/channels/{channel_id}/messages`. Required body: `{ "type": "message", "content": "...", "content_format": "text/plain" }`. ClickUp documents **201 Created** for successful message creation.
- Verification: `GET /api/v3/workspaces/{workspace_id}/chat/channels/{channel_id}` must return the exact requested channel in the approved Workspace **before** POST; `GET .../channels/{channel_id}/messages?limit=...` allows one bounded readback.
- ClickUp documents a **self-DM** from `POST /api/v3/workspaces/{workspace_id}/chat/channels/direct_message` with an **empty `user_ids`** array; use a test account, not an employee recipient.
- The v3 Chat API is [experimental](https://developer.clickup.com/docs/chat). Confirm the current schema again before a live acceptance run.

Official sources: [Create a message](https://developer.clickup.com/reference/createchatmessage), [Retrieve a Channel](https://developer.clickup.com/reference/getchatchannel), [Retrieve Channel messages](https://developer.clickup.com/reference/getchatmessages), [Create a Direct Message](https://developer.clickup.com/reference/createdirectmessagechatchannel).

## Protected operator procedure

1. In GitHub Actions, deploy the reviewed **main** SHA with **Deploy ClickUp Serviteur MCP staging (manual)**; verify its Strict CI and CodeQL were green and the staging environment credentials are present. Never direct staging to company OAuth KV, D1/Durable Objects, or company Worker hostname.
2. Connect an authorized **test account** to the staging MCP endpoint. Call `service_info` and `get_clickup_connection_status`; confirm expected build SHA, Workspace, OAuth identity and read/write grants. A deployment flag alone does not establish connection health.
3. In the disposable **test Workspace**, create or identify the test account's self-DM using ClickUp's documented Direct Message endpoint/UI. Its channel ID remains a private staging fixture. Verify it is the intended self-DM: do not infer membership from a name or reuse an employee's existing DM.
4. Read the verified channel once via the staging MCP. Send **one** innocuous, uniquely labelled plain-text message such as `Serviteur QA — one self-DM delivery verification` with `content_format: text/plain`. Do not include customer, company or employee data.
5. On HTTP 201, require a message identifier and one readback of the **same channel**, checking message ID, content and author. A successful POST alone is **not** complete acceptance.
6. On 400/422, 401/403, 404, 409 or 429, record only safe `endpoint_category`, `http_status` and `write_outcome`. On 5xx, timeout or unparseable acknowledgement, treat delivery as **unknown**; use a bounded readback only. **Never repeat the POST blindly.**
7. Confirm no unexpected notification recipients, leakage or duplicate messages. Keep real channel IDs, OAuth tokens, private text and employee identities out of public logs, GitHub comments and screenshots.
8. Record a sanitized pass/fail in issue #120, including tested source SHA and staging deployment SHA. Do not mark the issue fully resolved if self-DM delivery was not genuinely observed.

## Promotion to company (separate, manual)

Only after the staging checks pass: review the deployment manifest, Cloudflare OAuth hostname and organization-specific variables, then trigger **Deploy ClickUp MCP company (manual, non-destructive read-write)** from reviewed main. Confirm the deployed Worker `service_info.build_sha` equals the GitHub merge SHA, and run read-only connection status checks. Do **not** send a company Chat message as a deployment smoke test.

## What source-only tests prove

Synthetic tests prove request structure, OAuth-bound scope checks, status/error classification, information minimization and no automatic second POST. They do **not** prove that ClickUp permits posting to a particular self-DM on a live Workspace or that the company installation has been deployed.
