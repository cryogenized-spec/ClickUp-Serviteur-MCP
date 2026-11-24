# Comprehensive API coverage expansion

The proposed catalogue grows from 100 to 132 model-facing operations. It is not a claim that all ClickUp REST endpoints or plan-dependent features are live-tested.

## Scope of this batch

- Workspace, Space and Folder Custom Field definitions; confirmed removal of one task field value.
- Checklist rename, reorder, and verified checklist/item deletion.
- List comment creation; Space details; nested Folder creation and relocation.
- Singular time entry and history, tags, and signed-in user's own stopped entry editing and deletion.
- User Group and Chat follower discovery; standalone Chat channel creation with explicit visibility.
- Saved view details, duplicate, rename and deletion, retaining verified hierarchy ancestry.
- Goal renaming and numeric Key Result progress update.
- Workspace plan and seat diagnostics.
- Managed webhook subscription creation, event-selection update and deletion. Fixed configured HTTPS destination; signing secrets stored encrypted in a separate internal Workspace registry. An acknowledged upstream creation is not proof of delivery. Existing operator-configured registrations remain supported; this batch does not automatically register a production subscription.

## Upstream references checked

- https://developer.clickup.com/reference/createwebhook
- https://developer.clickup.com/reference/updatewebhook
- https://developer.clickup.com/reference/deletewebhook
- https://developer.clickup.com/reference/getteamavailablefields
- https://developer.clickup.com/reference/getspaceavailablefields
- https://developer.clickup.com/reference/getfolderavailablefields
- https://developer.clickup.com/reference/createfolder
- https://developer.clickup.com/reference/movefolder
- https://developer.clickup.com/reference/createchatchannel
- https://developer.clickup.com/reference/getchatchannelfollowers
- https://developer.clickup.com/reference/getteams1
- https://developer.clickup.com/docs/views
- https://developer.clickup.com/reference/updateview
- https://developer.clickup.com/reference/updateatimeentry
- https://developer.clickup.com/reference/deleteatimeentry
- https://developer.clickup.com/reference/getworkspaceplan
- https://developer.clickup.com/reference/getworkspaceseats

## Explicitly unresolved

The v3 upload reference documents multipart and filename but not the binary form field, and the Files Custom Field value association payload is not fully specified in the public Custom Fields guide. Preserve the already working v2 upload and v3 metadata read; do not claim a working v3 upload until the exact multipart and field-value contracts can be verified on an approved test task. See https://developer.clickup.com/reference/postentityattachment and https://developer.clickup.com/docs/customfields.

The general ACL endpoint changes privacy/access and can incur seat charges. Administrative ACL/guest/role changes and Enterprise audit log generation are not enabled in this batch. They require typed contracts, role and recipient validation, explicit approval and plan verification. General view-filter editing, arbitrary view creation without a verified template, Goal creation/deletion and advanced timer tags remain separate work. Do not imply that every public API operation has been implemented.

Automated tests use synthetic fixtures, not live company objects. Production deployment and live tests remain separate.
