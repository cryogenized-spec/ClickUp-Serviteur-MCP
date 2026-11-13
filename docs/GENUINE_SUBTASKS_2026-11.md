# Genuine ClickUp subtasks — issue #139 (13 November 2026)

ClickUp Serviteur maintains **one user-facing MCP connection and one unified catalogue**. This is a source-only addition pending review and deployment; it does not modify any existing company task.

## Official API behaviour

The [Create Task endpoint](https://developer.clickup.com/reference/createtask) supports a `parent` task ID to create a genuine child in the **same home List**. The [Update Task endpoint](https://developer.clickup.com/reference/updatetask) accepts `parent` for changing subtask parent and documents that `parent:null` does **not** detach a subtask. The [Get Filtered Team Tasks endpoint](https://developer.clickup.com/reference/getfilteredteamtasks) accepts the `parent` parameter, `list_ids[]`, `subtasks=true` and zero-based `page`; the result should be treated as up to **100 tasks per page**. [ClickUp's subtasks FAQ](https://developer.clickup.com/docs/faq) specifies that the `parent` field is the immediate parent. ClickUp's [UI](https://help.clickup.com/hc/en-us/articles/6309825777943-Intro-to-subtasks) supports converting top-level tasks to subtasks; whether that specific change is accepted by the REST `parent` field must be verified in a disposable workspace before relying on it for a company record.

## Three new named operations

**`clickup_create_subtask({parent_task_id,new_task})`** creates one new child, not a task link or checklist. The server verifies the parent via the user's personal OAuth token and configured List/Workspace scope, derives the exact home List from the parent, validates a normal structured task draft (including markdown, assignees, status, due date, priority), and sends `POST /api/v2/list/{list_id}/task` with `parent`. Before the POST, it fetches the parent-filtered children including closed records and refuses any exact-title match; if this page is full, it cannot rule out duplicates and fails closed. It confirms the new child ID, name, home List and `parent` in a fresh task GET. It **never retries** an ambiguous POST.

**`clickup_list_direct_subtasks({parent_task_id,task_page?,task_offset?,max_results?})`** reads one bounded parent-filtered page (100 upstream records maximum), checks each returned row's exact parent and home List, and returns only `max_results` (at most 50) plus explicit continuation. `next_task_page` and `next_task_offset` must be followed; when a 100-row upstream page is full, the result is `incomplete:true` even at its end. Each entry is a real direct child; linked tasks or checklists do not appear.

**`clickup_reparent_task({task_id,parent_task_id,expected_task_name,expected_current_parent_id})`** updates the **same existing task ID**, not a recreated copy. Caller must supply a freshly verified title and original parent ID, or literal `none` for a top-level task. Both child and new parent must be in the same authorized home List. The server inspects the target's ancestor chain (up to 20 parents), refusing cycles, malformed or foreign ancestry and incomplete verification. If the requested parent is already present, it reports verified no-op. Otherwise it sends one `PUT /api/v2/task/{task_id}` with only `{parent:parent_task_id}` and verifies the same task ID, name, List and new parent through GET. An ambiguous PUT is **not retried**: a successful independent readback is required before reporting completion. This does not independently verify provider retention of every comment/history item, so live staging validation is required.

## Release and live acceptance

- Run synthetic negative tests, strict CI and CodeQL; perform a focused security review of any create/reparent path before merge.
- Manually deploy current reviewed `main` to the **internal staging Worker only**, using the same protected workflow. No additional ChatGPT MCP connection is required.
- Using disposable staging records, confirm creation with true parent ID, direct children enumeration and in-place reparent of one existing top-level dummy task, then verify existing comments, assignees, timestamps and task ID were retained. Confirm cross-List denial, cycle denial, duplicate title and stale expected parent, and no automatic retry.
- Only after this evidence and a separate explicit owner-approved company release should the new catalogue reach the single company MCP.

**Do not migrate live tasks automatically.** In particular, the existing Torcraft Cases/Boxed Stock task and the Backroom Supplier Stock receiving task referenced by [issue #139](https://github.com/cryogenized-spec/ClickUp-Serviteur-MCP/issues/139) remain unchanged until the owner explicitly approves that specific reparent.

Known limitation: exact-title duplicate protection is intentionally conservative, not a globally unique provider idempotency key. ClickUp can allow two distinct subtasks with identical titles when created concurrently through other clients. Never claim atomic idempotence.
