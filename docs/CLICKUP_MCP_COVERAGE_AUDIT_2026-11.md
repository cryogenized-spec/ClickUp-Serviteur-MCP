# ClickUp MCP coverage audit — 11 November 2026

**Scope:** Serviteur previously exposed **66 individually named REST-backed operations** plus **14 gateway/scoped MCP helpers**. This PR adds five read-only operations, yielding **71 REST-backed operations / 85 registered MCP tools**. Source presence does not prove every tool is available on every deployment, plan or OAuth scope.

**Comparison source:** [ClickUp MCP Pro's Glama listing](https://glama.ai/mcp/servers/helbertparanhos/clickup-mcp-pro) advertises 161 typed tools across 23 domains plus the `clickup_raw` tool. Its [published configuration](https://glama.ai/mcp/servers/helbertparanhos/clickup-mcp-pro/schema) documents an API token, optional read-only mode and the option to disable raw execution. Those are vendor claims, not independent performance or security measurements.

## What unrestricted API execution means

The competitor's `clickup_raw` can select a ClickUp method and API path even when no named tool wraps that endpoint. This improves coverage but expands model-controlled request parameters. It does not inherently bypass ClickUp's own access controls; the competitor offers a read-only mode. Serviteur deliberately does not expose a generic method/path executor and instead enforces per-user OAuth identity, Workspace/List scope and individually named actions.

## API coverage gaps and priorities

| Area | Existing Serviteur coverage | Competitor breadth and opportunity | Priority |
|---|---|---|---|
| Tasks and assignment | Task CRUD, bulk, filters, assigned tasks, attention summary | Explicit task members, duplication and additional metadata | **This PR** members |
| Custom Fields | Set one field; List metadata may include fields | Standalone List field IDs, options and applicable custom task types | **This PR** |
| Comments | Task comments, native mentions, replies, editing/resolution | Read List-level discussions; further writes need approval | **This PR** |
| List membership | Workspace member resolver | Explicit List membership; inherited access is outside API response | **This PR** |
| Tags | Add/remove existing task tag | Discover exact Space tag names | **This PR** |
| Views / hierarchy | Saved View reads, List/Folder creation and updates | More View management and Space metadata | P1 |
| Goals / key results | None | Get Goals and key results before introducing writes | P1 |
| Chat v3 | Channel list, messages, replies, send | Members/followers, reactions, tagged users; v3 experimental | P1 |
| Sprints and time | Time entry reads/writes and time-in-status | Active sprint and Sprint reporting | P1 |
| Docs v3 | Document creation, page content, page editing | Page attachments and richer formatting | P2 |
| Guests and groups | Member lookup only | Enterprise/paid-seat implications; high-impact access changes | Defer |
| Webhooks | Signed verifier not mounted; separate security design | Subscription state and real delivery require additional security gates | Defer |
| Generic raw API | Deliberately omitted | `clickup_raw` method/path option | Do not add |

**Counts are not one-to-one.** A typed tool may orchestrate multiple REST requests, and a general executor may expose numerous endpoints through one tool. Do not subtract 71 from 161 to infer exactly 90 missing features.

## Five read-only additions

1. `clickup_get_list_custom_fields`: authorized `/api/v2/list/{list_id}/field` metadata, defaulting to `include_applied_objects=true`, with field IDs/options and accurate truncation flags.
2. `clickup_get_list_members`: authorized `/api/v2/list/{list_id}/member`, explicitly **direct-access only**; excludes inherited Team, Space and Folder access.
3. `clickup_get_task_members`: authorized `/api/v2/task/{task_id}/member`, task-home-List preflight; excludes inherited Team, Space, Folder and List access.
4. `clickup_get_list_comments`: authorized `/api/v2/list/{list_id}/comment`, newest first, paired `start` / `start_id` continuation, distinct from task comments.
5. `clickup_get_space_tags`: `/api/v2/space/{space_id}/tag` only after verifying Space ancestry in the OAuth Workspace; requires Workspace-level access.

All five reuse existing OAuth credentials, ClickUp transport, scope checks, response clipping and provider-triggered 429 cooldown. **No added artificial per-minute quota, general execution interface, new credential scope or live writes.**

## Future choices

**P1:** Read Chat channel members and followers, Goals, active Sprint and current signed-in ClickUp user timezone where supported. Prefer real workplace needs over maximizing the headline tool count.

**P2:** Edit/create Views and post List comments only after dedicated permission checks, explicit approval and mutation tests.

**Defer:** Enterprise guest/group administration with billing implications; registering webhooks before durable atomic replay protection; unrestricted raw endpoint execution.

## Official endpoint sources and qualification

- [Get List Custom Fields](https://developer.clickup.com/reference/getaccessiblecustomfields)
- [Get List Members](https://developer.clickup.com/reference/getlistmembers)
- [Get Task Members](https://developer.clickup.com/reference/gettaskmembers)
- [Get List Comments](https://developer.clickup.com/reference/getlistcomments)
- [Get Space Tags](https://developer.clickup.com/reference/getspacetags)

List/task membership endpoints exclude inherited permissions, so absence in the output does not prove a person has no access. Tests use synthetic upstream API fixtures and are **not** live ClickUp Workspace integration tests. Actual tool exposure continues to depend on OAuth, server resource-scope policy and plan availability.
