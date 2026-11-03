# Custom NeonSales MCP — 3 November 2026 SAST live audit and merge reconciliation

## Verified boundaries

Only the connected **NeonSales ClickUp MCP** was used for real ClickUp queries. No first-party ClickUp connector, company Workspace, credentials in source, production writes, or secrets were involved. Live identity reports `connected:true`, `workspace_exclusive:true`, `workspace_scope_approved:true`, `workspace_scope_enabled:true`, `mcp_read_scope_granted:true`, `mcp_write_scope_granted:true` for the separately approved dummy Workspace `9012707978`; scoped List `901219425894` is **Workshop Action Register**. The presence of `mcp_write_scope_granted:true` does **not** authorize unreviewed writes.

## Real read-only tests in this session

| Tool / path | Observed result | Confidence and limits |
|---|---|---|
| `service_info`, `get_clickup_connection_status`, `get_scoped_list` | Actual flags, OAuth status and authorized List returned | Connection and permissions, not proof all tools work |
| `clickup_get_workspace_hierarchy`, `clickup_get_workspace_members` | Bounded real structures/members | PASS for the authorized dummy Workspace |
| `clickup_get_list`, `clickup_get_folder` | Real metadata and status/Folder data | PASS read route |
| `find_scoped_tasks`, `get_scoped_task`, `clickup_get_task` | Actual authorized task records, bounded readback | PASS read route; no mutation |
| `get_attention_report`, `clickup_search_workspace` | Real computed report and matching dummy task results | PASS for limited query case |
| `clickup_search_tasks_by_type`, `clickup_search_tasks_by_tag` | Bounded type matches and honest empty result for nonexistent tag | PASS limited/empty case; type query correctly marked incomplete when capped |
| `clickup_get_task_comments` | Nonempty comments on an existing disposable task | PASS read route |
| `clickup_get_task_time_entries`, `clickup_get_time_entries_for_tasks` | Nonempty real time entries | PASS read route |
| `clickup_get_current_time_entry` | Honest `data:null` | Empty-result pass, not proof timer write |
| `clickup_get_chat_channels` | Real channels returned | Read route only, NOT authorization to post |
| `clickup_find_member_by_name` | Identity match resolution returned | PASS in unambiguous observed case |
| `clickup_tool_catalog` | Mixed capability metadata returned | Read-only metadata, not tool execution |
| `clickup_get_workspace_hierarchy` with wrong Workspace | `CLICKUP_SCOPE_OR_SCHEMA_REJECTED` | Negative authorization PASS |
| `clickup_get_list` for foreign List | `CLICKUP_UPSTREAM_DENIED` | Negative access denial PASS |
| `clickup_get_task_time_in_status` | `CLICKUP_UPSTREAM_DENIED` | **UNAVAILABLE**, plan/ClickApp-dependent |
| `clickup_get_list_time_in_status` | `CLICKUP_STATUS_TIME_DATA_UNAVAILABLE` | **UNAVAILABLE**, plan/ClickApp-dependent |

The live reads used server-held individual OAuth and never changed task data. This table is **not 48/48 live certification**; some effects are unavailable on the current ClickUp plan or require verified disposable fixtures. More detailed earlier permitted write/readback evidence is recorded in [issue #65](https://github.com/cryogenized-spec/NeonSales-ClickUp-MCP-/issues/65) and the [2 November historical smoke report](MCP_LIVE_SMOKE_2026-11-02.md).

## GitHub reconciled

- Merged: [#28](https://github.com/cryogenized-spec/NeonSales-ClickUp-MCP-/pull/28) (`@eslint/js 10.0.1`), [#29](https://github.com/cryogenized-spec/NeonSales-ClickUp-MCP-/pull/29) (`eslint 10.14.0`), and [#51](https://github.com/cryogenized-spec/NeonSales-ClickUp-MCP-/pull/51) (historical smoke evidence clearly marked as old).
- Closed **without merge**: [#37](https://github.com/cryogenized-spec/NeonSales-ClickUp-MCP-/pull/37) (conflicting older audit), [#30](https://github.com/cryogenized-spec/NeonSales-ClickUp-MCP-/pull/30) (TypeScript 7 peer conflict), [#26](https://github.com/cryogenized-spec/NeonSales-ClickUp-MCP-/pull/26) (Wrangler/workers-types peer conflict). Track compatible upgrades in [issue #69](https://github.com/cryogenized-spec/NeonSales-ClickUp-MCP-/issues/69); do not `npm --force`.
- Verified the merged `main` baseline `fe0c8c8422cafa5dfb6539c8eda6cca1a9944584` passed [Strict CI](https://github.com/cryogenized-spec/NeonSales-ClickUp-MCP-/actions/runs/41613957871) and [CodeQL](https://github.com/cryogenized-spec/NeonSales-ClickUp-MCP-/actions/runs/41613957627). Any subsequent documentation commits require fresh CI before final acceptance.
- As of this audit checkpoint, GitHub reported **zero open PRs**. This report is a new reviewable documentation change, not a source-code fix or staging deployment.

## Deployment discrepancy — release gate

The latest merged target-selector code is `619728771d899dfb3cdc6982ac5f0902c0f01613` (PR #67); staging last successfully deployed older SHA `6a997edcffb31f08e0d7ee7ae056d0982b267d1e` (workflow run `41530699184`). In ChatGPT the connected MCP still advertises 58 tools and lacks the new `clickup_preview_target` / `clickup_select_target`, despite those names being registered in source. The older `clickup_set_workspace_access` tool is also missing from client discovery. Treat expected count **61 source registrations** versus **58 visible** as a deployment/client-discovery mismatch, not an invisible success.

**Must do:** owner manually deploys reviewed `main` through the protected staging GitHub Actions workflow, reconnects/refreshes the same custom MCP client, verifies tool-list parity and OAuth/List fields, and performs explicit dummy-only read preview and authorized switch-and-restore. Do not change the company ClickUp target or weaken workspace isolation. This session did not trigger protected deployment, did not install anything on the owner's laptop and did not perform a live ClickUp mutation.

## Still unverified

Positive end-to-end test cases for valid Custom Field writes (there is no eligible field on the current dummy List), user-supplied binary attachment upload, populated threaded replies, optional ClickUp plan features, many consequential create/update/delete and native activity/attribution cases, official protocol conformance on latest staging and both-client parity. A permission denial is a successful **guard** test, never proof the permitted operation itself works. Do not claim all 58 client tools / 48 catalogue routes are certified.
