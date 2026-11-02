import { quotaCall } from "./client.js";
import { ReadFailure, type ReadGrant } from "./policy.js";

/** REST-backed ClickUp tool catalogue. No extra approval controls, state journal,
 * rollback engine or background watcher. ClickUp itself owns all task history.
 * The calling human's own OAuth identity is the ONLY upstream actor. */
type Json = Record<string, unknown>;
type Method = "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
const obj = (x: unknown): Json | null =>
  x !== null && typeof x === "object" && !Array.isArray(x) ? (x as Json) : null;
const id = (v: unknown): string => {
  if ((typeof v !== "number" && typeof v !== "string") || !/^[a-zA-Z0-9_-]{1,80}$/.test(String(v)))
    throw new ReadFailure("CLICKUP_INVALID_ARGUMENT");
  return encodeURIComponent(String(v));
};
const val = (a: Json, k: string) => id(a[k]);
const txt = (v: unknown, max = 8000): string => {
  if (typeof v !== "string" || !v.trim() || v.length > max)
    throw new ReadFailure("CLICKUP_INVALID_ARGUMENT");
  return v;
};
const count = (a: Json) => {
  const n = a["max_results"] ?? 20;
  if (!Number.isInteger(n) || (n as number) < 1 || (n as number) > 50)
    throw new ReadFailure("CLICKUP_INVALID_ARGUMENT");
  return n as number;
};
const clip = (v: unknown): unknown => {
  if (Array.isArray(v)) return v.slice(0, 50).map(clip);
  const item = obj(v);
  if (item)
    return Object.fromEntries(
      Object.entries(item)
        .filter(([k]) => !/token|secret|authorization|password/i.test(k))
        .map(([k, x]) => [k, clip(x)]),
    );
  if (typeof v === "string") return v.slice(0, 12000);
  return v;
};
function buildArgs(a: Json, key: string): Json {
  const b = obj(a[key]);
  if (!b) throw new ReadFailure("CLICKUP_INVALID_ARGUMENT");
  return b;
}
function pathEncoded(p: string) {
  if (!/^api\/v[23]\//.test(p) || p.includes("..") || p.includes("//") || /[\\#]/.test(p))
    throw new ReadFailure("CLICKUP_INVALID_ARGUMENT");
  return "https://api.clickup.com/" + p;
}
async function send(
  grant: ReadGrant,
  fetcher: typeof fetch,
  method: Method,
  path: string,
  body?: Json,
): Promise<Json> {
  const target = pathEncoded(path);
  await quotaCall(grant, "reserve");
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), 7000);
  try {
    const res = await fetcher(target, {
      method,
      redirect: "manual",
      signal: abort.signal,
      headers: {
        Authorization: grant.apiToken,
        Accept: "application/json",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (res.status === 429) {
      const reset = res.headers.get("X-RateLimit-Reset");
      if (reset && /^\d{1,12}$/.test(reset)) {
        const unix = Number(reset);
        if (unix > Date.now() / 1000 && unix < Date.now() / 1000 + 3600)
          await quotaCall(grant, "cooldown", unix * 1000);
      }
      throw new ReadFailure("CLICKUP_RATE_LIMITED");
    }
    if (res.status === 401 || res.status === 403) throw new ReadFailure("CLICKUP_UPSTREAM_DENIED");
    if (!res.ok)
      throw new ReadFailure(
        method === "GET" || res.status < 500
          ? "CLICKUP_UPSTREAM_UNAVAILABLE"
          : "CLICKUP_WRITE_OUTCOME_UNKNOWN",
      );
    if (res.status === 204 || res.status === 205) {
      if (method === "DELETE")
        return { success: true, source: "clickup-api", response_empty: true };
      throw new ReadFailure(
        method === "GET" ? "CLICKUP_BAD_RESPONSE" : "CLICKUP_WRITE_OUTCOME_UNKNOWN",
      );
    }
    const t = res.headers.get("content-type") ?? "";
    const length = Number(res.headers.get("content-length") ?? "0");
    if (!t.includes("application/json") || length > 1000000)
      throw new ReadFailure(
        method === "GET" ? "CLICKUP_BAD_RESPONSE" : "CLICKUP_WRITE_OUTCOME_UNKNOWN",
      );
    const text = await res.text();
    if (text.length > 1000000)
      throw new ReadFailure(
        method === "GET" ? "CLICKUP_BAD_RESPONSE" : "CLICKUP_WRITE_OUTCOME_UNKNOWN",
      );
    const result: unknown = JSON.parse(text);
    const data = obj(result);
    if (!data)
      throw new ReadFailure(
        method === "GET" ? "CLICKUP_BAD_RESPONSE" : "CLICKUP_WRITE_OUTCOME_UNKNOWN",
      );
    if (method !== "GET" && method !== "DELETE" && Object.keys(data).length === 0)
      throw new ReadFailure("CLICKUP_WRITE_OUTCOME_UNKNOWN");
    if (
      method === "POST" &&
      /\/list\/[^/]+\/task$/.test(path) &&
      (typeof data["id"] !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(data["id"]))
    )
      throw new ReadFailure("CLICKUP_WRITE_OUTCOME_UNKNOWN");
    return data;
  } catch (e) {
    if (e instanceof ReadFailure) throw e;
    throw new ReadFailure(
      method === "GET" ? "CLICKUP_UPSTREAM_UNAVAILABLE" : "CLICKUP_WRITE_OUTCOME_UNKNOWN",
    );
  } finally {
    clearTimeout(timeout);
  }
}
const v2 = (p: string) => "api/v2/" + p;
const v3 = (p: string) => "api/v3/" + p;
async function spaces(grant: ReadGrant, f: typeof fetch): Promise<Json[]> {
  const data = await send(
    grant,
    f,
    "GET",
    v2("team/" + id(grant.workspaceId) + "/space?archived=false"),
  );
  if (!Array.isArray(data["spaces"]) || data["spaces"].length > 500)
    throw new ReadFailure("CLICKUP_SCOPE_OR_SCHEMA_REJECTED");
  return data["spaces"].filter((x: unknown) => obj(x) !== null) as Json[];
}
async function inWorkspace(grant: ReadGrant, f: typeof fetch, spaceId: unknown): Promise<void> {
  const allowed = await spaces(grant, f);
  if (!allowed.some((s) => String(s["id"]) === String(spaceId)))
    throw new ReadFailure("CLICKUP_SCOPE_OR_SCHEMA_REJECTED");
}
async function listInWorkspace(grant: ReadGrant, f: typeof fetch, listId: unknown): Promise<Json> {
  // The individual ClickUp token may access additional Lists. That does NOT expand
  // this MCP's explicitly configured home-List grant.
  if (grant.resourceScope !== "workspace" && String(listId) !== grant.listId)
    throw new ReadFailure("CLICKUP_SCOPE_OR_SCHEMA_REJECTED");
  const list = await send(grant, f, "GET", v2("list/" + id(listId)));
  if (String(list["id"]) !== String(listId))
    throw new ReadFailure("CLICKUP_SCOPE_OR_SCHEMA_REJECTED");
  await inWorkspace(grant, f, obj(list["space"])?.["id"]);
  return list;
}
async function taskInWorkspace(grant: ReadGrant, f: typeof fetch, taskId: unknown): Promise<Json> {
  const task = await send(grant, f, "GET", v2("task/" + id(taskId)));
  if (String(task["id"]) !== String(taskId))
    throw new ReadFailure("CLICKUP_SCOPE_OR_SCHEMA_REJECTED");
  await listInWorkspace(grant, f, obj(task["list"])?.["id"]);
  return task;
}
async function folderInWorkspace(
  grant: ReadGrant,
  f: typeof fetch,
  folderId: unknown,
): Promise<Json> {
  const folder = await send(grant, f, "GET", v2("folder/" + id(folderId)));
  if (String(folder["id"]) !== String(folderId))
    throw new ReadFailure("CLICKUP_SCOPE_OR_SCHEMA_REJECTED");
  await inWorkspace(grant, f, obj(folder["space"])?.["id"]);
  return folder;
}
const taskBody = (a: Json, update = false): Json => {
  const permitted = new Set([
    "name",
    "description",
    "status",
    "priority",
    "due_date_ms",
    "assignee_ids",
  ]);
  if (Object.keys(a).some((key) => !permitted.has(key)))
    throw new ReadFailure("CLICKUP_INVALID_ARGUMENT");
  for (const key of ["name", "description", "status"] as const) {
    if (a[key] !== undefined && typeof a[key] !== "string")
      throw new ReadFailure("CLICKUP_INVALID_ARGUMENT");
  }
  if (
    a["priority"] !== undefined &&
    (!Number.isInteger(a["priority"]) || Number(a["priority"]) < 1 || Number(a["priority"]) > 4)
  )
    throw new ReadFailure("CLICKUP_INVALID_ARGUMENT");
  if (
    a["due_date_ms"] !== undefined &&
    (!Number.isSafeInteger(a["due_date_ms"]) ||
      Number(a["due_date_ms"]) <= 0 ||
      Number(a["due_date_ms"]) > 9_000_000_000_000)
  )
    throw new ReadFailure("CLICKUP_INVALID_ARGUMENT");
  const assignees = a["assignee_ids"];
  if (
    assignees !== undefined &&
    (!Array.isArray(assignees) ||
      assignees.length > 12 ||
      assignees.some((user) => !Number.isSafeInteger(user) || user <= 0))
  )
    throw new ReadFailure("CLICKUP_INVALID_ARGUMENT");
  return {
    ...(a["name"] !== undefined ? { name: txt(a["name"], 180) } : {}),
    ...(a["description"] !== undefined ? { description: txt(a["description"]) } : {}),
    ...(a["status"] !== undefined ? { status: txt(a["status"], 80) } : {}),
    ...(a["priority"] !== undefined ? { priority: a["priority"] } : {}),
    ...(a["due_date_ms"] !== undefined ? { due_date: a["due_date_ms"], due_date_time: true } : {}),
    ...(Array.isArray(assignees)
      ? { assignees: update ? { add: assignees, rem: [] } : assignees }
      : {}),
  };
};
async function members(grant: ReadGrant, f: typeof fetch): Promise<Json[]> {
  const d = await send(grant, f, "GET", v2("team"));
  const team = Array.isArray(d["teams"])
    ? d["teams"].map(obj).find((t) => String(t?.["id"]) === grant.workspaceId)
    : null;
  if (!team || !Array.isArray(team["members"])) throw new ReadFailure("CLICKUP_BAD_RESPONSE");
  return team["members"]
    .slice(0, 200)
    .map((x: unknown) => obj(x) ?? {})
    .map((x) => obj(x["user"]) ?? x);
}
const short = (d: Json, limit = 50): Json => {
  const keys = [
    "tasks",
    "comments",
    "replies",
    "channels",
    "messages",
    "time_entries",
    "entries",
    "docs",
  ];
  const arrays = keys.filter((k) => Array.isArray(d[k]));
  const truncated = arrays.some((k) => (d[k] as unknown[]).length > limit);
  // ClickUp's first comments page can contain 25; reaching it suggests older
  // pages may exist even if no item was discarded by the display cap.
  const possibleMorePages = Array.isArray(d["comments"]) && d["comments"].length >= 25;
  return clip({
    ...d,
    ...Object.fromEntries(arrays.map((k) => [k, (d[k] as unknown[]).slice(0, limit)])),
    incomplete: truncated || possibleMorePages || d["incomplete"] === true,
    first_page_only: true,
  }) as Json;
};

/** REST adapters use individual OAuth. Base64 attachment uploads are capped
 * at 500 KiB because MCP tool args are text; no remote file URLs are fetched. */
async function uploadAttachment(
  grant: ReadGrant,
  fetcher: typeof fetch,
  taskId: string,
  filename: string,
  base64: string,
  mime: string,
): Promise<Json> {
  if (
    !/^[a-zA-Z0-9._ ()-]{1,120}$/.test(filename) ||
    filename === "." ||
    filename === ".." ||
    base64.length > 700000 ||
    base64.length < 4 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(base64) ||
    !/^[a-zA-Z0-9.+-]+\/[a-zA-Z0-9.+-]+$/.test(mime)
  ) {
    throw new ReadFailure("CLICKUP_INVALID_ARGUMENT");
  }
  let binary: string;
  try {
    binary = atob(base64);
  } catch {
    throw new ReadFailure("CLICKUP_INVALID_ARGUMENT");
  }
  if (binary.length > 512000 || binary.length === 0)
    throw new ReadFailure("CLICKUP_INVALID_ARGUMENT");
  const data = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) data[i] = binary.charCodeAt(i);
  const form = new FormData();
  form.append("attachment[0]", new Blob([data], { type: mime }), filename);
  await quotaCall(grant, "reserve");
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), 10000);
  try {
    const res = await fetcher("https://api.clickup.com/api/v2/task/" + id(taskId) + "/attachment", {
      method: "POST",
      redirect: "manual",
      signal: abort.signal,
      headers: { Authorization: grant.apiToken, Accept: "application/json" },
      body: form,
    });
    if (res.status === 429) {
      const reset = res.headers.get("X-RateLimit-Reset");
      if (reset && /^\d{1,12}$/.test(reset)) {
        const unix = Number(reset);
        if (unix > Date.now() / 1000 && unix < Date.now() / 1000 + 3600)
          await quotaCall(grant, "cooldown", unix * 1000);
      }
      throw new ReadFailure("CLICKUP_RATE_LIMITED");
    }
    if (res.status === 401 || res.status === 403) throw new ReadFailure("CLICKUP_UPSTREAM_DENIED");
    if (!res.ok)
      throw new ReadFailure(
        res.status >= 500 ? "CLICKUP_WRITE_OUTCOME_UNKNOWN" : "CLICKUP_UPSTREAM_UNAVAILABLE",
      );
    const content = await res.text();
    if (content.length > 1000000) throw new ReadFailure("CLICKUP_WRITE_OUTCOME_UNKNOWN");
    const parsed: unknown = JSON.parse(content);
    const object = obj(parsed);
    if (!object) throw new ReadFailure("CLICKUP_WRITE_OUTCOME_UNKNOWN");
    return clip(object) as Json;
  } catch (e) {
    if (e instanceof ReadFailure) throw e;
    throw new ReadFailure("CLICKUP_WRITE_OUTCOME_UNKNOWN");
  } finally {
    clearTimeout(timeout);
  }
}

