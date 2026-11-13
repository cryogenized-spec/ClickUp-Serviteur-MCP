# Chat lifecycle and reaction safety — issue #135 P1 (13 November 2026)

**One MCP:** All named operations remain inside the existing ClickUp Serviteur catalogue and per-user OAuth Workspace security model. Staging is an internal deployment target, not another ChatGPT connector.

P0 [PR #136](https://github.com/cryogenized-spec/ClickUp-Serviteur-MCP/pull/136) added envelope normalization, verified DM opening, member preview and recipient-checked sends. This P1 source slice adds:

- `clickup_create_chat_reply` — POST a message only after a bounded exact parent-channel membership preflight; require documented 201 and message ID and independent reply readback before verified success.
- `clickup_edit_own_chat_message` — PATCH with an explicit exact expected old text, verified signed-in author and subsequent content+author readback.
- `clickup_delete_own_chat_message` — owner cleanup action; explicit `confirm_delete:true`, exact old text, actor identity and complete absence readback. Deletion is never retried on uncertainty.
- `clickup_get_chat_message_reactions`, `clickup_add_chat_reaction`, `clickup_remove_own_chat_reaction` — typed lower-case emoji names, verified parent message and only the caller's own reaction for removal. Bounded reaction reads; duplicate/unknown outcomes fail closed.

The parent message must be found in a verified channel page of up to 50 records. An older page requires a supplied `chat_cursor`. To act on an existing reply, supply `parent_message_id` and, if necessary, `reply_cursor`; the parent is verified before its reply collection can be read. DMs require the explicit `user_ids` (or `self_dm`) and complete actual-member verification. Never infer own authorship from a name or requester-supplied identity.

## Gating and remaining provider validation

Official routes:
- [Create a reply](https://developer.clickup.com/reference/createreplymessage) — POST, 201
- [Edit message](https://developer.clickup.com/reference/patchchatmessage) — PATCH, 200
- [Delete message](https://developer.clickup.com/reference/deletechatmessage) — DELETE, 204
- [Get reactions](https://developer.clickup.com/reference/getchatmessagereactions) — GET with cursor
- [Add reaction](https://developer.clickup.com/reference/createchatreaction) — POST, 201
- [Remove reaction](https://developer.clickup.com/reference/deletechatreaction) — DELETE, 204

**Live acceptance remains pending.** ClickUp Chat v3 is experimental. Source tests use synthetic author, member and reaction shapes; the actual ClickUp provider may return different but legitimate fields. In that case the code intentionally rejects unknown identity instead of guessing. Live tests must use only an isolated disposable self-DM and owner-approved records before enabling for staff. In particular, verifying deletion from a paginated list is only conclusive when the returned page is complete; otherwise the result stays unknown.

No real Chat message or reaction was created/edited/deleted by this source PR. Company has not been deployed. Do not mark issue #135 or #120 resolved until the new tools have completed live acceptance. Public repository issue comments must not contain coworker identities, tokens, private channel or message IDs.
