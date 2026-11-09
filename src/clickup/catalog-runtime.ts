import { quotaCall } from "./client.js";
import { compileClickUpRichSegments, compareRichCommentReadback } from "./comment-rich.js";
import { verifySharedListWorkspace } from "./operations.js";
import { COMPANY_LIST_TASK_OPERATIONS, ReadFailure, type ReadGrant } from "./policy.js";

/** REST-backed ClickUp tool catalogue. No extra approval controls, state journal,
 * rollback engine or background watcher. ClickUp itself owns all task history.
 * The calling human's own OAuth identity is the ONLY upstream actor. */
type Json = Record<string, unknown>;
type Method = "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
type ResponseMode = "strict" | "empty-write-ack" | "document-page-list";
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
/** clip() bounds every nested array to 50; disclose when Doc children are also clipped. */
const hasClippedNestedArray = (value: unknown): boolean => {
  const pending: unknown[] = [value];
  for (let i = 0; i < pending.length; i++) {
    if (i >= 10_000) return true;
    const item = pending[i];
    if (Array.isArray(item)) {
      if (item.length > 50) return true;
      pending.push(...item);
    } else {
      const record = obj(item);
      if (record) pending.push(...Object.values(record));
    }
  }
  return false;
};
/** Require real per-task time data, not an empty or pagination-only response. */
const hasTimeInStatus = (value: unknown): boolean => {
  const record = obj(value);
  return (
    record !== null &&
    (obj(record["current_status"]) !== null || Array.isArray(record["status_history"]))
  );
};
const clip = (v: unknown, field = ""): unknown => {
  // Rich comment bodies can have up to 100 independently formatted segments.
  // Preserve existing 50-item limits for unrelated nested metadata arrays.
  if (Array.isArray(v)) return v.slice(0, field === "comment" ? 100 : 50).map((x) => clip(x));
  const item = obj(v);
  if (item)
    return Object.fromEntries(
      Object.entries(item)
        .filter(([k]) => !/token|secret|authorization|password/i.test(k))
        .map(([k, x]) => [k, clip(x, k)]),
    );
  if (typeof v === "string") return v.slice(0, 40_000);
  return v;
};
/** Signal when a bounded API response lost string content, including nested data. */
const hasClippedText = (value: unknown): boolean => {
  const pending: unknown[] = [value];
  for (let i = 0; i < pending.length; i++) {
    if (i >= 10_000) return true;
    const item = pending[i];
    if (typeof item === "string" && item.length > 40_000) return true;
    if (Array.isArray(item)) pending.push(...item);
    else {
      const record = obj(item);
      if (record) pending.push(...Object.values(record));
    }
  }
  return false;
};
/**
 * ClickUp Docs can insert backslashes around standalone text brackets.
 * Do not equate this with unchanged Markdown: links, code, tables, lists,
 * headings, references and embedded syntax may change meaning when escaped.
 * This is a narrow allowlist for independently observed plain-text annotations.
 */
function plainBracketEscapesOnly(requested: string, stored: string): boolean {
  // The only accepted provider normalization is one complete, standalone,
  // plain-text annotation line such as [QA note] -> \[QA note\].
  // Any Markdown syntax or other difference remains an uncertain write.
  const source = requested.split("\n");
  const readback = stored.split("\n");
  if (source.length !== readback.length || source.length > 2) return false;
  // A bracketed line is safe only as the FINAL, isolated annotation.
  // Context after it could make it a Setext heading; context before it
  // could make it a lazy continuation of a list. Permit at most one
  // demonstrably plain prose lead-in line (starting with a letter).
  if (source.length === 2 && !/^[A-Za-z][A-Za-z0-9 .,;:!?/-]{0,180}$/.test(source[0]!))
    return false;
  if (!source[source.length - 1]?.startsWith("[")) return false;
  let confirmed = 0;
  for (let i = 0; i < source.length; i++) {
    const line = source[i]!;
    const actual = readback[i]!;
    if (
      line.includes("\\") ||
      line.includes(String.fromCharCode(96)) ||
      line.includes("*") ||
      line.includes("_") ||
      line.includes("|") ||
      line.includes("<") ||
      line.includes(">") ||
      line.includes("#") ||
      line.includes("!") ||
      line.includes("(") ||
      line.includes(")") ||
      line.includes("{") ||
      line.includes("}") ||
      line.includes("~") ||
      line.includes("[") !== line.includes("]")
    )
      return false;
    if (line === actual) {
      // A second Markdown annotation, even unchanged, makes the document
      // context ambiguous. No normalization claim in this case.
      if (line.includes("[") || line.includes("]")) return false;
      continue;
    }
    if (
      confirmed !== 0 ||
      line.length < 3 ||
      line.length > 242 ||
      !line.startsWith("[") ||
      !line.endsWith("]")
    )
      return false;
    const label = line.slice(1, -1);
    if (!label.trim() || label.includes("[") || label.includes("]")) return false;
    for (const character of label) {
      const code = character.charCodeAt(0);
      const letter = (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
      const digit = code >= 48 && code <= 57;
      if (!letter && !digit && !"- ;:.,?/".includes(character)) return false;
    }
    if (actual !== "\\[" + label + "\\]") return false;
    confirmed++;
  }
  return confirmed === 1;
}

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
/** Read untrusted upstream JSON within a strict byte budget; cancel large streams. */
async function readBoundedJsonBody(
  response: Response,
  overflowCode: string,
  maxBytes = 1_000_000,
): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      if (size + part.value.byteLength > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new ReadFailure(overflowCode);
      }
      chunks.push(part.value);
      size += part.value.byteLength;
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder().decode(bytes);
  } finally {
    reader.releaseLock();
  }
}
async function send(
  grant: ReadGrant,
  fetcher: typeof fetch,
  method: Method,
  path: string,
  body?: Json,
  responseMode: ResponseMode = "strict",
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
      if (method === "DELETE" || responseMode === "empty-write-ack")
        return { success: true, source: "clickup-api", response_empty: true };
      throw new ReadFailure(
        method === "GET" ? "CLICKUP_BAD_RESPONSE" : "CLICKUP_WRITE_OUTCOME_UNKNOWN",
      );
    }
    const t = res.headers.get("content-type") ?? "";
    const length = res.headers.get("content-length");
    if (
      !t.includes("application/json") ||
      (length !== null && (!/^[0-9]+$/.test(length) || Number(length) > 1_000_000))
    ) {
      await res.body?.cancel().catch(() => undefined);
      throw new ReadFailure(
        method === "GET" ? "CLICKUP_BAD_RESPONSE" : "CLICKUP_WRITE_OUTCOME_UNKNOWN",
      );
    }
    // Do not use res.text(): it can allocate unbounded memory when an upstream
    // omits Content-Length and streams more than the response limit.
    const text = await readBoundedJsonBody(
      res,
      method === "GET" ? "CLICKUP_BAD_RESPONSE" : "CLICKUP_WRITE_OUTCOME_UNKNOWN",
    );
    const result: unknown = JSON.parse(text);
    // ClickUp v3 Docs page_listing returns a top-level array, unlike most REST routes.
    const data =
      responseMode === "document-page-list" && Array.isArray(result)
        ? { pages: result }
        : obj(result);
    if (!data)
      throw new ReadFailure(
        method === "GET" ? "CLICKUP_BAD_RESPONSE" : "CLICKUP_WRITE_OUTCOME_UNKNOWN",
      );
    if (method !== "GET" && method !== "DELETE" && Object.keys(data).length === 0) {
      if (responseMode === "empty-write-ack")
        return { success: true, source: "clickup-api", response_empty: true };
      throw new ReadFailure("CLICKUP_WRITE_OUTCOME_UNKNOWN");
    }
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
  try {
    await inWorkspace(grant, f, obj(list["space"])?.["id"]);
  } catch (error) {
    if (!(error instanceof ReadFailure) || error.code !== "CLICKUP_SCOPE_OR_SCHEMA_REJECTED")
      throw error;
    // Shared-with-me members can lack Space ancestry. Accept only the
    // *configured* List if ClickUp's Workspace-scoped shared hierarchy proves it.
    await verifySharedListWorkspace(grant, f, String(listId));
  }
  return list;
}
async function taskInWorkspace(grant: ReadGrant, f: typeof fetch, taskId: unknown): Promise<Json> {
  const task = await send(
    grant,
    f,
    "GET",
    v2("task/" + id(taskId) + "?include_markdown_description=true"),
  );
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
/** Only use authoritative task GET assignee objects to compute removals. */
const taskAssigneeIds = (task: Json): number[] => {
  const assignees = task["assignees"];
  if (!Array.isArray(assignees) || assignees.length > 100)
    throw new ReadFailure("CLICKUP_BAD_RESPONSE");
  const ids = assignees.map((entry) => {
    const user = obj(entry);
    const raw = user?.["id"];
    if (
      (typeof raw !== "string" && typeof raw !== "number") ||
      !/^[0-9]{1,24}$/.test(String(raw)) ||
      !Number.isSafeInteger(Number(raw)) ||
      Number(raw) <= 0
    )
      throw new ReadFailure("CLICKUP_BAD_RESPONSE");
    return Number(raw);
  });
  if (new Set(ids).size !== ids.length) throw new ReadFailure("CLICKUP_BAD_RESPONSE");
  return ids;
};
const taskBody = (a: Json, update = false, currentTask?: Json): Json => {
  const permitted = new Set([
    "name",
    "description",
    "description_markdown",
    "status",
    "priority",
    "due_date_ms",
    "assignee_ids",
  ]);
  if (Object.keys(a).some((key) => !permitted.has(key)))
    throw new ReadFailure("CLICKUP_INVALID_ARGUMENT");
  if (a["description"] !== undefined && a["description_markdown"] !== undefined)
    throw new ReadFailure("CLICKUP_INVALID_ARGUMENT");
  for (const key of ["name", "description", "description_markdown", "status"] as const) {
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
  // MCP clients advertise ClickUp member IDs as decimal strings. Preserve
  // compatibility with integer IDs in direct legacy calls, but never send
  // unvalidated or nonnumeric IDs to ClickUp.
  if (
    assignees !== undefined &&
    (!Array.isArray(assignees) ||
      assignees.length > 12 ||
      assignees.some(
        (user) =>
          (typeof user !== "string" && typeof user !== "number") ||
          !/^[0-9]{1,24}$/.test(String(user)) ||
          !Number.isSafeInteger(Number(user)) ||
          Number(user) <= 0,
      ))
  )
    throw new ReadFailure("CLICKUP_INVALID_ARGUMENT");
  const memberIds = Array.isArray(assignees) ? assignees.map((user) => Number(user)) : null;
  if (memberIds !== null && new Set(memberIds).size !== memberIds.length)
    throw new ReadFailure("CLICKUP_INVALID_ARGUMENT");
  // Update Task accepts { add, rem }, not a replacement array. Compute both
  // against the scoped, freshly fetched task; never silently add only.
  const existing = memberIds !== null && update ? taskAssigneeIds(currentTask ?? {}) : [];
  const assigneeChange =
    memberIds === null
      ? null
      : update
        ? {
            add: memberIds.filter((user) => !existing.includes(user)),
            rem: existing.filter((user) => !memberIds.includes(user)),
          }
        : memberIds;
  return {
    ...(a["name"] !== undefined ? { name: txt(a["name"], 180) } : {}),
    ...(a["description"] !== undefined ? { description: txt(a["description"]) } : {}),
    ...(a["description_markdown"] !== undefined
      ? { markdown_content: txt(a["description_markdown"], 40_000) }
      : {}),
    ...(a["status"] !== undefined ? { status: txt(a["status"], 80) } : {}),
    ...(a["priority"] !== undefined ? { priority: a["priority"] } : {}),
    ...(a["due_date_ms"] !== undefined ? { due_date: a["due_date_ms"], due_date_time: true } : {}),
    ...(assigneeChange !== null ? { assignees: assigneeChange } : {}),
  };
};
/** ClickUp v2 List endpoints accept content OR markdown_content, not both. */
function listDescriptionBody(a: Json): Json {
  if (a["description"] !== undefined && a["description_markdown"] !== undefined)
    throw new ReadFailure("CLICKUP_INVALID_ARGUMENT");
  if (a["description_markdown"] !== undefined)
    return { markdown_content: txt(a["description_markdown"], 40_000) };
  if (a["description"] !== undefined) return { content: txt(a["description"], 8000) };
  return {};
}

/** Docs may be created without content; an explicit invalid/oversize payload is rejected before any write. */
function validatedDocPageContent(a: Json): string {
  const value = a["doc_content"];
  if (value === undefined) return "";
  if (typeof value !== "string" || value.length > 40_000)
    throw new ReadFailure("CLICKUP_INVALID_ARGUMENT");
  return value;
}

/** ClickUp v3 Docs and Chat define these two exact content formats. */
function validatedContentFormat(a: Json): "text/md" | "text/plain" {
  const value = a["content_format"] ?? "text/md";
  if (value !== "text/md" && value !== "text/plain")
    throw new ReadFailure("CLICKUP_INVALID_ARGUMENT");
  return value;
}
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

/** Never accept a model-supplied member name or unverified Workspace user ID for a comment assignment. */
async function verifiedCommentAssignee(
  value: unknown,
  grant: ReadGrant,
  fetcher: typeof fetch,
): Promise<number> {
  if (
    typeof value !== "string" ||
    !/^[1-9]\d{0,15}$/.test(value) ||
    !Number.isSafeInteger(Number(value))
  )
    throw new ReadFailure("CLICKUP_INVALID_ARGUMENT");
  const eligible = await members(grant, fetcher);
  if (!eligible.some((user) => String(user["id"]) === value))
    throw new ReadFailure("CLICKUP_SCOPE_OR_SCHEMA_REJECTED");
  return Number(value);
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
    "pages",
  ];
  const arrays = keys.filter((k) => Array.isArray(d[k]));
  const truncated = arrays.some((k) => (d[k] as unknown[]).length > limit);
  // ClickUp's first comments page can contain 25; reaching it suggests older
  // pages may exist even if no item was discarded by the display cap.
  const possibleMorePages = Array.isArray(d["comments"]) && d["comments"].length >= 25;
  const nestedPagesClipped = Array.isArray(d["pages"]) && hasClippedNestedArray(d["pages"]);
  const richCommentsClipped =
    Array.isArray(d["comments"]) &&
    d["comments"].some((entry) => {
      const spans = obj(entry)?.["comment"];
      return Array.isArray(spans) && spans.length > 100;
    });
  return clip({
    ...d,
    ...Object.fromEntries(arrays.map((k) => [k, (d[k] as unknown[]).slice(0, limit)])),
    incomplete:
      truncated ||
      nestedPagesClipped ||
      possibleMorePages ||
      hasClippedText(d) ||
      richCommentsClipped ||
      d["incomplete"] === true,
    first_page_only: true,
  }) as Json;
};

type CommentCursor = Readonly<{ start: number; startId: string }>;

/** ClickUp v2 uses the oldest visible comment's date AND ID as one cursor. */
function inputCommentCursor(a: Json): CommentCursor | null {
  const start = a["comment_start"];
  const startId = a["comment_start_id"];
  if (start === undefined && startId === undefined) return null;
  if (
    !Number.isSafeInteger(start) ||
    Number(start) <= 0 ||
    Number(start) > 9_000_000_000_000 ||
    typeof startId !== "string" ||
    !/^[A-Za-z0-9_-]{1,100}$/.test(startId)
  )
    throw new ReadFailure("CLICKUP_INVALID_ARGUMENT");
  return { start: Number(start), startId };
}
function commentCursorFrom(comment: Json): CommentCursor | null {
  const date = comment["date"];
  const commentId = comment["id"];
  if (
    (typeof date !== "number" && typeof date !== "string") ||
    !/^\d{1,13}$/.test(String(date)) ||
    !Number.isSafeInteger(Number(date)) ||
    Number(date) <= 0 ||
    Number(date) > 9_000_000_000_000 ||
    typeof commentId !== "string" ||
    !/^[A-Za-z0-9_-]{1,100}$/.test(commentId)
  )
    return null;
  return { start: Number(date), startId: commentId };
}
async function taskCommentPage(
  read: (path: string) => Promise<Json>,
  taskId: string,
  cursor: CommentCursor | null,
): Promise<Json[]> {
  const params = new URLSearchParams();
  if (cursor !== null) {
    params.set("start", String(cursor.start));
    params.set("start_id", cursor.startId);
  }
  const path = v2("task/" + id(taskId) + "/comment" + (cursor ? "?" + params.toString() : ""));
  const result = await read(path);
  if (
    !Array.isArray(result["comments"]) ||
    result["comments"].length > 25 ||
    result["comments"].some((entry: unknown) => {
      const comment = obj(entry);
      return !comment || typeof comment["id"] !== "string";
    })
  )
    throw new ReadFailure("CLICKUP_BAD_RESPONSE");
  return result["comments"] as Json[];
}

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
  return uploadAttachmentBytes(grant, fetcher, taskId, filename, data, mime);
}

