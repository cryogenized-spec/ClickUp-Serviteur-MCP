# Native API expansion

The first implementation batch adds nine catalogue operations covering shared resource discovery, task attachment metadata, List/Folder templates, native task merging, and webhook inventory.

## API contract

- Shared resources: GET /api/v2/team/{team_id}/shared. Direct shares are discovery evidence, not new permission grants. Existing task-level verification remains in place.
- Attachments: GET /api/v3/workspaces/{workspace_id}/attachments/{task_id}/attachments. Use the data array and next_cursor. No signed URLs in metadata. V3 multipart uploads and file-type Custom Field attachments remain a follow-up.
- Templates: GET /api/v2/team/{team_id}/list_template and folder_template; POST to the documented Space or Folder template route. Creation uses return_immediately and reports acknowledgement separately from completion.
- Merge: POST /api/v2/task/{task_id}/merge with source_task_ids. Preview verifies each task and binds the exact target, source IDs, List IDs, observed update times and actor to a fingerprint. Explicit confirmation required; company execution uses the existing owner cleanup grant. Do not retry an uncertain merge.
- Webhooks: GET /api/v2/team/{team_id}/webhook. Inventory omits signing secrets and destinations. Raw-body HMAC-SHA256 verification helper is implemented and tested synthetically. No subscription creation, public receiver, event persistence or automatic processing has been enabled. These require protected per-subscription secret storage and idempotent processing keyed by webhook ID and history item ID.

## References

- https://developer.clickup.com/reference/sharedhierarchy
- https://developer.clickup.com/reference/getparententityattachments
- https://developer.clickup.com/reference/getlisttemplates
- https://developer.clickup.com/reference/getfoldertemplates
- https://developer.clickup.com/reference/mergetasks
- https://developer.clickup.com/docs/webhooks
- https://developer.clickup.com/docs/webhooksignature

## Acceptance

Require Strict CI and CodeQL. After review and deployment, exercise live read tools before controlled write acceptance. Template creation, merge and webhook subscriptions must use explicitly approved disposable fixtures or real user-approved targets; do not claim completion from an acknowledgement alone. No company task merges or webhook registrations are part of this source change.
