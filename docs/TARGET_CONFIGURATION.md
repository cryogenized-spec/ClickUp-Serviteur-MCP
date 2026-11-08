# Choosing a ClickUp target (owner-operated)

This custom MCP uses **ClickUp Lists**, not Board-view IDs. A Board is a visual view of tasks; the List is the destination for `create_scoped_task`, `find_scoped_tasks`, `get_scoped_list` and the attention report. The 48 native ClickUp operations with explicit resource IDs still require their own verified IDs and grants; changing the default List does **not** silently rewrite explicit tool arguments.

## Quick use in ChatGPT or another MCP client

The remote MCP advertises two input tools after deployment and reconnection:

1. **`clickup_preview_target`** — provide `workspace_id` and `list_id`. This performs only ClickUp GETs and returns the exact List name, statuses, whether it differs from your current default, and confirmation that the List's Space appears in the consented Workspace.
2. **`clickup_select_target`** — provide `workspace_id`, `list_id`, the exact `expected_list_name` from the preview, and `confirm: true`. Requires your existing `mcp:write` authorization and Workspace-wide permission. This writes only your encrypted-credential Durable Object's *target setting*, **not any ClickUp task**.
3. Call **`get_scoped_list`** and **`get_clickup_connection_status`** to confirm the active default. The choice remains until you select another List, disconnect, or reconnect ClickUp OAuth. Selecting the original Worker default List automatically clears the per-user override (and `selected_list_is_override` becomes `false`). It is per signed-in person, not shared with other staff.

Example: “Preview List `23456` in my authorized Workspace `555`. If its name matches the preview, switch my default List only after I approve.” **Never copy those example IDs into production**.

The original `CLICKUP_LIST_ID` in the Worker remains a safe fallback. Users without a saved target retain that List.

## Different Workspace / company cutover

A different ClickUp **Workspace cannot be activated** by typing its ID into these tools. That is intentional. Current OAuth credentials, `CLICKUP_WORKSPACE_ID`, staff-to-ClickUp-user mapping, allowed staff, and server-side Workspace scope are validated against one configured Workspace. Arbitrary cross-Workspace switching would break those protections.

Before using a company Workspace, the owner must provision and approve a **separate company MCP Worker/profile** with its own correctly configured Workspace ID, default List ID, individual ClickUp OAuth configuration, and independently isolated credential storage. Reconnect your *own* company-authorized ClickUp account on that profile; verify read-only target/status and permissions before granting writes. Keep the dummy staging Worker, OAuth storage and test fixtures separate. Do **not** change the staging Worker’s Workspace bindings to company values, and do not treat a company List as an allowed target in the sandbox.

No company Workspace IDs, credentials, secrets, Lists or personnel are included in this code change. Company activation requires a separate explicit owner decision and appropriate configuration. A Workspace that is available to the account but not exclusively authorized may require List-only scope instead of Workspace-wide features; never bypass the verified single-Workspace constraint.

## Security boundaries

- All calls use the custom ClickUp Serviteur MCP and the authenticated employee's own ClickUp OAuth token. The first-party ClickUp app is never required.
- Preview proves live List ancestry via ClickUp `GET /list/{id}` and `GET /team/{workspace}/space`, and does not save anything.
- Selection requires an exact List-name readback, explicit affirmative confirmation, and successful Workspace/Space preflight before saving.
- Selections are per GitHub-authenticated subject, scoped to the OAuth-bound Workspace, stored in the existing private Durable Object (no new public HTTP route), and cleared during OAuth reconnection/disconnect.
- A revoked Workspace scope prevents using the selector; no model-supplied token, Workspace or staff identity can expand authority.
- ClickUp task and history changes still require their usual client permission and MCP write scope.

## Why the new tools may not appear immediately in ChatGPT

**Server deployment and ChatGPT tool approval are separate.** After PR #67 shipped, the newest staging runtime already exposed selected-List status from its per-user credential store, but this conversation still loaded the old **58-tool approved snapshot** rather than the **61 tool registrations** from the server's current MCP `tools/list` response. Specifically missing: `clickup_set_workspace_access`, `clickup_preview_target`, `clickup_select_target`. Existing selectors were not broken or absent from source; SDK protocol tests assert the full source list and selection behavior. Do not reimplement the selector through unrelated task-update tools or grant unreviewed Workspace access to circumvent app approval.

On ChatGPT **web**, open **Plugins**, select **ClickUp Serviteur MCP**, choose **Manage / Refresh** (or workspace app **Action control → Refresh** depending on permissions), **enable the newly discovered actions** after reviewing them, and start a **new chat**. Then ask to preview the approved dummy second List, and separately select and restore the home List. OpenAI's custom-MCP guidance explains that tool lists are frozen snapshots and updates do not automatically activate. This refresh is a client/app approval step—not something redeploying this Worker or changing ClickUp tokens can perform. Never uninstall the current plugin just to make tools appear without first reviewing the available refresh control.