export const OPERATIONAL_CATALOG_NAMES: readonly string[] = [
  "clickup_search_workspace",
  "clickup_search_tasks_by_type",
  "clickup_search_tasks_by_tag",
  "clickup_create_task",
  "clickup_get_task",
  "clickup_update_task",
  "clickup_set_custom_field",
  "clickup_delete_task",
  "clickup_attach_file_to_task",
  "clickup_create_bulk_tasks",
  "clickup_update_bulk_tasks",
  "clickup_get_task_comments",
  "clickup_get_threaded_replies",
  "clickup_create_task_comment",
  "clickup_add_tag_to_task",
  "clickup_remove_tag_from_task",
  "clickup_add_task_link",
  "clickup_remove_task_link",
  "clickup_add_dependency",
  "clickup_remove_dependency",
  "clickup_move_task_to_list",
  "clickup_add_task_to_list",
  "clickup_get_task_time_entries",
  "clickup_get_time_entries_for_tasks",
  "clickup_start_time_tracking",
  "clickup_stop_time_tracking",
  "clickup_add_time_entry",
  "clickup_get_current_time_entry",
  "clickup_get_workspace_hierarchy",
  "clickup_create_list",
  "clickup_create_list_in_folder",
  "clickup_get_list",
  "clickup_update_list",
  "clickup_get_folder",
  "clickup_create_folder",
  "clickup_update_folder",
  "clickup_get_workspace_members",
  "clickup_find_member_by_name",
  "clickup_resolve_assignees",
  "clickup_get_chat_channels",
  "clickup_send_chat_message",
  "clickup_create_document",
  "clickup_list_document_pages",
  "clickup_get_document_pages",
  "clickup_create_document_page",
  "clickup_update_document_page",
  "clickup_get_task_time_in_status",
  "clickup_get_list_time_in_status",
];
// Task-ID follow-up endpoints cannot atomically honour a single home-List
// grant if an external ClickUp actor moves the task between preflight and use.
// Preserve all 48 registrations, but execute this subset only after the owner
// explicitly enables Workspace authority and exclusive one-Workspace OAuth.
const WORKSPACE_SCOPE_OPERATIONS = new Set([
  // These tools have Workspace-wide effects or return data outside the home List.
  "clickup_get_workspace_hierarchy",
  "clickup_get_folder",
  "clickup_create_list",
  "clickup_create_list_in_folder",
  "clickup_create_folder",
  "clickup_update_folder",
  "clickup_get_chat_channels",
  "clickup_send_chat_message",
  "clickup_create_document",
  "clickup_list_document_pages",
  "clickup_get_document_pages",
  "clickup_create_document_page",
  "clickup_update_document_page",
  "clickup_stop_time_tracking",
  "clickup_get_current_time_entry",
  // Single task GET validates its home List from the same response.
  "clickup_update_task",
  "clickup_set_custom_field",
  "clickup_delete_task",
  "clickup_attach_file_to_task",
  "clickup_update_bulk_tasks",
  "clickup_get_task_comments",
  "clickup_get_threaded_replies",
  "clickup_create_task_comment",
  "clickup_add_tag_to_task",
  "clickup_remove_tag_from_task",
  "clickup_add_task_link",
  "clickup_remove_task_link",
  "clickup_add_dependency",
  "clickup_remove_dependency",
  "clickup_move_task_to_list",
  "clickup_add_task_to_list",
  "clickup_get_task_time_entries",
  "clickup_start_time_tracking",
  "clickup_stop_time_tracking",
  "clickup_add_time_entry",
  "clickup_get_current_time_entry",
  "clickup_get_task_time_in_status",
  "clickup_get_list_time_in_status",
]);

