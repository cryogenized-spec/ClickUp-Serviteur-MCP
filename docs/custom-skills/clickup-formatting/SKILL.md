---
name: clickup-formatting
description: Use before drafting or updating ClickUp task descriptions, inventory tables, workshop notes, and comments through the Serviteur MCP. Matches the actual tool schema and verifies rendered output.
---

# ClickUp formatting — Serviteur MCP

## Confirm the current tool contract first

Read `src/mcp/tool-catalog.ts` or invoke `clickup_tool_catalog({group:"tasks",include_schema:true})` and the comments group. The deployed Serviteur schema presently exposes `new_task.description` and `changes.description` as **plain-text** fields (maximum 8,000 characters), not `markdown_content`; task title `name` is bounded to 180 characters. Comments use plain `text` (maximum 6,000 characters), and, **only when the refreshed deployed schema advertises it**, a mutually exclusive `mention_segments` array for verified structured @mentions on NEW comments. Neither mode supports arbitrary Markdown. Never insert `markdown_content` into a model call unless the live advertised schema **and** guarded runtime explicitly accept it. ClickUp's *direct* REST API may support `markdown_content`; that is not proof the connected MCP passes it through.

## Durable, readable default

Prefer concise plain-text sections with blank lines, explicit headings, and one item per line. For inventory, use a vertical key–value format instead of a pipe-delimited Markdown table if rendering is not verified. This avoids the previously observed raw `|---|` markup in descriptions.

**Example — safe task description (`description`):**

```text
Front counter shelving — brackets/struts

Purpose:
Install the existing display shelves on their slotted uprights.

Required components:
- Shelf support struts: quantity to confirm
- Slotted uprights: existing
- Shelves: existing

Action:
Confirm compatible strut dimensions and quantity before purchase.
Photographs: attached to this task, if ClickUp accepts upload.
```

**Example — safe inventory comparison:**

```text
COMPETITOR COMPARISON — 06 Nov 2026 SAST

Supplier: Example A
Product: Sample item
Unit price: R125.00
Product page: https://example.invalid/product/123

Supplier: Example B
Product: Sample item
Unit price: R131.00
Product page: https://example.invalid/product/456

Review note: Prices require verification before quoting.
```

The example domains and prices are illustrative only. Replace every item with verified details. Do not invent competitors, dates, prices, invoice IDs, or links. If user requests an actual table, say the current MCP plain-text path cannot guarantee native ClickUp table rendering; offer a readable fallback or a separately approved rich-content enhancement.

## Authoring and safety checklist

1. Identify the existing task by **exact ID** and confirm its title, home List and editable fields; for a new task obtain the authorised `list_id`. Use `clickup_get_list` to discover statuses and `clickup_find_member_by_name` / `clickup_resolve_assignees` for unique assignees. Never infer IDs.
2. Ask only for truly missing information. Distinguish a draft from authorisation to post; no real company write without the operator's request.
3. Check title length (180), description (8,000), comment text (6,000), field names and list status. Preserve the user's punctuation, approximate times, decimal separator and South African date/time (`SAST, UTC+02:00`) for workshop records. Do not turn an unknown time into a precise timestamp.
4. Keep literal `|`, `#`, asterisks and backticks only when they are intended as text. Do **not** assume Markdown headings, tables, checkboxes or clickable embedded links will render from a plain `description`. For literal URLs, supply the full URL on its own line.
5. Use explicit non-destructive write operations (`clickup_create_task`, `clickup_update_task`, `clickup_create_task_comment`, or `clickup_edit_task_comment`). For comments, a typed `@Person` is only plain text. If `clickup_create_task_comment` **currently advertises** `mention_segments`, use ordered `{text:"..."}` and `{mention_user_id:"123..."}` segments, with independently resolved exact Workspace member IDs and explicit posting approval; this can notify colleagues. Never combine `mention_segments` with legacy `text`, use it for replies/edits, infer a member ID or promise notification delivery. Comment assignment is a separate operation.
6. After any approved write, read the exact task/comment back and verify **content and placement**. A success response verifies API acceptance, **not** how ClickUp's web interface rendered a table. Describe rendering as verified only after an independent visual inspection or demonstrably rich readback.
7. Do not retry automatically after `CLICKUP_WRITE_OUTCOME_UNKNOWN`. Read back first and report uncertainty. Do not erase existing task fields when editing a single property.

## Rich text and native table boundaries

ClickUp's official REST Create/Update Task endpoints describe `markdown_content`, which the current Serviteur tool does **not** expose. A separate implementation must update closed model schemas and runtime validation together, map `markdown_content` to REST, reject conflicting `description` plus `markdown_content` unless precedence is documented, add rigorous tests, and deploy via reviewed company workflow. Even if implemented, ClickUp Markdown tables may not retain native table structure, so inspect a disposable task in the UI before promising it.

See `docs/CLICKUP_TOOL_SCHEMA.md`, `src/mcp/tool-catalog.ts`, and [Create Task](https://developer.clickup.com/reference/createtask), [Update Task](https://developer.clickup.com/reference/updatetask). This skill is a repository guide for coding agents, **not** automatically installed as a ChatGPT or Claude conversation plugin.
