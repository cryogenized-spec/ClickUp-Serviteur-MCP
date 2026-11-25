# ClickUp v3 task and Files field attachments — 25 November 2026

## Scope

Implement the documented v3 REST path `/api/v3/workspaces/{workspace_id}/{entity_type}/{entity_id}/attachments` for `attachments` (tasks) and `custom_fields` (Files fields). Keep the existing v2 multipart uploader intact for older clients.

New model-facing capabilities:
- `clickup_upload_task_attachment` and `clickup_upload_file_field_attachment` accept caller-supplied Base64 payloads up to 500 KiB; both require a preflight of the authorized task, home List and, when applicable, Files field.
- `clickup_get_task_attachments` uses the documented v3 path, but ClickUp returned HTTP 404 for a real company task with a visible v2 attachment; on exact v3 404 only, bounded task metadata is returned as an explicitly incomplete, unpaginated fallback.
- `clickup_upload_task_attachment` first attempts the documented v3 multipart endpoint. If and only if ClickUp definitively rejects that upload with HTTP 404, it performs one compatible v2 task attachment POST and explicitly labels a successful result as `clickup-api-v2-task-fallback`. A 400 storage error, 429, timeout, or ambiguous 5xx is never used as permission to retry a write. Files Custom Field uploads cannot use this fallback.
- `clickup_get_file_field_attachments` returns only task-associated file metadata or an explicitly requested **provenance-verified pending upload**; a caller-supplied exact ID by itself is never authority to view metadata in a shared field.
- `clickup_associate_file_field_attachment` requires a fresh owner-/OAuth-generation-/task-/field-bound upload record, an exact attachment ID, explicit owner confirmation, an empty task field, an **atomic one-time durable claim**, last-moment task preflight, and post-write readback. An unknown or replayed ID cannot be associated. A claim is permanently consumed, even if the upstream result is ambiguous; this conservative endpoint supports one association attempt per task/field, rather than offering an unsafe overwrite or blind retry.
- `clickup_upload_chatgpt_file_v3` declares the ChatGPT `openai/fileParams` slot for PDF, image and safe text bytes, with optional `field_id`. It retrieves only a bounded, signed OpenAI-hosted source and never forwards ClickUp credentials. Files field uploads still require a separate association call.


## ChatGPT file-slot compatibility investigation (25 November 2026)

A live `openai/fileParams` upload with an actual ChatGPT image returned `CLICKUP_FILE_HOST_NOT_ALLOWED` **before** any ClickUp POST. Both file-ID and sandbox-path invocation forms resolved to the same rejection. The host's actual delivery hostname was not available in the sanitized prior error; do not guess or allow arbitrary URLs. The next release returns only `file_source_host` on that exact validation error, with no signed URL, path, query or credential, and accepts explicit additional OpenAI-owned origins (`api.openai.com` / `files.openai.com`). The DNS boundary remains strict and redirects are denied. Verify the host from one read-only/failed-before-write file-slot invocation after deployment; add a new origin only after confirming ownership and rerun the security tests.

ChatGPT can preserve a camera `.jpg` name while passing WebP-encoded bytes. The file-slot loader now renames the filename extension to match the detected safe file signature instead of rejecting that mismatch. An actual MIME-type mismatch remains an error. These fixes do not bypass ClickUp workspace storage: the live v2 task upload returned `CLICKUP_ATTACHMENT_HTTP_400_GBUSED_005` on the Free Forever Workspace.

## Security and failure behavior

The existing per-user OAuth, company Workspace scope, original task home-List restrictions, data size/MIME checks, quota reservation, no-arbitrary-URL and no-redirect rules stay in effect. A successful POST requires an authoritative attachment ID, and a failed readback never authorizes a duplicate upload retry. No file contents, bearer tokens or signed URLs are written into source, tests or logs. A v3 File field may be shared with multiple tasks, so only a task-associated ID or an exact requested upload ID may be returned.

## Post-Codex P1 remediation design

Codex's completed PR review (25 November, original head `2b11923`) found three P1 issues: shared Files-field attachment ID provenance, overlapping association writes, and company List-scoped file reads. The remediation uses the **already deployed `CLICKUP_QUOTA` Durable Object class** with separate SQLite-backed object instances named by authorized Workspace/task/field. A successful v3 Files-field upload records the subject, ClickUp user ID, OAuth credential generation, returned attachment ID and a 15-minute expiry. Verification and association query this internal ledger; model-provided IDs alone cannot register ownership.

Claiming an association performs a synchronous SQLite transaction and irreversibly marks the field claimed, so concurrent requests from different principals/Worker instances cannot both submit through this MCP. Follow-up attempts fail closed; an upstream failure or expired ownership record does not release the claim. The existing task and Files-field authorization checks remain in place, and the verified file-read operation is allowed in company List mode. The helper uses the existing Durable Object binding; no public route or new secret is introduced.

**Limitation:** The ClickUp Set Custom Field API does not document a compare-and-swap conditional update. The last-moment field read minimizes but **cannot eliminate an external edit race** from ClickUp UI or another integration. This implementation serializes *Serviteur* requests, not all ClickUp writers. Keep association use restricted to explicitly approved, otherwise idle test fields; do not advertise an unconditional upstream no-overwrite guarantee. Do not merge until the revised SHA passes mechanical CI and fresh security review.

## Observed environment and acceptance limits

On 25 November the live company `clickup_get_task_attachments` returned `CLICKUP_UPSTREAM_UNAVAILABLE` with HTTP 404 for a known authorized task. The company Workspace plan API returned **Free Forever**. Earlier company upload attempts reported `GBUSED_005` (storage exhausted); the new API cannot bypass upstream storage policy. On 25 November, both a v3 task attachment POST and a v3 attachment GET returned 404 for a task that v2 could read. A separate v2 upload on that same task reached ClickUp and returned `GBUSED_005`, demonstrating that 404 and the storage exhaustion error are different upstream behaviors. The exact reason for v3 404 is not independently established; the fallback is limited to task attachment upload only. Images uploaded directly into ClickUp comments are also task attachments, according to ClickUp's Help Center. Externally hosted links in comments avoid uploading file bytes into ClickUp. See https://help.clickup.com/hc/en-us/articles/6309666546199-Add-attachments-to-tasks and https://help.clickup.com/hc/en-us/articles/33463620625559-Workspace-storage-limits.

Source-level synthetic tests must pass, then manually deploy the exact reviewed `main` SHA through the protected company workflow and refresh ChatGPT connector schemas. Positive live upload acceptance requires a user-supplied, non-sensitive file, an expressly approved disposable task, and enough upstream ClickUp storage. If storage remains full, return the precise error and use a separately approved existing Google Drive link workflow rather than claiming the file was attached.

## References

- https://developer.clickup.com/reference/postentityattachment
- https://developer.clickup.com/reference/getparententityattachments
- https://developer.clickup.com/reference/setcustomfieldvalue
- https://developer.clickup.com/docs/attachments