export async function runCatalogOperation(
  name: string,
  a: Json,
  g: ReadGrant,
  f: typeof fetch,
): Promise<Json> {
  if (g.resourceScope !== "workspace" && WORKSPACE_SCOPE_OPERATIONS.has(name))
    throw new ReadFailure("CLICKUP_WORKSPACE_SCOPE_REQUIRED");
  const W = id(g.workspaceId),
    N = count(a);
  const workspaceScope = g.resourceScope === "workspace";
  const call = (method: Method, path: string, body?: Json) => send(g, f, method, path, body);
  const task = async (k: string) => taskInWorkspace(g, f, a[k]);
  const list = async (k: string) => listInWorkspace(g, f, a[k]);
  const folder = async (k: string) => folderInWorkspace(g, f, a[k]);
  // Only input-declared Workspace IDs can be supplied; they must match OAuth-bound Workspace.
  if (a["workspace_id"] !== undefined && String(a["workspace_id"]) !== g.workspaceId)
    throw new ReadFailure("CLICKUP_SCOPE_OR_SCHEMA_REJECTED");
  switch (name) {
    case "clickup_search_workspace": {
      const q = txt(a["query"], 240).toLowerCase();
      // Never search all Workspace tasks: the user may have more upstream rights
      // than this MCP's configured home-List grant permits.
      if (!workspaceScope) await listInWorkspace(g, f, g.listId);
      const results = await call(
        "GET",
        workspaceScope
          ? v2("team/" + W + "/task?page=0&subtasks=true&include_closed=true")
          : v2("list/" + id(g.listId) + "/task?page=0&subtasks=true&include_closed=true"),
      );
      if (!Array.isArray(results["tasks"])) throw new ReadFailure("CLICKUP_BAD_RESPONSE");
      const tasks = results["tasks"];
      // A ClickUp task can appear in additional Lists. Only expose its home-List
      // data under this one-List grant, and fail closed on incomplete metadata.
      for (const candidate of tasks) {
        const t = obj(candidate);
        if (!t || (!workspaceScope && String(obj(t["list"])?.["id"]) !== g.listId))
          throw new ReadFailure("CLICKUP_SCOPE_OR_SCHEMA_REJECTED");
      }
      const match = (v: unknown) => JSON.stringify(v).toLowerCase().includes(q);
      if (!workspaceScope) {
        // Never search Workspace Docs, Folders or unrelated Lists under a single-List grant.
        return {
          source: "clickup-api-v2",
          scope: "list",
          tasks: clip(tasks.filter(match).slice(0, N)),
          docs: [],
          lists: [],
          folders: [],
          incomplete: tasks.length >= 100 || tasks.filter(match).length > N,
        };
      }
      const docs = await call("GET", v3("workspaces/" + W + "/docs?limit=50"));
      if (!Array.isArray(docs["docs"])) throw new ReadFailure("CLICKUP_BAD_RESPONSE");
      const d = docs["docs"];
      const hierarchySpaces = await spaces(g, f);
      const foundLists: unknown[] = [];
      const foundFolders: unknown[] = [];
      // Bound hierarchy enumeration; explicitly disclose if the workspace is larger.
      for (const space of hierarchySpaces.slice(0, 5)) {
        const sid = id(space["id"]);
        const folderData = await call("GET", v2("space/" + sid + "/folder?archived=false"));
        const listData = await call("GET", v2("space/" + sid + "/list?archived=false"));
        if (!Array.isArray(folderData["folders"]) || !Array.isArray(listData["lists"]))
          throw new ReadFailure("CLICKUP_BAD_RESPONSE");
        foundFolders.push(...folderData["folders"]);
        foundLists.push(...listData["lists"]);
        for (const folder of folderData["folders"].slice(0, 10)) {
          const fid = obj(folder)?.["id"];
          if (fid === undefined) throw new ReadFailure("CLICKUP_BAD_RESPONSE");
          const childLists = await call("GET", v2("folder/" + id(fid) + "/list?archived=false"));
          if (!Array.isArray(childLists["lists"])) throw new ReadFailure("CLICKUP_BAD_RESPONSE");
          foundLists.push(...childLists["lists"]);
        }
      }
      return {
        source: "clickup-api",
        tasks: clip(tasks.filter(match).slice(0, N)),
        docs: clip(d.filter(match).slice(0, N)),
        lists: clip(foundLists.filter(match).slice(0, N)),
        folders: clip(foundFolders.filter(match).slice(0, N)),
        incomplete:
          tasks.length >= 100 ||
          d.length >= 50 ||
          hierarchySpaces.length > 5 ||
          foundLists.length > N ||
          foundFolders.length > N,
      };
    }
    case "clickup_search_tasks_by_type":
    case "clickup_search_tasks_by_tag": {
      const target = a["list_id"] ?? g.listId;
      if (!workspaceScope || a["list_id"] !== undefined) await listInWorkspace(g, f, target);
      const result = await call(
        "GET",
        workspaceScope && a["list_id"] === undefined
          ? v2("team/" + W + "/task?page=0&subtasks=true&include_closed=true")
          : v2(
              "list/" +
                id(target) +
                "/task?page=0&subtasks=true&include_closed=true" +
                (workspaceScope ? "&include_timl=true" : ""),
            ),
      );
      if (!Array.isArray(result["tasks"])) throw new ReadFailure("CLICKUP_BAD_RESPONSE");
      const tasks = result["tasks"];
      for (const candidate of tasks) {
        const t = obj(candidate);
        const homeList = obj(t?.["list"])?.["id"];
        if (
          !t ||
          (typeof homeList !== "number" && typeof homeList !== "string") ||
          !/^[1-9]\d{0,17}$/.test(String(homeList)) ||
          (!workspaceScope && String(homeList) !== g.listId)
        )
          throw new ReadFailure("CLICKUP_SCOPE_OR_SCHEMA_REJECTED");
      }
      const found = tasks.filter((x) => {
        const t = obj(x);
        if (!t) return false;
        return name.endsWith("by_type")
          ? String(t["custom_item_id"]) === String(a["task_type"])
          : Array.isArray(t["tags"]) &&
              t["tags"].some(
                (tag: unknown) =>
                  String(obj(tag)?.["name"]).toLowerCase() === String(a["tag"]).toLowerCase(),
              );
      });
      return {
        source: "clickup-api-v2",
        tasks: clip(found.slice(0, N)),
        incomplete: tasks.length >= 100 || found.length > N,
      };
    }
    case "clickup_create_task": {
      await list("list_id");
      const payload = taskBody(buildArgs(a, "new_task"));
      if (!payload["name"]) throw new ReadFailure("CLICKUP_INVALID_ARGUMENT");
      return short(
        await call("POST", v2("list/" + val(a, "list_id") + "/task"), {
          ...payload,
          notify_all: false,
        }),
      );
    }
    case "clickup_get_task":
      return short(await task("task_id"));
    case "clickup_update_task":
      await task("task_id");
      return short(
        await call("PUT", v2("task/" + val(a, "task_id")), taskBody(buildArgs(a, "changes"), true)),
      );
    case "clickup_set_custom_field": {
      await task("task_id");
      const field = buildArgs(a, "field_value");
      const allowed = new Set([
        "text",
        "number",
        "option_id",
        "selected_option_ids",
        "checked",
        "timestamp_ms",
      ]);
      if (Object.keys(field).length !== 1 || Object.keys(field).some((key) => !allowed.has(key)))
        throw new ReadFailure("CLICKUP_INVALID_ARGUMENT");
      const value =
        field["text"] ??
        field["number"] ??
        field["option_id"] ??
        field["selected_option_ids"] ??
        field["checked"] ??
        field["timestamp_ms"];
      if (value === undefined) throw new ReadFailure("CLICKUP_INVALID_ARGUMENT");
      if (
        ("number" in field && (typeof value !== "number" || !Number.isFinite(value))) ||
        ("text" in field && typeof value !== "string") ||
        ("checked" in field && typeof value !== "boolean") ||
        ("timestamp_ms" in field && (!Number.isSafeInteger(value) || Number(value) <= 0)) ||
        ("selected_option_ids" in field &&
          (!Array.isArray(value) || value.some((id) => typeof id !== "string")))
      )
        throw new ReadFailure("CLICKUP_INVALID_ARGUMENT");
      return short(
        await call("POST", v2("task/" + val(a, "task_id") + "/field/" + val(a, "field_id")), {
          value,
        }),
      );
    }
    case "clickup_delete_task":
      await task("task_id");
      return call("DELETE", v2("task/" + val(a, "task_id")));
    case "clickup_create_bulk_tasks": {
      await list("list_id");
      const tasks = a["tasks"];
      if (!Array.isArray(tasks) || tasks.length < 1 || tasks.length > 10)
        throw new ReadFailure("CLICKUP_INVALID_ARGUMENT");
      // Validate the ENTIRE batch before sending the first non-idempotent POST.
      // Otherwise a bad later draft creates a task and returns a bare error,
      // encouraging an accidental retry that duplicates the first task.
      const validated = tasks.map((draft) => {
        const item = obj(draft);
        if (!item) throw new ReadFailure("CLICKUP_INVALID_ARGUMENT");
        const payload = taskBody(item);
        if (!payload["name"]) throw new ReadFailure("CLICKUP_INVALID_ARGUMENT");
        return payload;
      });
      const outcome: unknown[] = [];
      for (let i = 0; i < validated.length; i++) {
        const payload = validated[i]!;
        try {
          outcome.push({
            index: i,
            success: true,
            response: clip(await call("POST", v2("list/" + val(a, "list_id") + "/task"), payload)),
          });
        } catch (e) {
          outcome.push({
            index: i,
            success: false,
            error: e instanceof ReadFailure ? e.code : "CLICKUP_UNAVAILABLE",
          });
          break;
        }
      }
      return {
        source: "clickup-api-v2",
        results: outcome,
        partial: outcome.some((x) => obj(x)?.["success"] === false),
      };
    }
    case "clickup_update_bulk_tasks": {
      const updates = a["task_updates"];
      if (!Array.isArray(updates) || updates.length < 1 || updates.length > 10)
        throw new ReadFailure("CLICKUP_INVALID_ARGUMENT");
      const validated = updates.map((draft) => {
        const x = obj(draft);
        if (!x) throw new ReadFailure("CLICKUP_INVALID_ARGUMENT");
        id(x["task_id"]);
        const changes = obj(x["changes"]);
        if (!changes || Object.keys(changes).length === 0)
          throw new ReadFailure("CLICKUP_INVALID_ARGUMENT");
        return { taskId: x["task_id"], changes: taskBody(changes, true) };
      });
      const outcome: unknown[] = [];
      for (let i = 0; i < validated.length; i++) {
        const x = validated[i]!;
        try {
          await taskInWorkspace(g, f, x.taskId);
          outcome.push({
            index: i,
            success: true,
            response: clip(await call("PUT", v2("task/" + id(x.taskId)), x.changes)),
          });
        } catch (e) {
          outcome.push({
            index: i,
            success: false,
            error: e instanceof ReadFailure ? e.code : "CLICKUP_UNAVAILABLE",
          });
          break;
        }
      }
      return {
        source: "clickup-api-v2",
        results: outcome,
        partial: outcome.some((x) => obj(x)?.["success"] === false),
      };
    }
    case "clickup_attach_file_to_task": {
      await task("task_id");
      return uploadAttachment(
        g,
        f,
        String(a["task_id"]),
        txt(a["file_name"], 120),
        txt(a["file_base64"], 700000),
        typeof a["media_type"] === "string" ? a["media_type"] : "application/octet-stream",
      );
    }
    case "clickup_get_task_comments":
      await task("task_id");
      return short(await call("GET", v2("task/" + val(a, "task_id") + "/comment")), N);
    case "clickup_get_threaded_replies": {
      await task("task_id");
      const comments = await call("GET", v2("task/" + val(a, "task_id") + "/comment"));
      if (!Array.isArray(comments["comments"])) throw new ReadFailure("CLICKUP_BAD_RESPONSE");
      const parentFound = comments["comments"].some(
        (comment: unknown) => String(obj(comment)?.["id"]) === String(a["comment_id"]),
      );
      // Only comments verifiably belonging to the validated task are eligible.
      // Older comments outside the first upstream page fail closed.
      if (!parentFound) throw new ReadFailure("CLICKUP_SCOPE_OR_SCHEMA_REJECTED");
      return short(await call("GET", v2("comment/" + val(a, "comment_id") + "/reply")), N);
    }
    case "clickup_create_task_comment":
      await task("task_id");
      return call("POST", v2("task/" + val(a, "task_id") + "/comment"), {
        comment_text: txt(a["text"], 6000),
        notify_all: false,
      });
    case "clickup_add_tag_to_task":
      await task("task_id");
      return call(
        "POST",
        v2("task/" + val(a, "task_id") + "/tag/" + encodeURIComponent(txt(a["tag"], 160))),
      );
    case "clickup_remove_tag_from_task":
      await task("task_id");
      return call(
        "DELETE",
        v2("task/" + val(a, "task_id") + "/tag/" + encodeURIComponent(txt(a["tag"], 160))),
      );
    case "clickup_add_task_link":
    case "clickup_remove_task_link":
      await task("task_id");
      await task("other_task_id");
      return call(
        name.includes("remove") ? "DELETE" : "POST",
        v2("task/" + val(a, "task_id") + "/link/" + val(a, "other_task_id")),
      );
    case "clickup_add_dependency":
    case "clickup_remove_dependency": {
      await task("blocking_task_id");
      await task("waiting_task_id");
      if (name === "clickup_remove_dependency")
        return call(
          "DELETE",
          v2(
            "task/" +
              val(a, "waiting_task_id") +
              "/dependency?depends_on=" +
              val(a, "blocking_task_id"),
          ),
        );
      return call("POST", v2("task/" + val(a, "waiting_task_id") + "/dependency"), {
        depends_on: a["blocking_task_id"],
      });
    }
    case "clickup_move_task_to_list": {
      const moving = await task("task_id");
      if (String(obj(moving["list"])?.["id"]) !== String(a["source_list_id"]))
        throw new ReadFailure("CLICKUP_SCOPE_OR_SCHEMA_REJECTED");
      await list("source_list_id");
      await list("destination_list_id");
      return call(
        "PUT",
        v3(
          "workspaces/" +
            W +
            "/tasks/" +
            val(a, "task_id") +
            "/home_list/" +
            val(a, "destination_list_id"),
        ),
        { move_custom_fields: false },
      );
    }
    case "clickup_add_task_to_list":
      await task("task_id");
      await list("destination_list_id");
      return call(
        "POST",
        v2("list/" + val(a, "destination_list_id") + "/task/" + val(a, "task_id")),
      );
    case "clickup_get_task_time_entries":
      await task("task_id");
      return short(
        await call("GET", v2("team/" + W + "/time_entries?task_id=" + val(a, "task_id"))),
        N,
      );
    case "clickup_get_time_entries_for_tasks":
      await list("list_id");
      return short(
        await call("GET", v2("team/" + W + "/time_entries?list_id=" + val(a, "list_id"))),
        N,
      );
    case "clickup_start_time_tracking":
      await task("task_id");
      return call("POST", v2("team/" + W + "/time_entries/start"), { tid: a["task_id"] });
    case "clickup_stop_time_tracking":
      return call("POST", v2("team/" + W + "/time_entries/stop"));
    case "clickup_add_time_entry":
      await task("task_id");
      return call("POST", v2("team/" + W + "/time_entries"), {
        tid: a["task_id"],
        start: a["start_ms"],
        duration: a["duration_ms"],
      });
    case "clickup_get_current_time_entry":
      return call("GET", v2("team/" + W + "/time_entries/current"));
    case "clickup_get_workspace_hierarchy": {
      const sp = await spaces(g, f);
      const results: unknown[] = [];
      for (const space of sp.slice(0, Math.min(N, 10))) {
        const sid = id(space["id"]);
        const fs = await call("GET", v2("space/" + sid + "/folder?archived=false"));
        const ls = await call("GET", v2("space/" + sid + "/list?archived=false"));
        results.push({
          space: clip(space),
          folders: clip(fs["folders"]),
          lists: clip(ls["lists"]),
        });
      }
      return {
        source: "clickup-api-v2",
        workspace_id: g.workspaceId,
        spaces: results,
        incomplete: sp.length > Math.min(N, 10),
      };
    }
    case "clickup_create_list": {
      if (a["folder_id"] !== undefined) {
        await folder("folder_id");
        return call("POST", v2("folder/" + val(a, "folder_id") + "/list"), {
          name: txt(a["name"], 180),
        });
      }
      await inWorkspace(g, f, a["space_id"]);
      return call("POST", v2("space/" + val(a, "space_id") + "/list"), {
        name: txt(a["name"], 180),
      });
    }
    case "clickup_create_list_in_folder":
      await folder("folder_id");
      return call("POST", v2("folder/" + val(a, "folder_id") + "/list"), {
        name: txt(a["name"], 180),
      });
    case "clickup_get_list":
      return short(await list("list_id"));
    case "clickup_update_list":
      await list("list_id");
      return call("PUT", v2("list/" + val(a, "list_id")), {
        name: txt(a["name"], 180),
        ...(a["description"] ? { content: txt(a["description"]) } : {}),
      });
    case "clickup_get_folder":
      return short(await folder("folder_id"));
    case "clickup_create_folder":
      await inWorkspace(g, f, a["space_id"]);
      return call("POST", v2("space/" + val(a, "space_id") + "/folder"), {
        name: txt(a["name"], 180),
      });
    case "clickup_update_folder":
      await folder("folder_id");
      return call("PUT", v2("folder/" + val(a, "folder_id")), { name: txt(a["name"], 180) });
    case "clickup_get_workspace_members":
      return {
        source: "clickup-api-v2",
        workspace_id: g.workspaceId,
        members: clip((await members(g, f)).slice(0, N)),
      };
    case "clickup_find_member_by_name": {
      const q = txt(a["email_or_name"], 160).toLowerCase();
      const found = (await members(g, f)).filter(
        (x) =>
          String(x["username"] ?? x["email"] ?? "")
            .toLowerCase()
            .includes(q) ||
          String(x["email"] ?? "")
            .toLowerCase()
            .includes(q),
      );
      return {
        source: "clickup-api-v2",
        matches: clip(found.slice(0, 50)),
        ambiguous: found.length !== 1,
      };
    }
    case "clickup_resolve_assignees": {
      const people = a["people"];
      if (!Array.isArray(people) || people.length > 12)
        throw new ReadFailure("CLICKUP_INVALID_ARGUMENT");
      const users = await members(g, f);
      return {
        source: "clickup-api-v2",
        results: people.map((x) => {
          const q = txt(x, 160).toLowerCase();
          const hits = users.filter(
            (u) =>
              String(u["email"] ?? "").toLowerCase() === q ||
              String(u["username"] ?? "").toLowerCase() === q,
          );
          return { query: x, matches: clip(hits), ambiguous: hits.length !== 1 };
        }),
      };
    }
    case "clickup_get_chat_channels":
      return short(
        await call("GET", v3("workspaces/" + W + "/chat/channels?limit=" + Math.min(N, 50))),
        N,
      );
    case "clickup_send_chat_message":
      return call(
        "POST",
        v3("workspaces/" + W + "/chat/channels/" + val(a, "channel_id") + "/messages"),
        { type: "message", content: txt(a["text"], 6000) },
      );
    case "clickup_create_document": {
      const body: Json = { name: txt(a["name"], 180), create_page: true };
      if (a["folder_id"] !== undefined) {
        await folder("folder_id");
        body["parent"] = { id: String(a["folder_id"]), type: "FOLDER" };
      }
      return call("POST", v3("workspaces/" + W + "/docs"), body);
    }
    case "clickup_list_document_pages":
      return short(
        await call(
          "GET",
          v3(
            "workspaces/" + W + "/docs/" + val(a, "document_id") + "/page_listing?max_page_depth=4",
          ),
        ),
      );
    case "clickup_get_document_pages":
      return short(
        await call(
          "GET",
          v3(
            "workspaces/" +
              W +
              "/docs/" +
              val(a, "document_id") +
              "/pages/" +
              val(a, "page_id") +
              "?content_format=text%2Fmd",
          ),
        ),
      );
    case "clickup_create_document_page":
      return call("POST", v3("workspaces/" + W + "/docs/" + val(a, "document_id") + "/pages"), {
        name: txt(a["name"], 180),
        content: typeof a["doc_content"] === "string" ? a["doc_content"] : "",
        content_format: "text/md",
      });
    case "clickup_update_document_page":
      return call(
        "PUT",
        v3("workspaces/" + W + "/docs/" + val(a, "document_id") + "/pages/" + val(a, "page_id")),
        {
          content: txt(a["doc_content"], 12000),
          content_edit_mode: "replace",
          content_format: "text/md",
        },
      );
    case "clickup_get_task_time_in_status":
      await task("task_id");
      return short(await call("GET", v2("task/" + val(a, "task_id") + "/time_in_status")));
    case "clickup_get_list_time_in_status": {
      await list("list_id");
      const tasks = await call(
        "GET",
        v2("list/" + val(a, "list_id") + "/task?page=0&subtasks=false&include_closed=true"),
      );
      const ids = Array.isArray(tasks["tasks"])
        ? tasks["tasks"]
            .slice(0, N)
            .map((x) => obj(x)?.["id"])
            .filter((x) => x !== undefined)
            .map(id)
        : [];
      if (ids.length === 0) return { source: "clickup-api-v2", tasks: [] };
      const params = ids.map((x) => "task_ids=" + x).join("&");
      return short(await call("GET", v2("task/bulk_time_in_status/task_ids?" + params)));
    }
    default:
      throw new ReadFailure("CLICKUP_TOOL_NOT_IMPLEMENTED");
  }
}