/** Inspect only a tiny rejected-upload response; never buffer unlimited 4xx bodies. */
async function attachmentRejectCode(response: Response): Promise<string> {
  const stream = response.body;
  if (!stream) return "";
  const declared = response.headers.get("content-length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > 2048)) {
    await stream.cancel().catch(() => undefined);
    return "";
  }
  const reader = stream.getReader();
  const bytes = new Uint8Array(2048);
  let used = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      if (used + next.value.byteLength > bytes.byteLength) {
        await reader.cancel().catch(() => undefined);
        return "";
      }
      bytes.set(next.value, used);
      used += next.value.byteLength;
    }
    const parsed = obj(JSON.parse(new TextDecoder().decode(bytes.subarray(0, used))));
    const candidate = parsed?.["ECODE"] ?? parsed?.["ecode"];
    return typeof candidate === "string" && /^[A-Z][A-Z0-9_]{2,40}$/.test(candidate)
      ? "_" + candidate
      : "";
  } catch {
    await reader.cancel().catch(() => undefined);
    return "";
  } finally {
    reader.releaseLock();
  }
}

/** Upload an already-loaded, bounded attachment without a model-facing Base64 payload. */
export async function uploadAttachmentBytes(
  grant: ReadGrant,
  fetcher: typeof fetch,
  taskId: string,
  filename: string,
  data: Uint8Array,
  mime: string,
): Promise<Json> {
  if (
    !/^[a-zA-Z0-9._ ()-]{1,120}$/.test(filename) ||
    filename === "." ||
    filename === ".." ||
    !/^[a-zA-Z0-9.+-]+\/[a-zA-Z0-9.+-]+$/.test(mime) ||
    data.byteLength < 1 ||
    data.byteLength > 8 * 1024 * 1024
  )
    throw new ReadFailure("CLICKUP_INVALID_ARGUMENT");
  // The task home List is validated immediately before every upload POST,
  // including the binary file-aware route and the legacy Base64 route.
  await taskInWorkspace(grant, fetcher, taskId);
  const uploadBytes = new Uint8Array(data.byteLength);
  uploadBytes.set(data);
  const form = new FormData();
  // ClickUp's v2 endpoint reports UPLOAD_002 ("Incorrect filename") for
  // attachment[0] in some single-file uploads despite the array documentation.
  // The production-compatible single-file field is the unindexed "attachment".
  form.append("attachment", new Blob([uploadBytes], { type: mime }), filename);
  await quotaCall(grant, "reserve");
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), 10000);
  try {
    const res = await fetcher("https://api.clickup.com/api/v2/task/" + id(taskId) + "/attachment", {
      method: "POST",
      redirect: "manual",
      signal: abort.signal,
      // Let the runtime set multipart Content-Type including boundary; do not
      // add an Accept header on this legacy ClickUp upload endpoint.
      headers: { Authorization: grant.apiToken },
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
    if (!res.ok) {
      // A definitively rejected 4xx upload is different from an ambiguous
      // timeout/5xx. Surface only the status and a strictly validated ClickUp
      // ECODE, never the server message, filename, token or response headers.
      if (res.status >= 500 || res.status === 408 || res.status === 425)
        throw new ReadFailure("CLICKUP_WRITE_OUTCOME_UNKNOWN");
      const ecode = await attachmentRejectCode(res);
      throw new ReadFailure("CLICKUP_ATTACHMENT_HTTP_" + res.status + ecode);
    }
    // Only an authoritative response ID correlates this upload to this request.
    // A matching filename seen later may belong to another concurrent writer.
    const content = await res.text();
    if (content.length > 1000000) throw new ReadFailure("CLICKUP_WRITE_OUTCOME_UNKNOWN");
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      throw new ReadFailure("CLICKUP_WRITE_OUTCOME_UNKNOWN");
    }
    const attachment = obj(parsed);
    if (!attachment || typeof attachment["id"] !== "string" || !attachment["id"])
      throw new ReadFailure("CLICKUP_WRITE_OUTCOME_UNKNOWN");
    return clip(attachment) as Json;
  } catch (error) {
    if (error instanceof ReadFailure) throw error;
    // Do not retry uploads following a timeout or an ambiguous response.
    throw new ReadFailure("CLICKUP_WRITE_OUTCOME_UNKNOWN");
  } finally {
    clearTimeout(timeout);
  }
}

/** Scope-bound checklist identity. No checklist ID alone grants a write. */
function authorizedTaskChecklist(task: Json, checklistId: unknown): Json {
  const items = task["checklists"];
  if (!Array.isArray(items) || items.length > 250)
    throw new ReadFailure("CLICKUP_SCOPE_OR_SCHEMA_REJECTED");
  const found = items.map(obj).find((checklist) => checklist?.["id"] === checklistId);
  if (!found || String(found["task_id"]) !== String(task["id"]))
    throw new ReadFailure("CLICKUP_SCOPE_OR_SCHEMA_REJECTED");
  return found;
}
function checklistId(value: unknown): string {
  if (typeof value !== "string" || !/^[a-fA-F0-9-]{8,80}$/.test(value))
    throw new ReadFailure("CLICKUP_INVALID_ARGUMENT");
  return id(value);
}

/** Opaque v3 cursor input; never use cursor content as a route or a token. */
function boundedV3Cursor(value: unknown): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_~+/=:.%-]{1,500}$/.test(value))
    throw new ReadFailure("CLICKUP_INVALID_ARGUMENT");
  return value;
}
function nextV3Cursor(response: Json): string | null {
  const candidate = response["next_cursor"] ?? obj(response["pagination"])?.["next_cursor"];
  if (candidate === null || candidate === undefined) return null;
  if (typeof candidate !== "string" || !/^[a-zA-Z0-9_~+/=:.%-]{1,500}$/.test(candidate))
    throw new ReadFailure("CLICKUP_BAD_RESPONSE");
  return candidate;
}
/** A Chat channel must be resolved through the OAuth-bound Workspace path. */
async function verifiedChatChannel(
  grant: ReadGrant,
  fetcher: typeof fetch,
  channelId: unknown,
): Promise<Json> {
  const key = id(channelId);
  const response = await send(
    grant, fetcher, "GET",
    v3("workspaces/" + id(grant.workspaceId) + "/chat/channels/" + key),
  );
  const channel = obj(response["channel"]) ?? response;
  if (String(channel["id"]) !== String(channelId))
    throw new ReadFailure("CLICKUP_SCOPE_OR_SCHEMA_REJECTED");
  if (
    (channel["workspace_id"] !== undefined &&
      String(channel["workspace_id"]) !== grant.workspaceId) ||
    (obj(channel["workspace"])?.["id"] !== undefined &&
      String(obj(channel["workspace"])?.["id"]) !== grant.workspaceId)
  ) throw new ReadFailure("CLICKUP_SCOPE_OR_SCHEMA_REJECTED");
  return channel;
}

