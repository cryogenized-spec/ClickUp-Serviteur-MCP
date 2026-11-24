# High-priority API completion

All six areas from the November API audit have dedicated coverage in this branch:

- Webhooks: inventory, create, update (active/suspended), and delete at the fixed company receiver. Managed signing secrets are encrypted in an actor-specific Durable Object. Delivery remains unverified until a real subscribed event is observed. Company deployment enables the signed receiver, not a subscription. Existing operator registrations remain supported.
- Shared hierarchy: dedicated discovery and Workspace search integration already deployed; normal hierarchy results and direct shares remain separate. Live search for the battery supplier task returned the directly shared task even though the ordinary task collection was empty.
- V3 attachments: task metadata and uploads, File Custom Field metadata and uploads, plus separately confirmed association to an empty applicable field. Keep the stable v2 upload path. Public v3 OpenAPI omits the multipart file-part name and the set-field spec omits the exact File value representation, so multipart/association compatibility needs an approved live fixture. No blind fallback after a possibly successful upload; never overwrite existing field files.
- Native task merging: exact verified source and target preview, confirmation fingerprint, native merge, owner-cleanup policy. Acknowledgement is not proof of completion. Use a disposable approved fixture for live testing.
- List/Folder templates: native inventory and creation from verified template and parent. Asynchronous acknowledgement does not guarantee completed creation.
- Custom Fields: List, Folder, Space, Workspace discovery including task-type applicability, typed value setting and explicitly confirmed clearing with task readback.

The catalogue increases from 100 to 111. Native metadata/read tools should be checked immediately after deployment and client schema refresh. No live merge, upload, field clearing, template creation or subscription has been performed as part of this source change.

Other audit categories (checklist lifecycle, List comments, Views, Space/Folder administration, time tracking/estimates, Goals, Chat administration, groups, access control, Enterprise audit logs, official-MCP-only operators) are not asserted complete by this batch. The three previously restricted operations (move task, add task to extra List, replace document page) retain their existing company policy until separately reviewed.

Official contracts: https://developer.clickup.com/docs/open-api-spec ; https://developer.clickup.com/docs/webhooks ; https://developer.clickup.com/reference/postentityattachment ; https://developer.clickup.com/reference/getparententityattachments ; https://developer.clickup.com/reference/removecustomfieldvalue ; https://developer.clickup.com/reference/mergetasks .
