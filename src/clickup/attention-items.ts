import { ReadFailure, type ReadGrant } from "./policy.js";

/**
 * One read-only attention summary, not a mirror of ClickUp's private Inbox.
 * The upstream transport, quota cooldown and OAuth handling are unchanged.
 * Every task search is scoped at the provider before data is returned.
 */
type Json = Record<string, unknown>;
type Entry = Readonly<{ rank: number; due: number | null; activity: number; item: Json }>;

const record = (value: unknown): Json | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Json) : null;
const identifier = (value: unknown, max = 80): string => {
  if (
    (typeof value !== "string" && typeof value !== "number") ||
    !/^[a-zA-Z0-9_-]{1,80}$/.test(String(value)) ||
    String(value).length > max
  ) throw new ReadFailure("CLICKUP_INVALID_ARGUMENT");
  return String(value);
};
const milliseconds = (value: unknown): number | null => {
  if (value === undefined || value === null || value === "") return null;
  if (
    (typeof value !== "string" && typeof value !== "number") ||
    !/^\d{1,13}$/.test(String(value)) ||
    !Number.isSafeInteger(Number(value))
  ) throw new ReadFailure("CLICKUP_BAD_RESPONSE");
  return Number(value);
};
const userId = (value: unknown): string | null => {
  const raw = record(value)?.["id"] ?? value;
  return (typeof raw === "string" || typeof raw === "number") && /^[1-9]\d{0,17}$/.test(String(raw))
    ? String(raw)
    : null;
};
const isMentioned = (comment: Json, me: string): boolean => {
  const spans = comment["comment"];
  return Array.isArray(spans) && spans.some((value) => {
    const span = record(value);
    return span?.["type"] === "tag" && userId(span["user"]) === me;
  });
};
const preview = (comment: Json): string => {
  const plain = comment["comment_text"];
  if (typeof plain === "string") return plain.slice(0, 240);
  const spans = comment["comment"];
  if (!Array.isArray(spans)) return "";
  return spans
    .slice(0, 100)
    .map((part) => {
      const node = record(part);
      return node?.["type"] === "tag" ? "@mention" : typeof node?.["text"] === "string" ? node["text"] : "";
    })
    .join("")
    .slice(0, 240);
};
const taskUrl = (value: unknown): string | null => {
  if (typeof value !== "string" || value.length > 2048) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "app.clickup.com" &&
      url.username === "" && url.password === "" && url.pathname.startsWith("/t/")
      ? url.href
      : null;
  } catch {
    return null;
  }
};
const localDay = (milliseconds: number): number => {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Africa/Johannesburg",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(milliseconds));
  const val = (key: string) => Number(parts.find((part) => part.type === key)?.value);
  return Date.UTC(val("year"), val("month") - 1, val("day")) / 86_400_000;
};
function dueCategory(task: Json, now: number): "overdue_task" | "due_soon_task" | "assigned_task" {
  const due = milliseconds(task["due_date"]);
  if (due === null) return "assigned_task";
  // A date-only deadline is not overdue until the next Johannesburg calendar day.
  const timed = task["due_date_time"] === true;
  const days = localDay(due) - localDay(now);
  if (timed ? due < now : days < 0) return "overdue_task";
  if (timed ? due <= now + 48 * 3_600_000 : days <= 2) return "due_soon_task";
  return "assigned_task";
}
function validatedTask(
  value: unknown,
  grant: ReadGrant,
  selectedList: string | undefined,
): Json {
  const task = record(value);
  const list = record(task?.["list"]);
  const home = list?.["id"];
  if (
    !task ||
    typeof task["id"] !== "string" ||
    !/^[a-zA-Z0-9_-]{1,80}$/.test(task["id"]) ||
    typeof task["name"] !== "string" ||
    task["name"].length > 40_000 ||
    (typeof home !== "number" && typeof home !== "string") ||
    !/^[1-9]\d{0,17}$/.test(String(home)) ||
    (selectedList !== undefined && String(home) !== selectedList) ||
    (grant.resourceScope !== "workspace" && String(home) !== grant.listId)
  ) throw new ReadFailure("CLICKUP_SCOPE_OR_SCHEMA_REJECTED");
  if (task["assignees"] !== undefined && !Array.isArray(task["assignees"]))
    throw new ReadFailure("CLICKUP_BAD_RESPONSE");
  if (task["workspace_id"] !== undefined && String(task["workspace_id"]) !== grant.workspaceId)
    throw new ReadFailure("CLICKUP_SCOPE_OR_SCHEMA_REJECTED");
  return task;
}
function assignedToMe(task: Json, me: string): boolean {
  return Array.isArray(task["assignees"]) && task["assignees"].some((entry) => userId(entry) === me);
}
const attentionItem = (task: Json, kind: string, reasons: string[], activity: number | null): Json => ({
  item_id: "task:" + task["id"],
  kind,
  reasons,
  task_id: task["id"],
  list_id: String(record(task["list"])?.["id"]),
  title: String(task["name"]).slice(0, 180),
  status: typeof record(task["status"])?.["status"] === "string"
    ? String(record(task["status"])?.["status"]).slice(0, 80)
    : null,
  priority: /^[1-4]$/.test(String(record(task["priority"])?.["id"] ?? ""))
    ? Number(record(task["priority"])?.["id"])
    : null,
  due_at: milliseconds(task["due_date"]),
  activity_at: activity,
  url: taskUrl(task["url"]),
  read_state: "unavailable",
});
function parameters(page: number, own: boolean, me: string, listId?: string): string {
  const params = new URLSearchParams({
    page: String(page),
    subtasks: "true",
    include_closed: "false",
    order_by: "updated",
    reverse: "true",
  });
  if (own) params.append("assignees[]", me);
  if (listId) params.append("list_ids[]", listId);
  return params.toString();
}
function integerArg(a: Json, key: string, defaultValue: number, min: number, max: number): number {
  const value = a[key] ?? defaultValue;
  if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max)
    throw new ReadFailure("CLICKUP_INVALID_ARGUMENT");
  return Number(value);
}
export async function getMyAttentionItems(
  args: Json,
  grant: ReadGrant,
  read: (apiV2Path: string) => Promise<Json>,
  verifyList: (listId: string) => Promise<void>,
): Promise<Json> {
  const me = identifier(grant.clickupUserId);
  if (!/^[1-9]\d{0,17}$/.test(me)) throw new ReadFailure("CLICKUP_SCOPE_OR_SCHEMA_REJECTED");
  const N = integerArg(args, "max_results", 20, 1, 50);
  const assignedPage = integerArg(args, "attention_assigned_page", 0, 0, 100_000);
  const activityPage = integerArg(args, "attention_activity_page", 0, 0, 100_000);
  const commentTaskCount = integerArg(args, "attention_comment_tasks", 8, 0, 30);
  const resultOffset = integerArg(args, "attention_result_offset", 0, 0, 10_000);
  const mentionLookback = integerArg(args, "lookback_days", 7, 1, 90);
  const selectedList = args["list_id"] === undefined
    ? grant.resourceScope === "workspace" ? undefined : identifier(grant.listId)
    : identifier(args["list_id"]);
  if (selectedList !== undefined) {
    if (!/^[1-9]\d{0,17}$/.test(selectedList))
      throw new ReadFailure("CLICKUP_INVALID_ARGUMENT");
    await verifyList(selectedList);
  }
  const root = selectedList !== undefined
    ? "list/" + selectedList + "/task"
    : "team/" + identifier(grant.workspaceId) + "/task";
  const now = Date.now();
  const recentCutoff = now - mentionLookback * 86_400_000;
  const found = new Map<string, Entry>();
  const allTasks = new Map<string, Json>();
  const updatedTasks = new Map<string, Json>();
  const inspectedLists = new Set<string>(selectedList ? [selectedList] : []);
  const coverage = {
    assigned_tasks_examined: 0,
    activity_tasks_examined: 0,
    comment_tasks_inspected: 0,
    comments_inspected: 0,
    comment_pages_inspected: 0,
    more_assigned_task_pages: false,
    more_activity_task_pages: false,
    additional_comment_pages_possible: false,
    comments_on_uninspected_tasks_may_be_missing: true,
    comment_discovery_depends_on_recent_task_order: true,
    threaded_replies_included: false,
    group_mentions_included: false,
    watched_tasks_included: false,
    clickup_inbox_state_available: false,
  };
  let interrupted: string | null = null;
  let assignedFetched = false;
  let activityFetched = false;
  const fetchTasks = async (page: number, assigned: boolean): Promise<Json[]> => {
    const result = await read(root + "?" + parameters(page, assigned, me, undefined));
    if (!Array.isArray(result["tasks"]) || result["tasks"].length > 100)
      throw new ReadFailure("CLICKUP_BAD_RESPONSE");
    // Reject an entire mixed-scope page before any of its contents are usable.
    return result["tasks"].map((task) => validatedTask(task, grant, selectedList));
  };
  // A real upstream 429 is not an authorization failure. Preserve previously
  // verified results; do not add any speculative self-imposed per-minute cap.
  const tryRead = async <T>(fn: () => Promise<T>): Promise<T | null> => {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof ReadFailure && error.code === "CLICKUP_RATE_LIMITED") {
        interrupted = "clickup_rate_limited";
        return null;
      }
      throw error;
    }
  };
  const assigned = await tryRead(() => fetchTasks(assignedPage, true));
  // A 429 before any successful source read must remain an explicit error,
  // not an empty result that might be mistaken for an empty attention queue.
  if (assigned === null) throw new ReadFailure("CLICKUP_RATE_LIMITED");
  if (assigned !== null) {
    assignedFetched = true;
    coverage.assigned_tasks_examined = assigned.length;
    coverage.more_assigned_task_pages = assigned.length === 100;
    for (const task of assigned) {
      // Only claim task assignment when the returned assignee IDs verify it.
      if (!assignedToMe(task, me)) continue;
      allTasks.set(String(task["id"]), task);
    }
    const activity = await tryRead(() => fetchTasks(activityPage, false));
    if (activity !== null) {
      activityFetched = true;
      coverage.activity_tasks_examined = activity.length;
      coverage.more_activity_task_pages = activity.length === 100;
      for (const task of activity) {
        updatedTasks.set(String(task["id"]), task);
        // The activity scan is a discovery source, not a replacement for the
        // independently verified assigned-task snapshot. Preserve its due date
        // and priority when the two API pages disagree.
        if (assignedToMe(task, me) && !allTasks.has(String(task["id"])))
          allTasks.set(String(task["id"]), task);
      }
    }
  }
  for (const task of allTasks.values()) {
    const kind = dueCategory(task, now);
    const due = milliseconds(task["due_date"]);
    const activity = milliseconds(task["date_updated"]) ?? 0;
    const entry = attentionItem(
      task, kind, kind === "overdue_task"
        ? ["assigned_to_me", "overdue"]
        : kind === "due_soon_task" ? ["assigned_to_me", "due_soon"] : ["assigned_to_me"],
      activity || null,
    );
    found.set(String(entry["item_id"]), {
      rank: kind === "overdue_task" ? 1 : kind === "due_soon_task" ? 3 : 4,
      due,
      activity,
      item: entry,
    });
  }
  // Inspect activity tasks first, then assigned tasks not represented there.
  // No blind Workspace scans for List-only principals; every comment candidate
  // is verified to belong to the current OAuth-bound Workspace/List.
  const commentCandidates = [...updatedTasks.values(), ...allTasks.values()];
  const uniqueCandidates = new Map<string, Json>();
  for (const task of commentCandidates) uniqueCandidates.set(String(task["id"]), task);
  const tasksToInspect = [...uniqueCandidates.values()]
    .sort((a, b) => (milliseconds(b["date_updated"]) ?? 0) - (milliseconds(a["date_updated"]) ?? 0))
    .slice(0, commentTaskCount);
  for (const task of interrupted ? [] : tasksToInspect) {
    const listId = String(record(task["list"])?.["id"]);
    if (!inspectedLists.has(listId)) {
      // This is a permission preflight, never a model-supplied authorization.
      // Scope errors must fail closed; only real upstream 429 may return partial.
      const checked = await tryRead(() => verifyList(listId));
      if (checked === null) break;
      inspectedLists.add(listId);
    }
    const taskId = identifier(task["id"]);
    const response = await tryRead(() => read("task/" + taskId + "/comment"));
    if (response === null) break;
    if (!Array.isArray(response["comments"]) || response["comments"].length > 25 ||
      response["comments"].some((entry) => !record(entry) ||
        typeof record(entry)?.["id"] !== "string"))
      throw new ReadFailure("CLICKUP_BAD_RESPONSE");
    coverage.comment_tasks_inspected++;
    coverage.comment_pages_inspected++;
    coverage.comments_inspected += response["comments"].length;
    if (response["comments"].length === 25) coverage.additional_comment_pages_possible = true;
    for (const raw of response["comments"]) {
      const comment = record(raw)!;
      const assigned = userId(comment["assignee"]) === me && comment["resolved"] === false;
      const at = milliseconds(comment["date"]);
      const mentioned = (at === null || at >= recentCutoff) && isMentioned(comment, me);
      if (!assigned && !mentioned) continue;
      const reasons = [
        ...(assigned ? ["unresolved_comment_assigned_to_me"] : []),
        ...(mentioned ? ["individual_mention"] : []),
      ];
      const taskItem = attentionItem(task, assigned ? "assigned_comment" : "mention", reasons, at);
      const key = "comment:" + taskId + ":" + identifier(comment["id"], 100);
      const item = {
        ...taskItem,
        item_id: key,
        kind: assigned ? "assigned_comment" : "mention",
        comment_id: String(comment["id"]),
        comment_preview: preview(comment),
      };
      found.set(key, { rank: assigned ? 0 : 2, due: null, activity: at ?? 0, item });
    }
  }
  const entries = [...found.values()].sort((a, b) =>
    a.rank - b.rank ||
    (a.rank === 1 || a.rank === 3 ? (a.due ?? Infinity) - (b.due ?? Infinity) : b.activity - a.activity) ||
    (Number(a.item["priority"] ?? 9) - Number(b.item["priority"] ?? 9)) ||
    String(a.item["item_id"]).localeCompare(String(b.item["item_id"])),
  );
  const visible = entries.slice(resultOffset, resultOffset + N);
  const moreResults = resultOffset + visible.length < entries.length;
  return {
    source: "clickup-api-v2",
    tool: "clickup_get_my_attention_items",
    is_official_inbox: false,
    timezone: "Africa/Johannesburg",
    user_id: me,
    scope: selectedList !== undefined ? "list" : "workspace",
    ...(selectedList !== undefined ? { list_id: selectedList } : {}),
    items: visible.map((entry) => entry.item),
    total_items_in_inspected_sources: entries.length,
    next_result_offset: moreResults ? resultOffset + visible.length : null,
    next_assigned_page: assignedFetched && coverage.more_assigned_task_pages ? assignedPage + 1 : null,
    next_activity_page: activityFetched && coverage.more_activity_task_pages ? activityPage + 1 : null,
    partial: interrupted !== null,
    ...(interrupted ? { interrupted_reason: interrupted } : {}),
    incomplete: interrupted !== null || moreResults ||
      coverage.more_assigned_task_pages || coverage.more_activity_task_pages ||
      coverage.additional_comment_pages_possible ||
      tasksToInspect.length < uniqueCandidates.size,
    no_matches_statement: visible.length === 0
      ? "No matching attention items found in the inspected tasks and comment pages."
      : null,
    coverage,
  };
}
