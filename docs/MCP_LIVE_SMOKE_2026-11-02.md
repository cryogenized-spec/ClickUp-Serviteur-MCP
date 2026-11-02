# Live NeonSales ClickUp MCP smoke-test evidence — 2 November 2026 (SAST)

> **Do not confuse tool-registration and permission enforcement with full tool correctness.** This report records only real operations performed through the user's connected ChatGPT custom NeonSales MCP against their fictional/dummy offshore project. No production staff tasks were modified.

## Environment

- Cloudflare staging Worker deployed from main `f0485c2c3fa327bfdccfe42cd858dd73087c84f3`; [successful deployment run](https://github.com/cryogenized-spec/NeonSales-ClickUp-MCP-/actions/runs/41485760603).
- OAuth connection reported active for ClickUp user `164542998`, dummy Workspace `9012707978`; authorised List `901219425894` named `Workshop Action Register`.
- `workspace_exclusive:true`, `workspace_scope_approved:true`, `workspace_scope_enabled:false`, `mcp_read_scope_granted:true`, `mcp_write_scope_granted:true`. A write scope is not equivalent to enabled Workspace resource scope.
- Model-visible inventory: **58 tools = 48 catalogue + 10 supporting**. Source registers 59 (the missing `clickup_set_workspace_access`). See [issue #50](https://github.com/cryogenized-spec/NeonSales-ClickUp-MCP-/issues/50). Visible `clickup_get_task` and `clickup_tool_catalog` descriptions contain stale "schema only" wording inconsistent with successful real operations.

## Three deliberately created simulation tasks — real ClickUp acknowledgements

The preexisting fictional `SIM-OFFSHORE-261025` exercise had five tasks (01–05) involving a 1,000-bbl heavy-crude order and a derrick. The user explicitly requested three more. Created **exactly three** using three independently exposed tool routes; no due dates or assignees invented:

| ID | New task | Tool | Result |
|---|---|---|---|
| `1ammuym49tc` | 06 Audit metering and sample traceability | `create_scoped_task` | Accepted; live `get_scoped_task` readback passed |
| `1ammuym49tf` | 07 Conduct offshore emergency-response tabletop | `clickup_create_task` | Created; live `clickup_get_task` readback passed |
| `1ammuym49th` | 08 Complete shift handover and open-risk register | `clickup_create_bulk_tasks` (single-item batch) | `partial:false`; live `get_scoped_task` readback passed |

Task-list count increased **21 → 24**, `find_scoped_tasks` returned all 24 on one page with `incomplete:false`; `clickup_search_workspace` for `SIM-OFFSHORE` returned 8 tasks, consisting of 5 preexisting and 3 new. The tasks have explicit fictional labels, completion criteria, no field-operating instructions, and no real commercial orders.

## REST catalogue tool-by-tool status

**11 successful in the exercised scenario; 13 deliberately denied by the currently disabled Workspace policy; 24 not exercised.** "Passed" is neither exhaustive endpoint compliance nor proof of every input shape; "guarded" proves the denial, not the permitted behaviour.

| # | Tool | 2 November live status |
|---:|---|---|
| 1 | `clickup_search_workspace` | PASS (limited live case) |
| 2 | `clickup_search_tasks_by_type` | PASS (limited live case) |
| 3 | `clickup_search_tasks_by_tag` | PASS (limited live case) |
| 4 | `clickup_create_task` | PASS (limited live case) |
| 5 | `clickup_get_task` | PASS (limited live case) |
| 6 | `clickup_update_task` | GUARDED — `CLICKUP_WORKSPACE_SCOPE_REQUIRED` |
| 7 | `clickup_set_custom_field` | NOT LIVE-TESTED |
| 8 | `clickup_delete_task` | NOT LIVE-TESTED |
| 9 | `clickup_create_bulk_tasks` | PASS (limited live case) |
| 10 | `clickup_update_bulk_tasks` | GUARDED — `CLICKUP_WORKSPACE_SCOPE_REQUIRED` |
| 11 | `clickup_attach_file_to_task` | NOT LIVE-TESTED |
| 12 | `clickup_get_task_comments` | GUARDED — `CLICKUP_WORKSPACE_SCOPE_REQUIRED` |
| 13 | `clickup_get_threaded_replies` | NOT LIVE-TESTED |
| 14 | `clickup_create_task_comment` | GUARDED — `CLICKUP_WORKSPACE_SCOPE_REQUIRED` |
| 15 | `clickup_add_tag_to_task` | GUARDED — `CLICKUP_WORKSPACE_SCOPE_REQUIRED` |
| 16 | `clickup_remove_tag_from_task` | NOT LIVE-TESTED |
| 17 | `clickup_add_task_link` | NOT LIVE-TESTED |
| 18 | `clickup_remove_task_link` | NOT LIVE-TESTED |
| 19 | `clickup_add_dependency` | GUARDED — `CLICKUP_WORKSPACE_SCOPE_REQUIRED` |
| 20 | `clickup_remove_dependency` | NOT LIVE-TESTED |
| 21 | `clickup_move_task_to_list` | NOT LIVE-TESTED |
| 22 | `clickup_add_task_to_list` | NOT LIVE-TESTED |
| 23 | `clickup_get_task_time_entries` | GUARDED — `CLICKUP_WORKSPACE_SCOPE_REQUIRED` |
| 24 | `clickup_get_time_entries_for_tasks` | PASS (limited live case) |
| 25 | `clickup_start_time_tracking` | NOT LIVE-TESTED |
| 26 | `clickup_stop_time_tracking` | NOT LIVE-TESTED |
| 27 | `clickup_add_time_entry` | NOT LIVE-TESTED |
| 28 | `clickup_get_current_time_entry` | GUARDED — `CLICKUP_WORKSPACE_SCOPE_REQUIRED` |
| 29 | `clickup_get_workspace_hierarchy` | GUARDED — `CLICKUP_WORKSPACE_SCOPE_REQUIRED` |
| 30 | `clickup_create_list` | NOT LIVE-TESTED |
| 31 | `clickup_create_list_in_folder` | NOT LIVE-TESTED |
| 32 | `clickup_get_list` | PASS (limited live case) |
| 33 | `clickup_update_list` | NOT LIVE-TESTED |
| 34 | `clickup_get_folder` | GUARDED — `CLICKUP_WORKSPACE_SCOPE_REQUIRED` |
| 35 | `clickup_create_folder` | NOT LIVE-TESTED |
| 36 | `clickup_update_folder` | NOT LIVE-TESTED |
| 37 | `clickup_get_workspace_members` | PASS (limited live case) |
| 38 | `clickup_find_member_by_name` | PASS (limited live case) |
| 39 | `clickup_resolve_assignees` | PASS (limited live case) |
| 40 | `clickup_get_chat_channels` | GUARDED — `CLICKUP_WORKSPACE_SCOPE_REQUIRED` |
| 41 | `clickup_send_chat_message` | NOT LIVE-TESTED |
| 42 | `clickup_create_document` | NOT LIVE-TESTED |
| 43 | `clickup_list_document_pages` | NOT LIVE-TESTED |
| 44 | `clickup_get_document_pages` | NOT LIVE-TESTED |
| 45 | `clickup_create_document_page` | NOT LIVE-TESTED |
| 46 | `clickup_update_document_page` | NOT LIVE-TESTED |
| 47 | `clickup_get_task_time_in_status` | GUARDED — `CLICKUP_WORKSPACE_SCOPE_REQUIRED` |
| 48 | `clickup_get_list_time_in_status` | GUARDED — `CLICKUP_WORKSPACE_SCOPE_REQUIRED` |

### Additional operational-support tools (outside 48)

- **PASS:** `service_info` (flags, not connectivity proof), `get_clickup_connection_status` (actual OAuth state), `get_scoped_list` (List ID and statuses), `find_scoped_tasks` (complete 24-task page), `get_scoped_task` (task descriptions/priorities on new tasks), `get_attention_report` (metadata-only, 7 overdue and 0 next-48h at test time), `create_scoped_task` (task 06), `clickup_tool_catalog` (48 entries, status operational; metadata only).
- **Not exercised deliberately:** `connect_clickup_account`, `disconnect_clickup_account` (would change active consent/session). An owner-only access switch is **absent from client tool listing** despite source registration.

## Other observations

- `clickup_search_tasks_by_type` for default type `0` returned 5 matching records, `incomplete:true` because the caller specified a limit of five; this is **bounded**, not proof of exhaustive list filtering.
- `clickup_search_tasks_by_tag` for a deliberately nonexisting test tag returned `tasks:[]`, `incomplete:false`. No existing tag was mutated.
- `clickup_get_time_entries_for_tasks` returned an empty collection with `incomplete:false`, `first_page_only:true`; this is a valid empty-result case, not proof of nonempty entry compatibility.
- Workspace member read and name/assignee resolution completed; detailed personal records are not reproduced in this report.
- A `get_scoped_task` read immediately after the first creation returned `CLICKUP_RATE_LIMITED`; later reattempt passed. The server's `src/clickup/quota-object.ts` enforces **30 reservations per minute per GitHub subject** and **80 per minute per ClickUp account overall**, before considering ClickUp's upstream rate limits. Tool invocation can require multiple underlying REST requests.
- For a new dummy task, `clickup_update_task` using unchanged priority; `clickup_update_bulk_tasks` using unchanged status; and a plainly identified test comment, tag and dependency all returned `CLICKUP_WORKSPACE_SCOPE_REQUIRED`. **No unintended write was observed or should be inferred.**
- No deletes, document modifications, new Workspace Lists, notifications to real Chat users, timer starts/stops or credential changes were attempted.
- Known response contract concerns remain in [issue #49](https://github.com/cryogenized-spec/NeonSales-ClickUp-MCP-/issues/49): some valid ClickUp API responses may be misclassified as uncertain failures, and v3 Docs page listing may use an array response.

## Next steps — precise evidence gates

1. Correct client/server tool discovery mismatch and stale descriptions (issue #50); independently inspect authenticated `tools/list` and refresh ChatGPT connector.
2. Obtain fresh, explicit owner authorization **on this dummy Workspace only** to opt into the revocable Workspace scope; verify denial for other identities. Never silently enable this permission.
3. Retest the thirteen guarded tools with safe disposable data, and run a separate carefully approved test plan for the twenty-four untested ones. Do not delete existing records or send real messages as a smoke test.
4. Repair and test the response-shape problems in issue #49 on the current source branch; do not merge obsolete PR #37 wholesale.
5. Test both successful and rejected inputs, partial pagination, large payloads, 429 and 5xx, idempotency and uncertain writes; official MCP conformance; native ClickUp attribution; Claude and ChatGPT client parity.
6. Update the [release-readiness roadmap](RELEASE_READINESS_ROADMAP_2026-11-02.md) with these results and repeat acceptance on the final deployed build.

**Conclusion:** The MCP works for several real List-bound tasks, including three distinct creation paths, but **48/48 live reliability is not established**. Workspace-only controls currently fail closed, as expected.