export const OPERATIONAL_CATALOG_NAMES: readonly string[] = [
  "clickup_filter_tasks",
  "clickup_get_my_tasks",
  "clickup_get_custom_task_types",
  "clickup_get_task_templates",
  "clickup_create_task_from_template",
  "clickup_search_workspace",
  "clickup_search_tasks_by_type",
  "clickup_search_tasks_by_tag",
  "clickup_create_task",
  "clickup_get_task",
  "clickup_create_task_checklist",
  "clickup_create_checklist_item",
  "clickup_update_checklist_item",
  "clickup_get_list_views",
  "clickup_get_workspace_views",
  "clickup_get_view_tasks",
  "clickup_update_task",
  "clickup_set_custom_field",
  "clickup_delete_task",
  "clickup_attach_file_to_task",
  "clickup_create_bulk_tasks",
  "clickup_update_bulk_tasks",
  "clickup_get_task_comments",
  "clickup_read_task_pdf",
  "clickup_get_threaded_replies",
  "clickup_create_task_comment",
  "clickup_delete_task_comment",
  "clickup_edit_task_comment",
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
  "clickup_get_chat_channel_messages",
  "clickup_get_chat_message_replies",
  "clickup_search_documents",
  "clickup_send_chat_message",
  "clickup_create_document",
  "clickup_list_document_pages",
  "clickup_get_document_pages",
  "clickup_create_document_page",
  "clickup_update_document_page",
  "clickup_get_task_time_in_status",
  "clickup_get_list_time_in_status",
];
// Ordinary staging List grants retain the original Workspace-only policy.
// The explicit company read/write mode permits normal task-ID modifications
// after a same-Workspace, exact-home-List preflight. Other Workspace-wide
// operations remain blocked. ClickUp owns task history and enforces its ACL.
const WORKSPACE_SCOPE_OPERATIONS = new Set([
  // These tools have Workspace-wide effects or return data outside the home List.
  "clickup_get_workspace_hierarchy",
  "clickup_get_custom_task_types",
  "clickup_get_task_templates",
  "clickup_create_task_from_template",
  "clickup_get_workspace_views",
  "clickup_get_folder",
  "clickup_create_list",
  "clickup_create_list_in_folder",
  "clickup_create_folder",
  "clickup_update_folder",
  "clickup_get_chat_channels",
  "clickup_get_chat_channel_messages",
  "clickup_get_chat_message_replies",
  "clickup_search_documents",
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
  "clickup_create_task_checklist",
  "clickup_create_checklist_item",
  "clickup_update_checklist_item",
  "clickup_read_task_pdf",
  "clickup_get_threaded_replies",
  "clickup_create_task_comment",
  "clickup_delete_task_comment",
  "clickup_edit_task_comment",
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
  if (
    g.resourceScope !== "workspace" &&
    WORKSPACE_SCOPE_OPERATIONS.has(name) &&
    !(g.companyListTaskAccess === true && COMPANY_LIST_TASK_OPERATIONS.has(name))
  )
    throw new ReadFailure("CLICKUP_WORKSPACE_SCOPE_REQUIRED");
  const W = id(g.workspaceId),
    N = count(a);
  const workspaceScope = g.resourceScope === "workspace";
  const call = (method: Method, path: string, body?: Json, responseMode: ResponseMode = "strict") =>
    send(g, f, method, path, body, responseMode);
  const task = async (k: string) => taskInWorkspace(g, f, a[k]);
  const updateVerifiedTask = async (taskId: unknown, before: Json, patch: Json): Promise<Json> => {
    const path = v2("task/" + id(taskId));
    const response = await call("PUT", path, taskBody(patch, true, before));
    if (patch["assignee_ids"] === undefined) return response;
    // One authoritative readback, never a blind retry of a write. A 200 PUT
    // response alone does not establish that assignees changed as requested.
    const after = await call("GET", path);
    if (
      String(after["id"]) !== String(before["id"]) ||
      String(obj(after["list"])?.["id"]) !== String(obj(before["list"])?.["id"])
    )
      throw new ReadFailure("CLICKUP_SCOPE_OR_SCHEMA_REJECTED");
    const actual = taskAssigneeIds(after);
    const wanted = (patch["assignee_ids"] as Array<string | number>).map(Number);
    if (actual.length !== wanted.length || wanted.some((user) => !actual.includes(user)))
      throw new ReadFailure("CLICKUP_ASSIGNEES_NOT_APPLIED");
    return after;
  };
  const list = async (k: string) => listInWorkspace(g, f, a[k]);
  const folder = async (k: string) => folderInWorkspace(g, f, a[k]);
  // Only input-declared Workspace IDs can be supplied; they must match OAuth-bound Workspace.
  if (a["workspace_id"] !== undefined && String(a["workspace_id"]) !== g.workspaceId)
    throw new ReadFailure("CLICKUP_SCOPE_OR_SCHEMA_REJECTED");
  switch (name) {
    case "clickup_filter_tasks":
    case "clickup_get_my_tasks": {
      const isMine = name === "clickup_get_my_tasks" || a["assigned_to_me"] === true;
      const target = a["list_id"] ?? (workspaceScope ? undefined : g.listId);
      if (target !== undefined) await listInWorkspace(g, f, target);
      if (!workspaceScope && String(target) !== g.listId)
        throw new ReadFailure("CLICKUP_SCOPE_OR_SCHEMA_REJECTED");
      const params = new URLSearchParams({ include_closed: "false", subtasks: "true" });
      const includeClosed = a["filter_include_closed"];
      if (includeClosed !== undefined) {
        if (typeof includeClosed !== "boolean") throw new ReadFailure("CLICKUP_INVALID_ARGUMENT");
        params.set("include_closed", String(includeClosed));
      }
      if (name === "clickup_filter_tasks") {
        const arrayFilter = (
          key: string,
          param: string,
          maximum: number,
          test: (v: unknown) => boolean,
        ) => {
          const values = a[key];
          if (values === undefined) return;
          if (!Array.isArray(values) || values.length > maximum || values.some((v) => !test(v)))
            throw new ReadFailure("CLICKUP_INVALID_ARGUMENT");
          for (const value of values) params.append(param + "[]", String(value));
        };
        arrayFilter(
          "filter_assignee_ids",
          "assignees",
          12,
          (v) => typeof v === "string" && /^[1-9]\d{0,15}$/.test(v),
        );
        arrayFilter(
          "filter_statuses",
          "statuses",
          12,
          (v) => typeof v === "string" && v.length > 0 && v.length <= 80,
        );
        arrayFilter(
          "filter_tag_names",
          "tags",
          12,
          (v) => typeof v === "string" && v.length > 0 && v.length <= 100,
        );
        arrayFilter(
          "filter_task_types",
          "custom_items",
          12,
          (v) => Number.isSafeInteger(v) && Number(v) >= 0 && Number(v) <= 100_000_000,
        );
        if (isMine && params.has("assignees[]")) throw new ReadFailure("CLICKUP_INVALID_ARGUMENT");
        if (a["filter_subtasks"] !== undefined) {
          if (typeof a["filter_subtasks"] !== "boolean")
            throw new ReadFailure("CLICKUP_INVALID_ARGUMENT");
          params.set("subtasks", String(a["filter_subtasks"]));
        }
        if (a["filter_order_by"] !== undefined) {
          if (!["id", "created", "updated", "due_date"].includes(String(a["filter_order_by"])))
            throw new ReadFailure("CLICKUP_INVALID_ARGUMENT");
          params.set("order_by", String(a["filter_order_by"]));
        }
        if (a["filter_reverse"] !== undefined) {
          if (typeof a["filter_reverse"] !== "boolean")
            throw new ReadFailure("CLICKUP_INVALID_ARGUMENT");
          params.set("reverse", String(a["filter_reverse"]));
        }
        for (const [arg, param] of [
          ["filter_due_before_ms", "due_date_lt"],
          ["filter_due_after_ms", "due_date_gt"],
          ["filter_updated_after_ms", "date_updated_gt"],
        ] as const) {
          const value = a[arg];
          if (value === undefined) continue;
          if (
            !Number.isSafeInteger(value) ||
            Number(value) < 0 ||
            Number(value) > 9_000_000_000_000
          )
            throw new ReadFailure("CLICKUP_INVALID_ARGUMENT");
          params.set(param, String(value));
        }
        if (
          params.has("due_date_gt") &&
          params.has("due_date_lt") &&
          Number(params.get("due_date_gt")) >= Number(params.get("due_date_lt"))
        )
          throw new ReadFailure("CLICKUP_INVALID_ARGUMENT");
        const filters = a["filter_custom_fields"];
        if (filters !== undefined) {
          if (!Array.isArray(filters) || filters.length > 5)
            throw new ReadFailure("CLICKUP_INVALID_ARGUMENT");
          const prepared = filters.map((filter: unknown) => {
            const f = obj(filter);
            const op = f?.["operator"];
            const key = f?.["field_id"];
            if (
              !f ||
              typeof key !== "string" ||
              !/^[a-zA-Z0-9_-]{1,100}$/.test(key) ||
              !["=", "==", "!=", "<", "<=", ">", ">=", "IS NULL", "IS NOT NULL"].includes(
                String(op),
              )
            )
              throw new ReadFailure("CLICKUP_INVALID_ARGUMENT");
            const text = f["value_text"],
              number = f["value_number"];
            const nullCheck = op === "IS NULL" || op === "IS NOT NULL";
            if (
              (text !== undefined && number !== undefined) ||
              (nullCheck && (text !== undefined || number !== undefined)) ||
              (!nullCheck && text === undefined && number === undefined) ||
              (text !== undefined &&
                (typeof text !== "string" || text.length < 1 || text.length > 160)) ||
              (number !== undefined && (typeof number !== "number" || !Number.isFinite(number)))
            )
              throw new ReadFailure("CLICKUP_INVALID_ARGUMENT");
            return nullCheck
              ? { field_id: key, operator: op }
              : { field_id: key, operator: op, value: text ?? number };
          });
          params.set("custom_fields", JSON.stringify(prepared));
        }
      }
      if (isMine) {
        if (!/^[1-9]\d{0,15}$/.test(g.clickupUserId))
          throw new ReadFailure("CLICKUP_SCOPE_OR_SCHEMA_REJECTED");
        params.append("assignees[]", g.clickupUserId);
      }
      const priority = a["filter_priority"];
      if (
        priority !== undefined &&
        name === "clickup_filter_tasks" &&
        (!Number.isSafeInteger(priority) || Number(priority) < 1 || Number(priority) > 4)
      )
        throw new ReadFailure("CLICKUP_INVALID_ARGUMENT");
      const firstPage = a["task_page"] ?? 0;
      const firstOffset = a["task_offset"] ?? 0;
      if (
        !Number.isSafeInteger(firstPage) ||
        Number(firstPage) < 0 ||
        Number(firstPage) > 100_000 ||
        !Number.isSafeInteger(firstOffset) ||
        Number(firstOffset) < 0 ||
        Number(firstOffset) > 99
      )
        throw new ReadFailure("CLICKUP_INVALID_ARGUMENT");
      const route = target === undefined ? "team/" + W + "/task" : "list/" + id(target) + "/task";
      const matches: Json[] = [];
      let pagesScanned = 0;
      let nextPage: number | null = null;
      let nextOffset = 0;
      for (let index = 0; index < 5; index++) {
        const page = Number(firstPage) + index;
        if (page > 100_000) throw new ReadFailure("CLICKUP_INVALID_ARGUMENT");
        params.set("page", String(page));
        const result = await call("GET", v2(route + "?" + params.toString()));
        const batch = result["tasks"];
        if (!Array.isArray(batch) || batch.length > 100)
          throw new ReadFailure("CLICKUP_BAD_RESPONSE");
        for (const candidate of batch) {
          const item = obj(candidate);
          const home = obj(item?.["list"])?.["id"];
          if (
            !item ||
            (typeof home !== "number" && typeof home !== "string") ||
            !/^[1-9]\d{0,17}$/.test(String(home)) ||
            (target !== undefined && String(home) !== String(target))
          )
            throw new ReadFailure("CLICKUP_SCOPE_OR_SCHEMA_REJECTED");
        }
        const offset = index === 0 ? Number(firstOffset) : 0;
        if (offset > 0 && offset >= batch.length) throw new ReadFailure("CLICKUP_INVALID_ARGUMENT");
        pagesScanned++;
        for (let j = offset; j < batch.length; j++) {
          const item = obj(batch[j])!;
          if (priority !== undefined) {
            const value = obj(item["priority"])?.["id"] ?? item["priority"];
            if (Number(value) !== Number(priority)) continue;
          }
          matches.push(item);
          if (matches.length === N) {
            const restOfPage = j + 1 < batch.length;
            const nextUpstreamPage = batch.length === 100 && result["last_page"] !== true;
            if (restOfPage || nextUpstreamPage) {
              nextPage = restOfPage ? page : page + 1;
              nextOffset = restOfPage ? j + 1 : 0;
            }
            break;
          }
        }
        if (matches.length === N || batch.length < 100 || result["last_page"] === true) break;
        if (index === 4) nextPage = page + 1;
      }
      return {
        source: "clickup-api-v2",
        scope: target === undefined ? "workspace" : "list",
        tasks: clip(matches),
        pages_scanned: pagesScanned,
        next_task_page: nextPage,
        next_task_offset: nextOffset,
        incomplete: nextPage !== null || hasClippedNestedArray(matches),
        ...(priority === undefined ? {} : { priority_filter: "client_side" }),
      };
    }
    case "clickup_get_custom_task_types": {
      const result = await call("GET", v2("team/" + W + "/custom_item"));
      const types = result["custom_items"];
      if (!Array.isArray(types) || types.length > 500 || types.some((entry) => !obj(entry)))
        throw new ReadFailure("CLICKUP_BAD_RESPONSE");
      return {
        source: "clickup-api-v2",
        custom_items: clip(types.slice(0, N)),
        incomplete: types.length > N || hasClippedNestedArray(types.slice(0, N)),
      };
    }
    case "clickup_get_task_templates":
    case "clickup_create_task_from_template": {
      // Template discovery is Workspace metadata. Never allow it to broaden a
      // single-List grant; a template ID alone is not authorization to create.
      const page = a["template_page"] ?? 0;
      const offset = a["template_offset"] ?? 0;
      if (
        !Number.isSafeInteger(page) ||
        Number(page) < 0 ||
        Number(page) > 100 ||
        !Number.isSafeInteger(offset) ||
        Number(offset) < 0 ||
        Number(offset) > 99
      )
        throw new ReadFailure("CLICKUP_INVALID_ARGUMENT");
      if (name === "clickup_create_task_from_template") await list("list_id");
      const result = await call("GET", v2("team/" + W + "/taskTemplate?page=" + page));
      const templates = result["templates"];
      if (
        !Array.isArray(templates) ||
        templates.length > 100 ||
        templates.some((entry) => !obj(entry) || obj(entry)?.["id"] === undefined)
      )
        throw new ReadFailure("CLICKUP_BAD_RESPONSE");
      if (name === "clickup_get_task_templates") {
        if (Number(offset) > 0 && Number(offset) >= templates.length)
          throw new ReadFailure("CLICKUP_INVALID_ARGUMENT");
        const visible = templates.slice(Number(offset), Number(offset) + N);
        const samePage = Number(offset) + visible.length < templates.length;
        const morePages =
          result["has_more"] === true ||
          result["last_page"] === false ||
          (templates.length === 100 && result["last_page"] !== true);
        return {
          source: "clickup-api-v2",
          templates: clip(visible),
          template_page: page,
          next_template_page: samePage ? page : morePages ? Number(page) + 1 : null,
          next_template_offset: samePage ? Number(offset) + visible.length : 0,
          incomplete: samePage || morePages || hasClippedNestedArray(visible),
        };
      }
      const wanted = txt(a["template_id"], 80);
      if (
        !/^[a-zA-Z0-9_-]{1,80}$/.test(wanted) ||
        !templates.some((entry) => String(obj(entry)?.["id"]) === wanted)
      )
        throw new ReadFailure("CLICKUP_SCOPE_OR_SCHEMA_REJECTED");
      const targetList = String(a["list_id"]);
      const nameText = txt(a["task_name"], 180);
      const created = await call(
        "POST",
        v2("list/" + val(a, "list_id") + "/taskTemplate/" + id(wanted)),
        { name: nameText },
      );
      const newId = created["id"];
      if (typeof newId !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(newId))
        throw new ReadFailure("CLICKUP_WRITE_OUTCOME_UNKNOWN");
      try {
        const confirmed = await call("GET", v2("task/" + id(newId)));
        if (
          String(confirmed["id"]) !== newId ||
          String(obj(confirmed["list"])?.["id"]) !== targetList
        )
          throw new ReadFailure("CLICKUP_WRITE_OUTCOME_UNKNOWN");
        return {
          success: true,
          task_id: newId,
          list_id: targetList,
          template_id: wanted,
          verified_by_readback: true,
          source: "clickup-api-v2",
        };
      } catch {
        // A successfully created task must never be POSTed again after an
        // uncertain readback. The caller must verify by task ID manually.
        throw new ReadFailure("CLICKUP_WRITE_OUTCOME_UNKNOWN");
      }
    }
    case "clickup_search_workspace": {
      const q = txt(a["query"], 240).toLowerCase();
      // Both List and Workspace modes paginate within their exact authorised
      // scopes. The offset preserves matches when a result limit is reached
      // partway through a ClickUp page.
      const startPage = a["task_page"] ?? 0;
      const startOffset = a["task_offset"] ?? 0;
      if (!Number.isSafeInteger(startPage) || Number(startPage) < 0 || Number(startPage) > 100_000)
        throw new ReadFailure("CLICKUP_INVALID_ARGUMENT");
      if (!Number.isSafeInteger(startOffset) || Number(startOffset) < 0 || Number(startOffset) > 99)
        throw new ReadFailure("CLICKUP_INVALID_ARGUMENT");
      if (!workspaceScope) await listInWorkspace(g, f, g.listId);
      const match = (v: unknown) => JSON.stringify(v).toLowerCase().includes(q);
      const matchingTasks: unknown[] = [];
      let pagesScanned = 0;
      let nextTaskPage: number | null = null;
      let nextTaskOffset = 0;
      const maxPagesPerCall = 10;
      for (let offset = 0; offset < maxPagesPerCall; offset++) {
        const page = Number(startPage) + offset;
        if (page > 100_000) throw new ReadFailure("CLICKUP_INVALID_ARGUMENT");
        const target = workspaceScope ? "team/" + W : "list/" + id(g.listId);
        const query = "?page=" + page + "&subtasks=true&include_closed=true";
        const batch = await call("GET", v2(target + "/task" + query));
        if (!Array.isArray(batch["tasks"]) || batch["tasks"].length > 100)
          throw new ReadFailure("CLICKUP_BAD_RESPONSE");
        const pageTasks = batch["tasks"];
        const pageOffset = offset === 0 ? Number(startOffset) : 0;
        if (pageOffset > 0 && pageOffset >= pageTasks.length)
          throw new ReadFailure("CLICKUP_INVALID_ARGUMENT");
        // Validate the ENTIRE page before traversing further or returning
        // any part of a List-scoped result.
        for (const candidate of pageTasks) {
          const task = obj(candidate);
          if (!task || (!workspaceScope && String(obj(task["list"])?.["id"]) !== g.listId))
            throw new ReadFailure("CLICKUP_SCOPE_OR_SCHEMA_REJECTED");
        }
        pagesScanned++;
        for (let item = pageOffset; item < pageTasks.length; item++) {
          if (!match(pageTasks[item])) continue;
          matchingTasks.push(pageTasks[item]);
          if (matchingTasks.length === N) {
            const moreInPage = item + 1 < pageTasks.length;
            const morePages = pageTasks.length === 100 && batch["last_page"] !== true;
            if (moreInPage || morePages) {
              nextTaskPage = moreInPage ? page : page + 1;
              nextTaskOffset = moreInPage ? item + 1 : 0;
            }
            break;
          }
        }
        if (matchingTasks.length === N) break;
        if (pageTasks.length < 100 || batch["last_page"] === true) break;
        if (offset === maxPagesPerCall - 1) nextTaskPage = page + 1;
      }
      const taskPageTruncated = nextTaskPage !== null;
      if (!workspaceScope) {
        // Never search Workspace Docs, Folders or unrelated Lists under a single-List grant.
        return {
          source: "clickup-api-v2",
          scope: "list",
          tasks: clip(matchingTasks.slice(0, N)),
          pages_scanned: pagesScanned,
          next_task_page: nextTaskPage,
          next_task_offset: nextTaskOffset,
          docs: [],
          lists: [],
          folders: [],
          incomplete: taskPageTruncated,
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
        scope: "workspace",
        tasks: clip(matchingTasks.slice(0, N)),
        pages_scanned: pagesScanned,
        next_task_page: nextTaskPage,
        next_task_offset: nextTaskOffset,
        docs: clip(d.filter(match).slice(0, N)),
        lists: clip(foundLists.filter(match).slice(0, N)),
        folders: clip(foundFolders.filter(match).slice(0, N)),
        incomplete:
          taskPageTruncated ||
          matchingTasks.length > N ||
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
      // Keep one named tool per operation. Search every bounded page rather than
      // silently dropping matches beyond the first 100 ClickUp tasks.
      const startPage = a["task_page"] ?? 0;
      const startOffset = a["task_offset"] ?? 0;
      if (!Number.isSafeInteger(startPage) || Number(startPage) < 0 || Number(startPage) > 100_000)
        throw new ReadFailure("CLICKUP_INVALID_ARGUMENT");
      if (!Number.isSafeInteger(startOffset) || Number(startOffset) < 0 || Number(startOffset) > 99)
        throw new ReadFailure("CLICKUP_INVALID_ARGUMENT");
      const targetPath =
        workspaceScope && a["list_id"] === undefined
          ? "team/" + W + "/task"
          : "list/" + id(target) + "/task";
      const params = new URLSearchParams({
        subtasks: "true",
        include_closed: "true",
      });
      if (workspaceScope && a["list_id"] !== undefined) params.set("include_timl", "true");
      const found: Json[] = [];
      let pagesScanned = 0;
      let nextTaskPage: number | null = null;
      let nextTaskOffset = 0;
      const maxPagesPerCall = 10;
      for (let scanned = 0; scanned < maxPagesPerCall; scanned++) {
        const page = Number(startPage) + scanned;
        if (page > 100_000) throw new ReadFailure("CLICKUP_INVALID_ARGUMENT");
        params.set("page", String(page));
        const result = await call("GET", v2(targetPath + "?" + params.toString()));
        if (!Array.isArray(result["tasks"]) || result["tasks"].length > 100)
          throw new ReadFailure("CLICKUP_BAD_RESPONSE");
        const tasks = result["tasks"];
        const offset = scanned === 0 ? Number(startOffset) : 0;
        if (offset > 0 && offset >= tasks.length) throw new ReadFailure("CLICKUP_INVALID_ARGUMENT");
        // Validate the entire upstream page before releasing even one result.
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
        pagesScanned++;
        for (let item = offset; item < tasks.length; item++) {
          const t = obj(tasks[item])!;
          const matches =
            name === "clickup_search_tasks_by_type"
              ? String(t["custom_item_id"] ?? 0) === String(a["task_type"])
              : Array.isArray(t["tags"]) &&
                t["tags"].some(
                  (tag: unknown) =>
                    String(obj(tag)?.["name"]).toLowerCase() === String(a["tag"]).toLowerCase(),
                );
          if (!matches) continue;
          found.push(t);
          if (found.length === N) {
            const moreInPage = item + 1 < tasks.length;
            const morePages = tasks.length === 100 && result["last_page"] !== true;
            if (moreInPage || morePages) {
              nextTaskPage = moreInPage ? page : page + 1;
              nextTaskOffset = moreInPage ? item + 1 : 0;
            }
            break;
          }
        }
        if (found.length === N) break;
        if (tasks.length < 100 || result["last_page"] === true) break;
        if (scanned === maxPagesPerCall - 1) nextTaskPage = page + 1;
      }
      return {
        source: "clickup-api-v2",
        tasks: clip(found),
        pages_scanned: pagesScanned,
        next_task_page: nextTaskPage,
        next_task_offset: nextTaskOffset,
        incomplete: nextTaskPage !== null,
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
    // Individual and List-scoped checklist mutations never accept arbitrary
    // checklist IDs. The authoritative task response must demonstrate ancestry.
    case "clickup_create_task_checklist": {
      const verifiedTask = await task("task_id");
      const created = await call("POST", v2("task/" + val(a, "task_id") + "/checklist"), {
        name: txt(a["name"], 180),
      });
      const checklist = obj(created["checklist"]);
      if (!checklist || String(checklist["task_id"]) !== String(verifiedTask["id"]))
        throw new ReadFailure("CLICKUP_WRITE_OUTCOME_UNKNOWN");
      return short({ checklist: clip(checklist), source: "clickup-api-v2" });
    }
    case "clickup_create_checklist_item": {
      const verifiedTask = await task("task_id");
      const key = checklistId(a["checklist_id"]);
      const checklist = authorizedTaskChecklist(verifiedTask, a["checklist_id"]);
      if (!Array.isArray(checklist["items"]) || checklist["items"].length > 500)
        throw new ReadFailure("CLICKUP_SCOPE_OR_SCHEMA_REJECTED");
      const result = await call("POST", v2("checklist/" + key + "/checklist_item"), {
        name: txt(a["name"], 500),
      });
      const stored = obj(result["checklist"]);
      if (!stored || String(stored["id"]) !== String(a["checklist_id"]))
        throw new ReadFailure("CLICKUP_WRITE_OUTCOME_UNKNOWN");
      return short({ checklist: stored, source: "clickup-api-v2" });
    }
    case "clickup_update_checklist_item": {
      const verifiedTask = await task("task_id");
      const key = checklistId(a["checklist_id"]);
      const itemId = checklistId(a["checklist_item_id"]);
      const checklist = authorizedTaskChecklist(verifiedTask, a["checklist_id"]);
      const rows = checklist["items"];
      if (
        !Array.isArray(rows) ||
        rows.length > 500 ||
        !rows.some((row) => obj(row)?.["id"] === a["checklist_item_id"])
      )
        throw new ReadFailure("CLICKUP_SCOPE_OR_SCHEMA_REJECTED");
      const hasName = a["name"] !== undefined;
      const hasResolution = a["resolved"] !== undefined;
      if ((!hasName && !hasResolution) || (hasResolution && typeof a["resolved"] !== "boolean"))
        throw new ReadFailure("CLICKUP_INVALID_ARGUMENT");
      const body = {
        ...(hasName ? { name: txt(a["name"], 500) } : {}),
        ...(hasResolution ? { resolved: a["resolved"] } : {}),
      };
      // No automatic retry: a timeout after PUT leaves the result uncertain.
      await call(
        "PUT",
        v2("checklist/" + key + "/checklist_item/" + itemId),
        body,
        "empty-write-ack",
      );
      const after = await task("task_id");
      const verifiedChecklist = authorizedTaskChecklist(after, a["checklist_id"]);
      const updated = Array.isArray(verifiedChecklist["items"])
        ? verifiedChecklist["items"]
            .map(obj)
            .find((item) => item?.["id"] === a["checklist_item_id"])
        : null;
      if (
        !updated ||
        (hasName && updated["name"] !== body.name) ||
        (hasResolution && updated["resolved"] !== body.resolved)
      )
        throw new ReadFailure("CLICKUP_WRITE_OUTCOME_UNKNOWN");
      return {
        success: true,
        verified_by_readback: true,
        task_id: a["task_id"],
        checklist_id: a["checklist_id"],
        checklist_item_id: a["checklist_item_id"],
        source: "clickup-api-v2",
      };
    }
    case "clickup_get_list_views": {
      await list("list_id");
      const data = await call("GET", v2("list/" + val(a, "list_id") + "/view"));
      if (!Array.isArray(data["views"]) || data["views"].length > 500)
        throw new ReadFailure("CLICKUP_BAD_RESPONSE");
      // Inherited views are not returned under this strict List-only contract.
      const views = data["views"].map(obj);
      if (
        views.some((view) => {
          const parent = obj(view?.["parent"]);
          return (
            !view ||
            !parent ||
            Number(parent["type"]) !== 6 ||
            String(parent["id"]) !== String(a["list_id"])
          );
        })
      )
        throw new ReadFailure("CLICKUP_SCOPE_OR_SCHEMA_REJECTED");
      return {
        source: "clickup-api-v2",
        views: clip(views.slice(0, N)),
        incomplete: views.length > N,
      };
    }
    case "clickup_get_workspace_views": {
      const data = await call("GET", v2("team/" + W + "/view"));
      if (!Array.isArray(data["views"]) || data["views"].length > 500)
        throw new ReadFailure("CLICKUP_BAD_RESPONSE");
      const views = data["views"].map(obj);
      if (
        views.some((view) => {
          const parent = obj(view?.["parent"]);
          return (
            !view ||
            !parent ||
            Number(parent["type"]) !== 7 ||
            String(parent["id"]) !== g.workspaceId
          );
        })
      )
        throw new ReadFailure("CLICKUP_SCOPE_OR_SCHEMA_REJECTED");
      return {
        source: "clickup-api-v2",
        views: clip(views.slice(0, N)),
        incomplete: views.length > N,
      };
    }
    case "clickup_get_view_tasks": {
      await list("list_id");
      // Read the View itself and verify its List parent before looking at tasks.
      const viewId = val(a, "view_id");
      const data = await call("GET", v2("view/" + viewId));
      const view = obj(data["view"]) ?? data;
      const parent = obj(view["parent"]);
      if (
        String(view["id"]) !== String(a["view_id"]) ||
        !parent ||
        Number(parent["type"]) !== 6 ||
        String(parent["id"]) !== String(a["list_id"])
      )
        throw new ReadFailure("CLICKUP_SCOPE_OR_SCHEMA_REJECTED");
      const page = a["view_page"] ?? 0;
      const offset = a["view_offset"] ?? 0;
      if (!Number.isSafeInteger(page) || Number(page) < 0 || Number(page) > 100_000)
        throw new ReadFailure("CLICKUP_INVALID_ARGUMENT");
      if (!Number.isSafeInteger(offset) || Number(offset) < 0 || Number(offset) > 99)
        throw new ReadFailure("CLICKUP_INVALID_ARGUMENT");
      const found = await call("GET", v2("view/" + viewId + "/task?page=" + page));
      if (!Array.isArray(found["tasks"]) || found["tasks"].length > 100)
        throw new ReadFailure("CLICKUP_BAD_RESPONSE");
      const tasks = found["tasks"];
      // Strictly enforce home-List scope on every result, even if the saved
      // View refers to additional Lists or a task was recently moved.
      if (
        tasks.some((entry) => {
          const item = obj(entry);
          return !item || String(obj(item["list"])?.["id"]) !== String(a["list_id"]);
        })
      )
        throw new ReadFailure("CLICKUP_SCOPE_OR_SCHEMA_REJECTED");
      if (Number(offset) > 0 && Number(offset) >= tasks.length)
        throw new ReadFailure("CLICKUP_INVALID_ARGUMENT");
      const selected = tasks.slice(Number(offset), Number(offset) + N);
      const hasMoreHere = Number(offset) + selected.length < tasks.length;
      const hasNextPage = tasks.length === 100 && found["last_page"] !== true;
      return {
        source: "clickup-api-v2",
        view_id: a["view_id"],
        list_id: a["list_id"],
        tasks: clip(selected),
        next_view_page: hasMoreHere ? page : hasNextPage ? Number(page) + 1 : null,
        next_view_offset: hasMoreHere ? Number(offset) + selected.length : 0,
        incomplete: hasMoreHere || hasNextPage,
      };
    }
    case "clickup_get_task":
      return short(await task("task_id"));
    case "clickup_read_task_pdf": {
      const verified = await task("task_id");
      const attachments = verified["attachments"];
      if (!Array.isArray(attachments) || attachments.length > 200)
        throw new ReadFailure("CLICKUP_SCOPE_OR_SCHEMA_REJECTED");
      const selected = attachments
        .map(obj)
        .find((item) => String(item?.["id"]) === String(a["attachment_id"]));
      if (!selected) throw new ReadFailure("CLICKUP_SCOPE_OR_SCHEMA_REJECTED");
      // No caller-provided URLs: the signed link is taken only from the
      // authenticated task GET after its Workspace/home-List verification.
      const { extractVerifiedTaskPdf } = await import("./pdf-reader.js");
      return extractVerifiedTaskPdf(selected, f, g.workspaceId);
    }
    case "clickup_update_task": {
      const before = await task("task_id");
      return short(await updateVerifiedTask(a["task_id"], before, buildArgs(a, "changes")));
    }
    case "clickup_set_custom_field": {
      const target = await task("task_id");
      const homeListId = obj(target["list"])?.["id"];
      const available = await call(
        "GET",
        v2("list/" + id(homeListId) + "/field?include_applied_objects=true"),
      );
      if (!Array.isArray(available["fields"]) || available["fields"].length > 500)
        throw new ReadFailure("CLICKUP_BAD_RESPONSE");
      const definition = available["fields"]
        .map(obj)
        .find((candidate) => String(candidate?.["id"]) === String(a["field_id"]));
      if (!definition) throw new ReadFailure("CLICKUP_SCOPE_OR_SCHEMA_REJECTED");
      const applied = definition["applied_objects"];
      if (
        applied !== undefined &&
        (!Array.isArray(applied) ||
          (applied.length > 0 &&
            !applied.some(
              (item) =>
                String(obj(item)?.["object_type"]) === "19" &&
                String(obj(item)?.["object_id"]) === String(target["custom_item_id"] ?? 0),
            )))
      )
        throw new ReadFailure("CLICKUP_SCOPE_OR_SCHEMA_REJECTED");
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
      const variant = Object.keys(field)[0] ?? "";
      const fieldType = definition["type"];
      const supported: Record<string, readonly string[]> = {
        text: ["text", "short_text", "url", "email", "phone"],
        number: ["number", "currency"],
        option_id: ["drop_down"],
        selected_option_ids: ["labels"],
        checked: ["checkbox"],
        timestamp_ms: ["date"],
      };
      if (!supported[variant]?.includes(String(fieldType)))
        throw new ReadFailure("CLICKUP_INVALID_ARGUMENT");
      if (variant === "option_id" || variant === "selected_option_ids") {
        const options = obj(definition["type_config"])?.["options"];
        if (
          !Array.isArray(options) ||
          options.some(
            (option) =>
              !obj(option) ||
              typeof obj(option)?.["id"] !== "string" ||
              !String(obj(option)?.["id"]).trim(),
          )
        )
          throw new ReadFailure("CLICKUP_BAD_RESPONSE");
        const optionIds = new Set(options.map((option) => String(obj(option)?.["id"])));
        const selections = variant === "option_id" ? [value] : (value as unknown[]);
        if (selections.some((option) => !optionIds.has(String(option))))
          throw new ReadFailure("CLICKUP_INVALID_ARGUMENT");
      }
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
        await call(
          "POST",
          v2("task/" + val(a, "task_id") + "/field/" + val(a, "field_id")),
          { value, ...(variant === "timestamp_ms" ? { value_options: { time: true } } : {}) },
          "empty-write-ack",
        ),
      );
    }
    case "clickup_delete_task": {
      const existing = await task("task_id");
      if (g.companyCleanupAccess === true) {
        const title = existing["name"];
        if (
          a["confirm_delete"] !== true ||
          typeof title !== "string" ||
          a["expected_task_name"] !== title
        )
          throw new ReadFailure("CLICKUP_SCOPE_OR_SCHEMA_REJECTED");
        // Verify immediately before deletion that the task still belongs to
        // this exact authorized List and has no child tasks to delete.
        const before = await call(
          "GET",
          v2("task/" + val(a, "task_id") + "?include_subtasks=true"),
        );
        if (
          String(before["id"]) !== String(existing["id"]) ||
          String(obj(before["list"])?.["id"]) !== String(obj(existing["list"])?.["id"]) ||
          before["name"] !== title ||
          !Array.isArray(before["subtasks"]) ||
          before["subtasks"].length !== 0
        )
          throw new ReadFailure("CLICKUP_SCOPE_OR_SCHEMA_REJECTED");
      }
      await call("DELETE", v2("task/" + val(a, "task_id")));
      return {
        success: true,
        source: "clickup-api-v2",
        task_id: String(existing["id"]),
        action: "sent_to_trash",
      };
    }
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
        // Validate every patch before the first write; assignee deltas require
        // the authoritative per-task GET and are computed in the execution loop.
        taskBody(changes);
        return { taskId: x["task_id"], changes };
      });
      const outcome: unknown[] = [];
      for (let i = 0; i < validated.length; i++) {
        const x = validated[i]!;
        try {
          const before = await taskInWorkspace(g, f, x.taskId);
          outcome.push({
            index: i,
            success: true,
            response: clip(await updateVerifiedTask(x.taskId, before, x.changes)),
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
      return uploadAttachment(
        g,
        f,
        String(a["task_id"]),
        txt(a["file_name"], 120),
        txt(a["file_base64"], 700000),
        typeof a["media_type"] === "string" ? a["media_type"] : "application/octet-stream",
      );
    }
    case "clickup_get_task_comments": {
      await task("task_id");
      const taskId = String(a["task_id"]);
      const read = (path: string) => call("GET", path);
      let cursor = inputCommentCursor(a);
      const comments: Json[] = [];
      const seen = new Set<string>();
      let pagesScanned = 0;
      let incomplete = false;
      let continuationUnavailable = false;
      let next: CommentCursor | null = null;
      // The API returns at most 25 comments per page; 3 reads suffice for
      // max_results <= 50, with a hard bound against unexpected upstream loops.
      for (let pageIndex = 0; pageIndex < 3; pageIndex++) {
        const batch = await taskCommentPage(read, taskId, cursor);
        pagesScanned++;
        for (const comment of batch) {
          const key = String(comment["id"]);
          if (seen.has(key)) throw new ReadFailure("CLICKUP_BAD_RESPONSE");
          seen.add(key);
        }
        const visible = batch.slice(0, N - comments.length);
        comments.push(...visible);
        const mayHaveMore = batch.length === 25 || batch.length > visible.length;
        if (mayHaveMore) {
          next = commentCursorFrom(visible[visible.length - 1]!);
          if (!next) continuationUnavailable = true;
        } else {
          next = null;
        }
        incomplete = mayHaveMore;
        if (comments.length === N || batch.length < 25 || !next) break;
        cursor = next;
      }
      // Pagination completeness and rich-content completeness are distinct:
      // a short upstream page may still contain text or formatted spans that
      // exceed the existing safe response bounds.
      const richCommentsClipped = comments.some((entry) => {
        const spans = obj(entry)?.["comment"];
        return Array.isArray(spans) && spans.length > 100;
      });
      const payloadClipped = hasClippedText({ comments }) || richCommentsClipped;
      return {
        source: "clickup-api-v2",
        comments: clip(comments),
        pages_scanned: pagesScanned,
        next_comment_start: next?.start ?? null,
        next_comment_start_id: next?.startId ?? null,
        incomplete: incomplete || payloadClipped,
        content_truncated: payloadClipped,
        continuation_unavailable: continuationUnavailable,
        first_page_only: pagesScanned === 1,
      };
    }
    case "clickup_get_threaded_replies": {
      await task("task_id");
      const read = (path: string) => call("GET", path);
      let cursor = inputCommentCursor(a);
      let parent: Json | undefined;
      const seen = new Set<string>();
      // Only a parent obtained from the already authorized task's own
      // comment endpoint may authorize the subsequent comment-ID API read.
      // Explicit cursors permit older parents beyond the bounded scan.
      for (let pageIndex = 0; pageIndex < 10; pageIndex++) {
        const batch = await taskCommentPage(read, String(a["task_id"]), cursor);
        for (const comment of batch) {
          const key = String(comment["id"]);
          if (seen.has(key)) throw new ReadFailure("CLICKUP_BAD_RESPONSE");
          seen.add(key);
        }
        parent = batch.find((comment) => String(comment["id"]) === String(a["comment_id"]));
        if (parent) break;
        if (batch.length < 25) break;
        const next = commentCursorFrom(batch[batch.length - 1]!);
        if (!next || (cursor && cursor.start === next.start && cursor.startId === next.startId))
          throw new ReadFailure("CLICKUP_BAD_RESPONSE");
        cursor = next;
      }
      if (!parent) throw new ReadFailure("CLICKUP_SCOPE_OR_SCHEMA_REJECTED");
      const result = await call("GET", v2("comment/" + val(a, "comment_id") + "/reply"));
      const replies = Array.isArray(result["comments"])
        ? result["comments"]
        : Array.isArray(result["replies"])
          ? result["replies"]
          : null;
      if (!replies || replies.some((reply) => !obj(reply)))
        throw new ReadFailure("CLICKUP_BAD_RESPONSE");
      const rawCount = parent["reply_count"];
      const expected =
        rawCount === undefined
          ? undefined
          : typeof rawCount === "number"
            ? rawCount
            : typeof rawCount === "string" && /^\d+$/.test(rawCount)
              ? Number(rawCount)
              : NaN;
      if (
        expected !== undefined &&
        (!Number.isSafeInteger(expected) || expected < 0 || (expected > 0 && replies.length === 0))
      )
        throw new ReadFailure("CLICKUP_BAD_RESPONSE");
      return short(
        {
          ...result,
          comments: replies,
          parent_comment_id: val(a, "comment_id"),
          ...(expected === undefined ? {} : { parent_reply_count: expected }),
          incomplete: expected !== undefined && expected > replies.length,
        },
        N,
      );
    }
    case "clickup_create_task_comment": {
      await task("task_id");
      const richRequested = a["mention_segments"] !== undefined || a["rich_segments"] !== undefined;
      if (
        (a["rich_segments"] !== undefined && a["mention_segments"] !== undefined) ||
        (richRequested && (a["text"] !== undefined || a["parent_comment_id"] !== undefined)) ||
        (!richRequested && a["text"] === undefined)
      )
        throw new ReadFailure("CLICKUP_INVALID_ARGUMENT");
      // Preserve the legacy unassigned path and reject an unsupported combination
      // rather than silently dropping a requested assignment on a threaded reply.
      if (a["assignee_id"] !== undefined && a["parent_comment_id"] !== undefined)
        throw new ReadFailure("CLICKUP_INVALID_ARGUMENT");
      const assignee =
        a["assignee_id"] === undefined
          ? null
          : await verifiedCommentAssignee(a["assignee_id"], g, f);
      if (richRequested) {
        let rich: Json[];
        let requestedIds: string[];
        let dividerFallback = false;
        if (a["rich_segments"] !== undefined) {
          const input = a["rich_segments"];
          const wantsMentions =
            Array.isArray(input) &&
            input.some((segment) => obj(segment)?.["mention_user_id"] !== undefined);
          const eligible = new Set(
            wantsMentions ? (await members(g, f)).map((user) => String(user["id"])) : [],
          );
          const compiled = compileClickUpRichSegments(input, eligible);
          rich = compiled.segments;
          requestedIds = compiled.mentions;
          dividerFallback = compiled.dividerFallback;
        } else {
          const pieces = a["mention_segments"];
          if (!Array.isArray(pieces) || pieces.length < 1 || pieces.length > 20)
            throw new ReadFailure("CLICKUP_INVALID_ARGUMENT");
          const eligible = new Set((await members(g, f)).map((user) => String(user["id"])));
          rich = [];
          requestedIds = [];
          let textChars = 0;
          for (const raw of pieces) {
            const part = obj(raw);
            if (!part) throw new ReadFailure("CLICKUP_INVALID_ARGUMENT");
            const keys = Object.keys(part);
            if (keys.length !== 1) throw new ReadFailure("CLICKUP_INVALID_ARGUMENT");
            if (typeof part["text"] === "string" && keys[0] === "text") {
              const content = part["text"];
              if (content.length === 0 || content.length > 6000)
                throw new ReadFailure("CLICKUP_INVALID_ARGUMENT");
              textChars += content.length;
              if (textChars > 6000) throw new ReadFailure("CLICKUP_INVALID_ARGUMENT");
              rich.push({ text: content });
            } else if (keys[0] === "mention_user_id") {
              const supplied = part["mention_user_id"];
              if (
                typeof supplied !== "string" ||
                !/^[1-9][0-9]{0,15}$/.test(supplied) ||
                !Number.isSafeInteger(Number(supplied)) ||
                !eligible.has(supplied) ||
                requestedIds.length >= 12
              )
                throw new ReadFailure("CLICKUP_SCOPE_OR_SCHEMA_REJECTED");
              rich.push({ type: "tag", user: { id: Number(supplied) } });
              requestedIds.push(supplied);
            } else {
              throw new ReadFailure("CLICKUP_INVALID_ARGUMENT");
            }
          }
          // Legacy mention_segments still requires a real verified mention.
          if (requestedIds.length === 0) throw new ReadFailure("CLICKUP_INVALID_ARGUMENT");
        }
        const taskId = val(a, "task_id");
        const posted = await call("POST", v2("task/" + taskId + "/comment"), {
          comment: rich,
          notify_all: false,
          ...(assignee === null ? {} : { assignee }),
        });
        const commentId = posted["id"];
        if (
          (typeof commentId !== "number" && typeof commentId !== "string") ||
          !/^[0-9]{1,24}$/.test(String(commentId))
        )
          throw new ReadFailure("CLICKUP_WRITE_OUTCOME_UNKNOWN");
        let mentionIdsVerified: boolean;
        try {
          const after = await call("GET", v2("task/" + taskId + "/comment"));
          if (!Array.isArray(after["comments"])) throw Error("Missing comments");
          const created = after["comments"]
            .map(obj)
            .find((item) => String(item?.["id"]) === String(commentId));
          const actual = created?.["comment"];
          if (
            !created ||
            String(obj(created["user"])?.["id"]) !== g.clickupUserId ||
            !Array.isArray(actual) ||
            actual.length !== rich.length
          )
            throw Error("Rich comment readback incomplete");
          const comparison = compareRichCommentReadback(rich, actual);
          if (!comparison.match) throw Error("Rich formatting changed on ClickUp readback");
          mentionIdsVerified = comparison.mentionIdentityVerified;
          if (
            assignee !== null &&
            String(obj(created["assignee"])?.["id"] ?? created["assignee"]) !== String(assignee)
          )
            throw Error("Comment assignment did not persist");
        } catch {
          // The POST may have succeeded; never post again after uncertain readback.
          throw new ReadFailure("CLICKUP_WRITE_OUTCOME_UNKNOWN");
        }
        return {
          ...posted,
          write_acknowledged: true,
          requested_mention_user_ids: requestedIds,
          ...(mentionIdsVerified ? { genuine_mentions: requestedIds } : {}),
          verified_tag_structure_by_readback: requestedIds.length > 0,
          native_rich_structure_verified_by_readback: true,
          ...(dividerFallback ? { divider_fallback: "unicode_text", native_divider: false } : {}),
          // A tag with no returned user.id proves structure, NOT its target.
          mention_identity_verified_by_readback: mentionIdsVerified,
          verified_by_readback: mentionIdsVerified,
          readback_status: mentionIdsVerified ? "full" : "structure_only",
          // ClickUp may notify tagged people even though notify_all is false.
          notification_delivery_unverified: true,
        };
      }
      const comment = {
        comment_text: txt(a["text"], 6000),
        notify_all: false,
        ...(assignee === null ? {} : { assignee }),
      };
      if (a["parent_comment_id"] === undefined) {
        const taskId = val(a, "task_id");
        const posted = await call("POST", v2("task/" + taskId + "/comment"), comment);
        if (assignee === null) return posted;
        // Never claim that a requested assignment happened based only on POST.
        const commentId = posted["id"];
        if (
          (typeof commentId !== "number" && typeof commentId !== "string") ||
          !/^[0-9]{1,24}$/.test(String(commentId))
        )
          throw new ReadFailure("CLICKUP_WRITE_OUTCOME_UNKNOWN");
        try {
          const after = await call("GET", v2("task/" + taskId + "/comment"));
          if (!Array.isArray(after["comments"])) throw Error("Missing comments");
          const created = after["comments"]
            .map(obj)
            .find((item) => String(item?.["id"]) === String(commentId));
          if (
            !created ||
            String(obj(created["assignee"])?.["id"] ?? created["assignee"]) !== String(assignee)
          )
            throw Error("Assignment did not persist");
        } catch {
          throw new ReadFailure("CLICKUP_WRITE_OUTCOME_UNKNOWN");
        }
        return {
          ...posted,
          assignee_id: String(assignee),
          verified_by_readback: true,
        };
      }
      // The reply destination must be independently verified against this task.
      const parents = await call("GET", v2("task/" + val(a, "task_id") + "/comment"));
      if (
        !Array.isArray(parents["comments"]) ||
        !parents["comments"].some(
          (item) => String(obj(item)?.["id"]) === String(a["parent_comment_id"]),
        )
      )
        throw new ReadFailure("CLICKUP_SCOPE_OR_SCHEMA_REJECTED");
      const replyPath = v2("comment/" + val(a, "parent_comment_id") + "/reply");
      const before = await call("GET", replyPath);
      const repliesBefore = Array.isArray(before["comments"])
        ? before["comments"]
        : Array.isArray(before["replies"])
          ? before["replies"]
          : null;
      if (!repliesBefore) throw new ReadFailure("CLICKUP_BAD_RESPONSE");
      const previousIds = new Set(repliesBefore.map((item) => String(obj(item)?.["id"])));
      try {
        const response = await call("POST", replyPath, comment, "empty-write-ack");
        if (typeof response["id"] === "string" && response["id"]) return response;
      } catch (error) {
        if (!(error instanceof ReadFailure) || error.code !== "CLICKUP_WRITE_OUTCOME_UNKNOWN")
          throw error;
      }
      // An empty/unparseable successful response may conceal a committed reply.
      // Read once to confirm a new reply with the requested exact text; never repost.
      try {
        const after = await call("GET", replyPath);
        const replies = Array.isArray(after["comments"])
          ? after["comments"]
          : Array.isArray(after["replies"])
            ? after["replies"]
            : [];
        const matches = replies
          .map(obj)
          .filter((item): item is Json => item !== null)
          .filter((item) => {
            if (
              typeof item["id"] !== "string" ||
              previousIds.has(item["id"]) ||
              String(obj(item["user"])?.["id"]) !== g.clickupUserId
            )
              return false;
            const text =
              typeof item["comment_text"] === "string"
                ? item["comment_text"]
                : Array.isArray(item["comment"]) &&
                    item["comment"].every((part) => typeof obj(part)?.["text"] === "string")
                  ? item["comment"].map((part) => String(obj(part)?.["text"])).join("")
                  : null;
            return text === comment.comment_text;
          });
        if (matches.length === 1)
          return {
            success: true,
            source: "clickup-api",
            reply_id: matches[0]!["id"],
            verified_by_readback: true,
          };
      } catch {
        // A missing readback cannot establish that a reply was committed.
      }
      throw new ReadFailure("CLICKUP_WRITE_OUTCOME_UNKNOWN");
    }
    case "clickup_delete_task_comment": {
      if (a["confirm_delete"] !== true) throw new ReadFailure("CLICKUP_INVALID_ARGUMENT");
      await task("task_id");
      const taskId = val(a, "task_id");
      const commentId = val(a, "comment_id");
      const comments = await call("GET", v2("task/" + taskId + "/comment"));
      if (!Array.isArray(comments["comments"]) || comments["comments"].length > 25)
        throw new ReadFailure("CLICKUP_BAD_RESPONSE");
      const matched = comments["comments"]
        .map(obj)
        .find((entry) => String(entry?.["id"]) === commentId);
      // A comment without a verified zero reply count is not safe to delete.
      // Missing, null, negative and malformed values must fail closed.
      const rawReplies = matched?.["reply_count"];
      const replies =
        typeof rawReplies === "number"
          ? rawReplies
          : typeof rawReplies === "string" && /^[0-9]+$/.test(rawReplies)
            ? Number(rawReplies)
            : NaN;
      if (
        !matched ||
        String(obj(matched["user"])?.["id"]) !== g.clickupUserId ||
        !Number.isSafeInteger(replies) ||
        replies !== 0
      )
        throw new ReadFailure("CLICKUP_SCOPE_OR_SCHEMA_REJECTED");
      // A specific own comment on a verified task; never delete someone else's
      // comment or a threaded conversation with replies.
      await call("DELETE", v2("comment/" + commentId));
      return {
        success: true,
        source: "clickup-api-v2",
        task_id: taskId,
        comment_id: commentId,
        action: "deleted_own_comment",
      };
    }
    case "clickup_edit_task_comment": {
      // A comment ID alone does not prove either task membership or authorship.
      await task("task_id");
      const taskId = val(a, "task_id");
      const commentId = val(a, "comment_id");
      if (a["text"] === undefined && a["assignee_id"] === undefined && a["resolved"] === undefined)
        throw new ReadFailure("CLICKUP_INVALID_ARGUMENT");
      if (a["resolved"] !== undefined && typeof a["resolved"] !== "boolean")
        throw new ReadFailure("CLICKUP_INVALID_ARGUMENT");
      const before = await call("GET", v2("task/" + taskId + "/comment"));
      if (!Array.isArray(before["comments"])) throw new ReadFailure("CLICKUP_BAD_RESPONSE");
      const original = before["comments"]
        .map(obj)
        .find((item) => String(item?.["id"]) === String(a["comment_id"]));
      // The first task-comment page must positively establish ownership.
      // Never let a caller edit another person's comment or an older unseen one.
      if (!original || String(obj(original["user"])?.["id"]) !== g.clickupUserId)
        throw new ReadFailure("CLICKUP_SCOPE_OR_SCHEMA_REJECTED");
      // Assignment-only updates must not flatten rich comments or replace images.
      // Preserve only a verified plain-text comment body, not an inferred string.
      const replacement =
        a["text"] === undefined ? txt(original["comment_text"], 6000) : txt(a["text"], 6000);
      // The upstream PUT contract requires assignment/resolution alongside text.
      // Preserve known state. Unassigned, non-group comments with no resolved
      // flag are treated as unresolved; reject ambiguous or group assignments.
      if (original["group_assignee"] != null)
        throw new ReadFailure("CLICKUP_SCOPE_OR_SCHEMA_REJECTED");
      const rawAssignee = original["assignee"];
      if (rawAssignee === undefined) throw new ReadFailure("CLICKUP_SCOPE_OR_SCHEMA_REJECTED");
      const assignedId = obj(rawAssignee)?.["id"] ?? rawAssignee;
      const assigneeValue = rawAssignee === null ? 0 : assignedId;
      if (
        !Number.isSafeInteger(Number(assigneeValue)) ||
        Number(assigneeValue) < 0 ||
        !/^[0-9]+$/.test(String(assigneeValue))
      )
        throw new ReadFailure("CLICKUP_SCOPE_OR_SCHEMA_REJECTED");
      const assignee =
        a["assignee_id"] === undefined
          ? Number(assigneeValue)
          : await verifiedCommentAssignee(a["assignee_id"], g, f);
      const originalResolved = original["resolved"];
      if (
        typeof originalResolved !== "boolean" &&
        !(originalResolved === undefined && Number(assigneeValue) === 0)
      )
        throw new ReadFailure("CLICKUP_SCOPE_OR_SCHEMA_REJECTED");
      const resolved = a["resolved"] === undefined ? originalResolved === true : a["resolved"];
      await call(
        "PUT",
        v2("comment/" + commentId),
        { comment_text: replacement, assignee, resolved },
        "empty-write-ack",
      );
      // Check the actual task's comments after the mutation. A transport success
      // without the requested text is not sufficient evidence of a completed edit.
      let after: Json;
      try {
        after = await call("GET", v2("task/" + taskId + "/comment"));
      } catch {
        // The PUT may already have committed; never present this as a
        // recoverable read error that could encourage a blind repeat.
        throw new ReadFailure("CLICKUP_WRITE_OUTCOME_UNKNOWN");
      }
      if (!Array.isArray(after["comments"])) throw new ReadFailure("CLICKUP_WRITE_OUTCOME_UNKNOWN");
      const edited = after["comments"]
        .map(obj)
        .find((item) => String(item?.["id"]) === String(a["comment_id"]));
      if (!edited || edited["comment_text"] !== replacement)
        throw new ReadFailure("CLICKUP_WRITE_OUTCOME_UNKNOWN");
      const actualAssignee =
        edited["assignee"] === null ? 0 : (obj(edited["assignee"])?.["id"] ?? edited["assignee"]);
      if (a["assignee_id"] !== undefined && String(actualAssignee) !== String(assignee))
        throw new ReadFailure("CLICKUP_WRITE_OUTCOME_UNKNOWN");
      if (
        (a["resolved"] !== undefined || typeof originalResolved === "boolean") &&
        edited["resolved"] !== resolved
      )
        throw new ReadFailure("CLICKUP_WRITE_OUTCOME_UNKNOWN");
      return {
        success: true,
        source: "clickup-api-v2",
        task_id: String(a["task_id"]),
        comment_id: String(a["comment_id"]),
        verified_by_readback: true,
      };
    }
    case "clickup_add_tag_to_task":
      await task("task_id");
      return call(
        "POST",
        v2("task/" + val(a, "task_id") + "/tag/" + encodeURIComponent(txt(a["tag"], 160))),
        undefined,
        "empty-write-ack",
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
      const blockerId = val(a, "blocking_task_id");
      const waiterId = val(a, "waiting_task_id");
      try {
        await call(
          "POST",
          v2("task/" + waiterId + "/dependency"),
          { depends_on: blockerId },
          "empty-write-ack",
        );
      } catch (error) {
        // If ClickUp committed but did not return parseable JSON, inspect
        // the new relationship once. Never retry the POST.
        if (!(error instanceof ReadFailure) || error.code !== "CLICKUP_WRITE_OUTCOME_UNKNOWN")
          throw error;
      }
      try {
        const waiter = await call("GET", v2("task/" + waiterId));
        const present =
          Array.isArray(waiter["dependencies"]) &&
          waiter["dependencies"].some((item) => {
            const link = obj(item);
            return (
              link !== null &&
              String(link["task_id"]) === waiterId &&
              String(link["depends_on"]) === blockerId
            );
          });
        if (present) return { success: true, source: "clickup-api", verified_by_readback: true };
      } catch {
        // A failed read cannot convert an uncertain write into a success.
      }
      throw new ReadFailure("CLICKUP_WRITE_OUTCOME_UNKNOWN");
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
      const listDescription = listDescriptionBody(a);
      if (a["folder_id"] !== undefined) {
        await folder("folder_id");
        return call("POST", v2("folder/" + val(a, "folder_id") + "/list"), {
          name: txt(a["name"], 180),
          ...listDescription,
        });
      }
      await inWorkspace(g, f, a["space_id"]);
      return call("POST", v2("space/" + val(a, "space_id") + "/list"), {
        name: txt(a["name"], 180),
        ...listDescription,
      });
    }
    case "clickup_create_list_in_folder":
      await folder("folder_id");
      return call("POST", v2("folder/" + val(a, "folder_id") + "/list"), {
        name: txt(a["name"], 180),
        ...listDescriptionBody(a),
      });
    case "clickup_get_list": {
      const result = await list("list_id");
      // Default to read-only field discovery, including for MCP clients still
      // advertising the original list_id-only input schema.
      if (a["include_custom_fields"] === false) return short(result);
      try {
        const available = await call(
          "GET",
          v2("list/" + val(a, "list_id") + "/field?include_applied_objects=true"),
        );
        if (!Array.isArray(available["fields"])) throw new ReadFailure("CLICKUP_BAD_RESPONSE");
        const fields = available["fields"];
        return short({
          ...result,
          custom_fields: fields.slice(0, 50),
          custom_fields_count: fields.length,
          incomplete: fields.length > 50 || hasClippedNestedArray(fields.slice(0, 50)),
        });
      } catch (error) {
        // Field metadata denial must not break otherwise authorized List reads.
        if (error instanceof ReadFailure && error.code === "CLICKUP_UPSTREAM_DENIED")
          return short({ ...result, custom_fields_unavailable: true });
        throw error;
      }
    }
    case "clickup_update_list":
      await list("list_id");
      return call("PUT", v2("list/" + val(a, "list_id")), {
        name: txt(a["name"], 180),
        ...listDescriptionBody(a),
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
    case "clickup_get_chat_channel_messages":
    case "clickup_get_chat_message_replies": {
      const channelId = val(a, "channel_id");
      await verifiedChatChannel(g, f, a["channel_id"]);
      const params = new URLSearchParams({
        limit: String(N),
        content_format: validatedContentFormat(a),
      });
      if (a["chat_cursor"] !== undefined)
        params.set("cursor", boundedV3Cursor(a["chat_cursor"]));
      const prefix = "workspaces/" + W + "/chat/";
      if (name === "clickup_get_chat_message_replies") {
        const parent = new URLSearchParams({
          limit: "50",
          content_format: "text/plain",
        });
        if (a["parent_chat_cursor"] !== undefined)
          parent.set("cursor", boundedV3Cursor(a["parent_chat_cursor"]));
        const page = await call(
          "GET",
          v3(prefix + "channels/" + channelId + "/messages?" + parent.toString()),
        );
        if (
          !Array.isArray(page["messages"]) ||
          page["messages"].length > 50 ||
          page["messages"].some((entry) => !obj(entry))
        ) throw new ReadFailure("CLICKUP_BAD_RESPONSE");
        const claimed = page["messages"].map(obj).find(
          (msg) => String(msg?.["id"]) === String(a["message_id"]),
        );
        if (
          !claimed ||
          (claimed["channel_id"] !== undefined &&
            String(claimed["channel_id"]) !== String(a["channel_id"]))
        ) throw new ReadFailure("CLICKUP_SCOPE_OR_SCHEMA_REJECTED");
        // Only after the parent is proven to belong to this authorized
        // channel may an API path addressing a message ID be called.
        const result = await call(
          "GET",
          v3(prefix + "messages/" + val(a, "message_id") + "/replies?" + params.toString()),
        );
        if (
          !Array.isArray(result["messages"]) ||
          result["messages"].length > N ||
          result["messages"].some((entry) => !obj(entry))
        ) throw new ReadFailure("CLICKUP_BAD_RESPONSE");
        const cursor = nextV3Cursor(result);
        return {
          source: "clickup-api-v3",
          channel_id: a["channel_id"],
          parent_message_id: a["message_id"],
          messages: clip(result["messages"]),
          next_cursor: cursor,
          incomplete: cursor !== null || result["messages"].length === N ||
            hasClippedNestedArray(result["messages"]),
          continuation_unavailable: cursor === null && result["messages"].length === N,
        };
      }
      const result = await call(
        "GET",
        v3(prefix + "channels/" + channelId + "/messages?" + params.toString()),
      );
      if (
        !Array.isArray(result["messages"]) ||
        result["messages"].length > N ||
        result["messages"].some((entry) => !obj(entry) ||
          (obj(entry)?.["channel_id"] !== undefined &&
            String(obj(entry)?.["channel_id"]) !== String(a["channel_id"])))
      ) throw new ReadFailure("CLICKUP_BAD_RESPONSE");
      const cursor = nextV3Cursor(result);
      return {
        source: "clickup-api-v3",
        channel_id: a["channel_id"],
        messages: clip(result["messages"]),
        next_cursor: cursor,
        incomplete: cursor !== null || result["messages"].length === N ||
          hasClippedNestedArray(result["messages"]),
        continuation_unavailable: cursor === null && result["messages"].length === N,
      };
    }
    case "clickup_search_documents": {
      const limit = a["docs_limit"] ?? 20;
      if (!Number.isSafeInteger(limit) || Number(limit) < 10 || Number(limit) > 50)
        throw new ReadFailure("CLICKUP_INVALID_ARGUMENT");
      const parentType = a["docs_parent_type"];
      const parentId = a["docs_parent_id"];
      if ((parentType === undefined) !== (parentId === undefined))
        throw new ReadFailure("CLICKUP_INVALID_ARGUMENT");
      const params = new URLSearchParams({ limit: String(limit), archived: "false", deleted: "false" });
      if (parentType !== undefined) {
        if (!["SPACE", "FOLDER", "LIST", "EVERYTHING", "WORKSPACE"].includes(String(parentType)))
          throw new ReadFailure("CLICKUP_INVALID_ARGUMENT");
        const parentKey = id(parentId);
        if (parentType === "LIST") await listInWorkspace(g, f, parentId);
        else if (parentType === "FOLDER") await folder("docs_parent_id");
        else if (parentType === "SPACE") await inWorkspace(g, f, parentId);
        else if (String(parentId) !== g.workspaceId)
          throw new ReadFailure("CLICKUP_SCOPE_OR_SCHEMA_REJECTED");
        params.set("parent_type", String(parentType));
        params.set("parent_id", parentKey);
      }
      if (a["docs_cursor"] !== undefined)
        params.set("cursor", boundedV3Cursor(a["docs_cursor"]));
      const result = await call("GET", v3("workspaces/" + W + "/docs?" + params.toString()));
      if (
        !Array.isArray(result["docs"]) ||
        result["docs"].length > Number(limit) ||
        result["docs"].some((entry) => !obj(entry))
      ) throw new ReadFailure("CLICKUP_BAD_RESPONSE");
      const cursor = nextV3Cursor(result);
      return {
        source: "clickup-api-v3",
        docs: clip(result["docs"]),
        next_cursor: cursor,
        incomplete: cursor !== null || result["docs"].length === Number(limit) ||
          hasClippedNestedArray(result["docs"]),
        continuation_unavailable: cursor === null && result["docs"].length === Number(limit),
      };
    }
    case "clickup_get_chat_channels":
      return short(
        await call("GET", v3("workspaces/" + W + "/chat/channels?limit=" + Math.min(N, 50))),
        N,
      );
    case "clickup_send_chat_message": {
      if (a["text"] !== undefined && a["content"] !== undefined)
        throw new ReadFailure("CLICKUP_INVALID_ARGUMENT");
      return call(
        "POST",
        v3("workspaces/" + W + "/chat/channels/" + val(a, "channel_id") + "/messages"),
        {
          type: "message",
          content: txt(a["content"] ?? a["text"], 40_000),
          content_format: validatedContentFormat(a),
        },
      );
    }
    case "clickup_create_document": {
      const body: Json = { name: txt(a["name"], 180), create_page: true };
      if (a["folder_id"] !== undefined) {
        await folder("folder_id");
        body["parent"] = { id: String(a["folder_id"]), type: 5 };
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
          undefined,
          "document-page-list",
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
              "?content_format=" +
              encodeURIComponent(validatedContentFormat(a)),
          ),
        ),
      );
    case "clickup_create_document_page":
      return call("POST", v3("workspaces/" + W + "/docs/" + val(a, "document_id") + "/pages"), {
        name: txt(a["name"], 180),
        content: validatedDocPageContent(a),
        content_format: validatedContentFormat(a),
      });
    case "clickup_update_document_page": {
      const content = txt(a["doc_content"], 40_000);
      const format = validatedContentFormat(a);
      const pagePath = v3(
        "workspaces/" + W + "/docs/" + val(a, "document_id") + "/pages/" + val(a, "page_id"),
      );
      try {
        return await call(
          "PUT",
          pagePath,
          { content, content_edit_mode: "replace", content_format: format },
          "empty-write-ack",
        );
      } catch (error) {
        if (!(error instanceof ReadFailure) || error.code !== "CLICKUP_WRITE_OUTCOME_UNKNOWN")
          throw error;
        // A successful ClickUp Docs update can return an unusable response
        // (e.g. non-JSON), even after its content is already committed.
        // Never retry the write. Verify that the exact requested content
        // persisted with one independent read before reporting success.
        try {
          const verified = await call(
            "GET",
            pagePath + "?content_format=" + encodeURIComponent(format),
          );
          if (verified["content"] === content)
            return { success: true, source: "clickup-api", verified_by_readback: true };
          // Only exactly observed standalone plain-text bracket escaping
          // qualifies as confirmed provider normalization after readback.
          const stored = verified["content"];
          if (
            format === "text/md" &&
            typeof stored === "string" &&
            plainBracketEscapesOnly(content, stored)
          ) {
            return {
              success: true,
              source: "clickup-api",
              verified_by_readback: true,
              provider_normalized: true,
              warning: "ClickUp escaped Markdown brackets; saved text differs.",
            };
          }
        } catch {
          // Preserve the original uncertain-write error if verification fails.
        }
        throw error;
      }
    }
    case "clickup_get_task_time_in_status": {
      await task("task_id");
      const statusTime = await call("GET", v2("task/" + val(a, "task_id") + "/time_in_status"));
      if (!hasTimeInStatus(statusTime))
        throw new ReadFailure("CLICKUP_STATUS_TIME_DATA_UNAVAILABLE");
      return short(statusTime);
    }
    case "clickup_get_list_time_in_status": {
      await list("list_id");
      const tasks = await call(
        "GET",
        v2("list/" + val(a, "list_id") + "/task?page=0&subtasks=false&include_closed=true"),
      );
      if (!Array.isArray(tasks["tasks"])) throw new ReadFailure("CLICKUP_BAD_RESPONSE");
      const ids = tasks["tasks"].slice(0, N).map((entry) => {
        try {
          return id(obj(entry)?.["id"]);
        } catch {
          // Upstream task rows with missing/invalid IDs must not silently
          // disappear from a partial status report.
          throw new ReadFailure("CLICKUP_BAD_RESPONSE");
        }
      });
      if (new Set(ids).size !== ids.length) throw new ReadFailure("CLICKUP_BAD_RESPONSE");
      if (ids.length === 0) return { source: "clickup-api-v2", tasks: [] };
      const params = ids.map((x) => "task_ids=" + x).join("&");
      const statusTime = await call("GET", v2("task/bulk_time_in_status/task_ids?" + params));
      if (!ids.every((taskId) => hasTimeInStatus(statusTime[taskId])))
        throw new ReadFailure("CLICKUP_STATUS_TIME_DATA_UNAVAILABLE");
      // The query deliberately reads only page zero; report coverage limits
      // instead of misrepresenting a sampled List as fully assessed.
      const listCoverageIncomplete =
        tasks["tasks"].length > N || tasks["last_page"] === false || tasks["tasks"].length >= 100;
      return short({
        ...statusTime,
        incomplete: listCoverageIncomplete || statusTime["incomplete"] === true,
      });
    }
    default:
      throw new ReadFailure("CLICKUP_TOOL_NOT_IMPLEMENTED");
  }
}
