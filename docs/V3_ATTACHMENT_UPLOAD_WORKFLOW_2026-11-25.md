# ClickUp v3 task and Files field attachments — 25 November 2026

## Scope

Implement the documented v3 REST path `/api/v3/workspaces/{workspace_id}/{entity_type}/{entity_id}/attachments` for `attachments` (tasks) and `custom_fields` (Files fields). Keep the existing v2 multipart uploader intact for older clients.

New model-facing capabilities:
- `clickup_upload_task_attachment` and `clickup_upload_file_field_attachment` accept caller-supplied Base64 payloads up to 500 KiB; both require a preflight of the authorized task, home List and, when applicable, Files field.
- `clickup_get_task_attachments` uses the documented v3 path, but ClickUp returned HTTP 404 for a real company task with a visible v2 attachment; on exact v3 404 only, bounded task metadata is returned as an explicitly incomplete, unpaginated fallback.
- `clickup_get_file_field_attachments` returns only task-associated file metadata or an explicitly requested uploaded ID; no broad enumeration of files shared by other tasks.
- `clickup_associate_file_field_attachment` requires an exact uploaded ID, explicit owner confirmation, an empty task field, and a post-write task readback. It does not implicitly replace existing files.
- `clickup_upload_chatgpt_file_v3` declares the ChatGPT `openai/fileParams` slot for PDF, image and safe text bytes, with optional `field_id`. It retrieves only a bounded, signed OpenAI-hosted source and never forwards ClickUp credentials. Files field uploads still require a separate association call.

## Security and failure behavior

The existing per-user OAuth, company Workspace scope, original task home-List restrictions, data size/MIME checks, quota reservation, no-arbitrary-URL and no-redirect rules stay in effect. A successful POST requires an authoritative attachment ID, and a failed readback never authorizes a duplicate upload retry. No file contents, bearer tokens or signed URLs are written into source, tests or logs. A v3 File field may be shared with multiple tasks, so only a task-associated ID or an exact requested upload ID may be returned.

## Observed environment and acceptance limits

On 25 November the live company `clickup_get_task_attachments` returned `CLICKUP_UPSTREAM_UNAVAILABLE` with HTTP 404 for a known authorized task. The company Workspace plan API returned **Free Forever**. Earlier company upload attempts reported `GBUSED_005` (storage exhausted); the new API cannot bypass upstream storage policy.

Source-level synthetic tests must pass, then manually deploy the exact reviewed `main` SHA through the protected company workflow and refresh ChatGPT connector schemas. Positive live upload acceptance requires a user-supplied, non-sensitive file, an expressly approved disposable task, and enough upstream ClickUp storage. If storage remains full, return the precise error and use a separately approved existing Google Drive link workflow rather than claiming the file was attached.

## References

- https://developer.clickup.com/reference/postentityattachment
- https://developer.clickup.com/reference/getparententityattachments
- https://developer.clickup.com/reference/setcustomfieldvalue
- https://developer.clickup.com/docs/attachments
