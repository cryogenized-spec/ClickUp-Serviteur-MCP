import { quotaCall } from "./client.js";
import { sanitizeWebhookMetadata, validActivityConsumer } from "./webhook-ingress.js";
import { filePendingLedger } from "./file-field-ledger.js";
import { getMyAttentionItems } from "./attention-items.js";
import { captureVerifiedComments, captureVerifiedTask } from "./task-index.js";
import { readGoalDetails, readSprintTaskSnapshot, readWorkspaceGoals } from "./reporting-reads.js";
import {
  canonicalPatchComment,
  commentPatchFingerprint,
  compileClickUpRichSegments,
  compareRichCommentReadback,
  patchRichComment,
} from "./comment-rich.js";
import { verifySharedListWorkspace } from "./operations.js";
import {
  chatMessageAuthorId,
  chatReactionName,
  chatReactionOwned,
  requireOwnChatMessage,
  requiredChatText,
} from "./chat-lifecycle.js";
import {
  chatChannelType,
  chatCollection,
  chatCursor,
  chatEntity,
  chatMemberIds,
  validateDirectMessageRecipients,
  validateRequestedRecipients,
} from "./chat-v3.js";
import {
  apiDiagnostic,
  authorizationDiagnostic,
  COMPANY_LIST_TASK_OPERATIONS,
  ReadFailure,
  type ReadGrant,
} from "./policy.js";

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
  // This exact v3 Chat write has different error semantics from a simple GET.
  // Keep diagnostics strictly status-based: never parse/echo private Chat errors.
  const chatSend =
    method === "POST" &&
    path.startsWith("api/v3/workspaces/") &&
    ((path.includes("/chat/channels/") && path.endsWith("/messages")) ||
      /\/chat\/messages\/[^/]+\/replies$/.test(path));
  const chatDiagnostic = (outcome: "rejected" | "unknown", status?: number) =>
    chatSend
      ? {
          endpoint_category: "chat_message_send" as const,
          ...(status === undefined ? {} : { http_status: status }),
          write_outcome: outcome,
        }
      : undefined;
  await quotaCall(grant, "reserve");
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), 7000);
  let upstreamStatus: number | undefined;
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
    upstreamStatus = res.status;
    if (res.status === 429) {
      const reset = res.headers.get("X-RateLimit-Reset");
      if (reset && /^\d{1,12}$/.test(reset)) {
        const unix = Number(reset);
        if (unix > Date.now() / 1000 && unix < Date.now() / 1000 + 3600)
          await quotaCall(grant, "cooldown", unix * 1000);
      }
      throw new ReadFailure(
        "CLICKUP_RATE_LIMITED",
        chatDiagnostic("rejected", 429) ?? apiDiagnostic(method, 429),
      );
    }
    if (res.status === 401 || res.status === 403)
      throw new ReadFailure(
        "CLICKUP_UPSTREAM_DENIED",
        chatDiagnostic("rejected", res.status) ??
          (await authorizationDiagnostic(method, res, path)),
      );
    if (!res.ok) {
      if (chatSend) {
        if (res.status === 400 || res.status === 422)
          throw new ReadFailure(
            "CLICKUP_CHAT_REQUEST_REJECTED",
            chatDiagnostic("rejected", res.status),
          );
        if (res.status === 404)
          throw new ReadFailure(
            "CLICKUP_CHAT_DESTINATION_UNAVAILABLE",
            chatDiagnostic("rejected", 404),
          );
        if (res.status === 409)
          throw new ReadFailure("CLICKUP_CHAT_CONFLICT", chatDiagnostic("rejected", 409));
        if (res.status >= 500)
          throw new ReadFailure(
            "CLICKUP_WRITE_OUTCOME_UNKNOWN",
            chatDiagnostic("unknown", res.status),
          );
      }
      throw new ReadFailure(
        method === "GET" || res.status < 500
          ? "CLICKUP_UPSTREAM_UNAVAILABLE"
          : "CLICKUP_WRITE_OUTCOME_UNKNOWN",
        chatDiagnostic(res.status >= 500 ? "unknown" : "rejected", res.status) ??
          apiDiagnostic(method, res.status),
      );
    }
    // ClickUp v3 Chat documents 201 for creation. Any other 2xx may
    // represent a persisted write, but cannot be called a confirmed delivery.
    // Never retry that POST; preserve a sanitized unknown-outcome diagnostic.
    if (chatSend && res.status !== 201)
      throw new ReadFailure("CLICKUP_WRITE_OUTCOME_UNKNOWN", chatDiagnostic("unknown", res.status));
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
    // A 201 without a usable exact message ID cannot be safely verified
    // later. Don't claim success or repeat the potentially delivered message.
    if (chatSend && (typeof data["id"] !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(data["id"])))
      throw new ReadFailure(
        "CLICKUP_WRITE_OUTCOME_UNKNOWN",
        chatDiagnostic("unknown", upstreamStatus),
      );
    return data;
  } catch (e) {
    if (e instanceof ReadFailure) {
      if (chatSend && e.code === "CLICKUP_WRITE_OUTCOME_UNKNOWN" && !e.diagnostic)
        throw new ReadFailure(e.code, chatDiagnostic("unknown", upstreamStatus));
      throw e;
    }
    throw new ReadFailure(
      method === "GET" ? "CLICKUP_UPSTREAM_UNAVAILABLE" : "CLICKUP_WRITE_OUTCOME_UNKNOWN",
      chatDiagnostic("unknown", upstreamStatus),
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
/** Prove the individual task's Workspace membership without granting its private List.
 * Only used after an authoritative task GET and a denied parent-List read.
 */
async function verifySharedTaskWorkspace(
  grant: ReadGrant,
  f: typeof fetch,
  taskId: string,
  listId: string,
): Promise<void> {
  const hierarchy = await send(grant, f, "GET", v2("team/" + id(grant.workspaceId) + "/shared"));
  const tasks = obj(hierarchy["shared"])?.["tasks"];
  if (
    Array.isArray(tasks) &&
    tasks.length <= 500 &&
    tasks.some((entry) => {
      const item = obj(entry);
      if (!item || String(item["id"]) !== taskId) return false;
      const home = obj(item["list"])?.["id"];
      return home === undefined || String(home) === listId;
    })
  )
    return;
  // A Workspace-scoped assigned-task page can also prove exact membership.
  // Never use the listing as a substitute for the successful individual GET.
  for (let page = 0; page < 3; page++) {
    const params = new URLSearchParams({
      page: String(page),
      include_closed: "true",
      subtasks: "true",
    });
    params.append("list_ids[]", listId);
    params.append("assignees[]", id(grant.clickupUserId));
    const result = await send(
      grant,
      f,
      "GET",
      v2("team/" + id(grant.workspaceId) + "/task?" + params),
    );
    const rows = result["tasks"];
    if (!Array.isArray(rows) || rows.length > 100) throw new ReadFailure("CLICKUP_BAD_RESPONSE");
    if (
      rows.some((entry) => {
        const item = obj(entry);
        return String(item?.["id"]) === taskId && String(obj(item?.["list"])?.["id"]) === listId;
      })
    )
      return;
    if (rows.length < 100 || result["last_page"] === true) break;
  }
  throw new ReadFailure("CLICKUP_SCOPE_OR_SCHEMA_REJECTED");
}
async function taskInWorkspace(
  grant: ReadGrant,
  f: typeof fetch,
  taskId: unknown,
  allowSharedTask = false,
  pendingVerifiedLists?: Map<string, number>,
): Promise<Json> {
  let task: Json;
  try {
    task = await send(
      grant,
      f,
      "GET",
      v2("task/" + id(taskId) + "?include_markdown_description=true"),
    );
  } catch (error) {
    // A direct task GET returning 404 cannot authorize that task. Distinguish
    // it from a parent List or Workspace lookup failing with the same status.
    if (
      pendingVerifiedLists &&
      error instanceof ReadFailure &&
      error.code === "CLICKUP_UPSTREAM_UNAVAILABLE" &&
      error.diagnostic?.http_status === 404
    )
      throw new ReadFailure("CLICKUP_PENDING_TASK_NOT_FOUND", error.diagnostic);
    throw error;
  }
  if (String(task["id"]) !== String(taskId))
    throw new ReadFailure("CLICKUP_SCOPE_OR_SCHEMA_REJECTED");
  const homeList = obj(task["list"])?.["id"];
  try {
    if (pendingVerifiedLists) {
      // Cache only successful parent authorization, within this single read
      // and briefly. Every distinct task still requires its own fresh GET.
      const listKey = id(homeList);
      const verifiedUntil = pendingVerifiedLists.get(listKey) ?? 0;
      if (Date.now() >= verifiedUntil) {
        await listInWorkspace(grant, f, homeList);
        pendingVerifiedLists.set(listKey, Date.now() + 10_000);
      }
    } else {
      await listInWorkspace(grant, f, homeList);
    }
  } catch (error) {
    if (
      !allowSharedTask ||
      grant.resourceScope !== "workspace" ||
      !(error instanceof ReadFailure) ||
      error.code !== "CLICKUP_UPSTREAM_DENIED" ||
      error.diagnostic?.authorization_target !== "list"
    )
      throw error;
    await verifySharedTaskWorkspace(grant, f, id(taskId), id(homeList));
  }
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
  v3Entity?: { type: "attachments" | "custom_fields"; id: string },
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
  return uploadAttachmentBytes(grant, fetcher, taskId, filename, data, mime, v3Entity);
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
  v3Entity?: { type: "attachments" | "custom_fields"; id: string },
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
  const verifiedTask = await taskInWorkspace(grant, fetcher, taskId);
  if (v3Entity) {
    if (grant.resourceScope !== "workspace" && grant.companyListTaskAccess !== true)
      throw new ReadFailure("CLICKUP_WORKSPACE_SCOPE_REQUIRED");
    if (v3Entity.type === "attachments" && v3Entity.id !== taskId)
      throw new ReadFailure("CLICKUP_SCOPE_OR_SCHEMA_REJECTED");
    if (v3Entity.type === "custom_fields")
      await verifiedFileField(grant, fetcher, verifiedTask, v3Entity.id);
  }
  const uploadBytes = new Uint8Array(data.byteLength);
  uploadBytes.set(data);
  const form = new FormData();
  // ClickUp's v2 endpoint reports UPLOAD_002 ("Incorrect filename") for
  // attachment[0] in some single-file uploads despite the array documentation.
  // The production-compatible single-file field is the unindexed "attachment".
  form.append("attachment", new Blob([uploadBytes], { type: mime }), filename);
  if (v3Entity) form.append("filename", filename);
  await quotaCall(grant, "reserve");
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), 10000);
  try {
    const endpoint = v3Entity
      ? v3(
          "workspaces/" +
            id(grant.workspaceId) +
            "/" +
            v3Entity.type +
            "/" +
            id(v3Entity.id) +
            "/attachments",
        )
      : v2("task/" + id(taskId) + "/attachment");
    let res = await fetcher(pathEncoded(endpoint), {
      method: "POST",
      redirect: "manual",
      signal: abort.signal,
      // Let the runtime set multipart Content-Type including boundary; do not
      // add an Accept header on this legacy ClickUp upload endpoint.
      headers: { Authorization: grant.apiToken },
      body: form,
    });
    let usedV2TaskFallback = false;
    if (v3Entity?.type === "attachments" && res.status === 404) {
      // ClickUp's published v3 task attachment endpoint returns 404 for
      // independently verified tasks in some Workspaces. A definitive 404
      // is a rejected request, never an ambiguous completed upload.
      // Only task uploads have a compatible v2 endpoint; Files fields do not.
      // Keep the fallback form free of v3-only fields.
      const fallbackForm = new FormData();
      fallbackForm.append("attachment", new Blob([uploadBytes], { type: mime }), filename);
      await quotaCall(grant, "reserve");
      res = await fetcher(pathEncoded(v2("task/" + id(taskId) + "/attachment")), {
        method: "POST",
        redirect: "manual",
        signal: abort.signal,
        headers: { Authorization: grant.apiToken },
        body: fallbackForm,
      });
      usedV2TaskFallback = true;
    }
    if (res.status === 429) {
      const reset = res.headers.get("X-RateLimit-Reset");
      if (reset && /^\d{1,12}$/.test(reset)) {
        const unix = Number(reset);
        if (unix > Date.now() / 1000 && unix < Date.now() / 1000 + 3600)
          await quotaCall(grant, "cooldown", unix * 1000);
      }
      throw new ReadFailure("CLICKUP_RATE_LIMITED");
    }
    if (res.status === 401 || res.status === 403)
      throw new ReadFailure("CLICKUP_UPSTREAM_DENIED", apiDiagnostic("POST", res.status));
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
    const content = await readBoundedJsonBody(res, "CLICKUP_WRITE_OUTCOME_UNKNOWN");
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      throw new ReadFailure("CLICKUP_WRITE_OUTCOME_UNKNOWN");
    }
    const attachment =
      obj(parsed) && obj(obj(parsed)?.["data"]) ? obj(obj(parsed)?.["data"]) : obj(parsed);
    if (!attachment || typeof attachment["id"] !== "string" || !attachment["id"])
      throw new ReadFailure("CLICKUP_WRITE_OUTCOME_UNKNOWN");
    if (usedV2TaskFallback) {
      return {
        source: "clickup-api-v2-task-fallback",
        attachment_id: attachment["id"],
        title: attachment["title"] ?? attachment["name"] ?? filename,
        parent_id: taskId,
        requires_task_association: false,
        retry_safe: false,
        note: "ClickUp v3 rejected the task attachment endpoint with HTTP 404; the established v2 task upload succeeded.",
      };
    }
    if (v3Entity) {
      if (attachment["parent_id"] !== undefined && String(attachment["parent_id"]) !== v3Entity.id)
        throw new ReadFailure("CLICKUP_WRITE_OUTCOME_UNKNOWN");
      if (v3Entity.type === "custom_fields") {
        // Only a confirmed upload can create an owner/task/field-bound pending ID.
        // If this durable write fails, the remote upload is orphaned and must not
        // be associated from a caller-provided attachment ID.
        const registered = await filePendingLedger(
          grant,
          taskId,
          v3Entity.id,
          attachment["id"],
          "register",
        );
        if (!registered) throw new ReadFailure("CLICKUP_FILE_PROVENANCE_REJECTED");
      }
      return {
        source: "clickup-api-v3",
        attachment_id: attachment["id"],
        title: attachment["title"] ?? attachment["name"] ?? filename,
        parent_id: v3Entity.id,
        requires_task_association: v3Entity.type === "custom_fields",
        retry_safe: false,
      };
    }
    return clip(attachment) as Json;
  } catch (error) {
    if (error instanceof ReadFailure) throw error;
    // Do not retry uploads following a timeout or an ambiguous response.
    throw new ReadFailure("CLICKUP_WRITE_OUTCOME_UNKNOWN");
  } finally {
    clearTimeout(timeout);
  }
}

/** Verify a Files field against the task's *authorized home List* before any
 * v3 collection read or upload. Empty fields may be absent from task values. */
async function verifiedFileField(
  grant: ReadGrant,
  fetcher: typeof fetch,
  task: Json,
  fieldId: string,
): Promise<Json> {
  const listId = id(obj(task["list"])?.["id"]);
  const fields = await send(
    grant,
    fetcher,
    "GET",
    v2("list/" + listId + "/field?include_applied_objects=true"),
  );
  const rows = fields["fields"];
  if (!Array.isArray(rows) || rows.length > 500) throw new ReadFailure("CLICKUP_BAD_RESPONSE");
  const definition = rows.map(obj).find((item) => item?.["id"] === fieldId);
  if (!definition || !["attachment", "files"].includes(String(definition["type"])))
    throw new ReadFailure("CLICKUP_SCOPE_OR_SCHEMA_REJECTED");
  const applied = definition["applied_objects"];
  if (
    applied !== undefined &&
    (!Array.isArray(applied) ||
      (applied.length > 0 &&
        !applied.some(
          (entry) =>
            String(obj(entry)?.["object_type"]) === "19" &&
            String(obj(entry)?.["object_id"]) === String(task["custom_item_id"] ?? 0),
        )))
  )
    throw new ReadFailure("CLICKUP_SCOPE_OR_SCHEMA_REJECTED");
  return definition;
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
  return chatCursor(response);
}
/** A Chat channel must be resolved through the OAuth-bound Workspace path. */
async function verifiedChatChannel(
  grant: ReadGrant,
  fetcher: typeof fetch,
  channelId: unknown,
): Promise<Json> {
  const key = id(channelId);
  const response = await send(
    grant,
    fetcher,
    "GET",
    v3("workspaces/" + id(grant.workspaceId) + "/chat/channels/" + key),
  );
  const channel = chatEntity(response, "channel");
  if (String(channel["id"]) !== String(channelId))
    throw new ReadFailure("CLICKUP_SCOPE_OR_SCHEMA_REJECTED");
  if (
    (channel["workspace_id"] !== undefined &&
      String(channel["workspace_id"]) !== grant.workspaceId) ||
    (obj(channel["workspace"])?.["id"] !== undefined &&
      String(obj(channel["workspace"])?.["id"]) !== grant.workspaceId)
  )
    throw new ReadFailure("CLICKUP_SCOPE_OR_SCHEMA_REJECTED");
  return channel;
}

/** Never infer members from a channel name or the person who created a DM. */
async function verifiedChannelMembers(
  grant: ReadGrant,
  fetcher: typeof fetch,
  channelId: unknown,
): Promise<{ memberIds: string[]; complete: boolean }> {
  const raw = await send(
    grant,
    fetcher,
    "GET",
    v3(
      "workspaces/" +
        id(grant.workspaceId) +
        "/chat/channels/" +
        id(channelId) +
        "/members?limit=50",
    ),
  );
  return chatMemberIds(raw);
}

async function verifiedRecipientIds(
  grant: ReadGrant,
  fetcher: typeof fetch,
  requested: readonly string[],
): Promise<void> {
  if (requested.includes(grant.clickupUserId)) throw new ReadFailure("CLICKUP_INVALID_ARGUMENT");
  if (requested.length === 0) return;
  const eligible = await members(grant, fetcher);
  if (requested.some((memberId) => !eligible.some((member) => String(member["id"]) === memberId)))
    throw new ReadFailure("CLICKUP_SCOPE_OR_SCHEMA_REJECTED");
}

/** Resolve one message only after the parent channel and (for DMs) recipients
 * are verified. Opaque cursors are caller-supplied continuation, not authority. */
async function verifiedChatMessage(
  grant: ReadGrant,
  fetcher: typeof fetch,
  arguments_: Json,
): Promise<Json> {
  const channelId = id(arguments_["channel_id"]);
  const messageId = id(arguments_["message_id"]);
  const channel = await verifiedChatChannel(grant, fetcher, arguments_["channel_id"]);
  const kind = chatChannelType(channel);
  if (kind === "DM" || kind === "GROUP_DM") {
    const requested = validateRequestedRecipients(arguments_["user_ids"], arguments_["self_dm"]);
    await verifiedRecipientIds(grant, fetcher, requested);
    const actual = await verifiedChannelMembers(grant, fetcher, arguments_["channel_id"]);
    validateDirectMessageRecipients(channel, actual, grant.clickupUserId, requested);
  } else if (
    kind !== "CHANNEL" ||
    arguments_["user_ids"] !== undefined ||
    arguments_["self_dm"] !== undefined
  ) {
    throw new ReadFailure("CLICKUP_SCOPE_OR_SCHEMA_REJECTED");
  }
  const prefix = "workspaces/" + id(grant.workspaceId) + "/chat/";
  const params = new URLSearchParams({ limit: "50", content_format: "text/plain" });
  if (arguments_["chat_cursor"] !== undefined)
    params.set("cursor", boundedV3Cursor(arguments_["chat_cursor"]));
  const parentPage = await send(
    grant,
    fetcher,
    "GET",
    v3(prefix + "channels/" + channelId + "/messages?" + params),
  );
  const parents = chatCollection(parentPage, "messages", 50);
  let entries = parents;
  if (arguments_["parent_message_id"] !== undefined) {
    const parentId = id(arguments_["parent_message_id"]);
    if (!parents.some((entry) => String(entry["id"]) === String(arguments_["parent_message_id"])))
      throw new ReadFailure("CLICKUP_CHAT_MESSAGE_NOT_VERIFIED");
    const replyParams = new URLSearchParams({ limit: "50", content_format: "text/plain" });
    if (arguments_["reply_cursor"] !== undefined)
      replyParams.set("cursor", boundedV3Cursor(arguments_["reply_cursor"]));
    const page = await send(
      grant,
      fetcher,
      "GET",
      v3(prefix + "messages/" + parentId + "/replies?" + replyParams),
    );
    entries = chatCollection(page, "messages", 50);
  }
  const message = entries.find((entry) => String(entry["id"]) === messageId);
  if (!message) throw new ReadFailure("CLICKUP_CHAT_MESSAGE_NOT_VERIFIED");
  if (
    message["channel_id"] !== undefined &&
    String(message["channel_id"]) !== String(arguments_["channel_id"])
  )
    throw new ReadFailure("CLICKUP_SCOPE_OR_SCHEMA_REJECTED");
  return message;
}

async function scopedChatReactions(
  grant: ReadGrant,
  fetcher: typeof fetch,
  messageId: unknown,
  cursor?: unknown,
): Promise<{ reactions: Json[]; nextCursor: string | null }> {
  const params = new URLSearchParams({ limit: "50" });
  if (cursor !== undefined) params.set("cursor", boundedV3Cursor(cursor));
  const response = await send(
    grant,
    fetcher,
    "GET",
    v3(
      "workspaces/" +
        id(grant.workspaceId) +
        "/chat/messages/" +
        id(messageId) +
        "/reactions?" +
        params,
    ),
  );
  return {
    reactions: chatCollection(response, "reactions", 50),
    nextCursor: nextV3Cursor(response),
  };
}

export const OPERATIONAL_CATALOG_NAMES: readonly string[] = [
  "clickup_upload_task_attachment",
  "clickup_upload_file_field_attachment",
  "clickup_get_file_field_attachments",
  "clickup_associate_file_field_attachment",
  "clickup_get_workspace_plan",
  "clickup_get_workspace_seats",
  "clickup_update_own_time_entry",
  "clickup_delete_own_time_entry",
  "clickup_get_saved_view",
  "clickup_duplicate_saved_view",
  "clickup_rename_saved_view",
  "clickup_delete_saved_view",
  "clickup_create_webhook_subscription",
  "clickup_update_webhook_subscription",
  "clickup_delete_webhook_subscription",
  "clickup_get_workspace_custom_fields",
  "clickup_get_space_custom_fields",
  "clickup_get_folder_custom_fields",
  "clickup_clear_custom_field",
  "clickup_update_task_checklist",
  "clickup_delete_task_checklist",
  "clickup_delete_checklist_item",
  "clickup_create_list_comment",
  "clickup_get_space",
  "clickup_create_subfolder",
  "clickup_move_folder",
  "clickup_get_time_entry",
  "clickup_get_time_entry_history",
  "clickup_get_time_entry_tags",
  "clickup_get_user_groups",
  "clickup_get_chat_channel_followers",
  "clickup_get_space_views",
  "clickup_get_folder_views",
  "clickup_create_chat_channel",
  "clickup_update_goal_name",
  "clickup_update_key_result_progress",
  "clickup_get_pending_activity",
  "clickup_mark_consumer_activity_processed",
  "clickup_get_task_activity_timeline",
  "clickup_get_api_diagnostics",
  "clickup_acknowledge_activity",
  "clickup_get_shared_resources",
  "clickup_get_task_attachments",
  "clickup_get_list_templates",
  "clickup_get_folder_templates",
  "clickup_create_list_from_template",
  "clickup_create_folder_from_template",
  "clickup_preview_task_merge",
  "clickup_merge_tasks",
  "clickup_get_webhooks",
  "clickup_get_workspace_goals",
  "clickup_get_goal_details",
  "clickup_get_sprint_task_snapshot",
  "clickup_get_list_custom_fields",
  "clickup_get_list_members",
  "clickup_get_task_members",
  "clickup_get_list_comments",
  "clickup_get_space_tags",
  "clickup_get_my_attention_items",
  "clickup_filter_tasks",
  "clickup_get_my_tasks",
  "clickup_get_custom_task_types",
  "clickup_get_task_templates",
  "clickup_create_task_from_template",
  "clickup_search_workspace",
  "clickup_search_tasks_by_type",
  "clickup_search_tasks_by_tag",
  "clickup_create_task",
  "clickup_create_subtask",
  "clickup_list_direct_subtasks",
  "clickup_reparent_task",
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
  "clickup_read_task_image",
  "clickup_get_threaded_replies",
  "clickup_create_task_comment",
  "clickup_delete_task_comment",
  "clickup_edit_task_comment",
  "clickup_patch_task_comment",
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
  "clickup_get_chat_channel_details",
  "clickup_get_chat_channel_members",
  "clickup_open_direct_message",
  "clickup_verify_chat_recipients",
  "clickup_get_chat_channel_messages",
  "clickup_get_chat_message_replies",
  "clickup_create_chat_reply",
  "clickup_edit_own_chat_message",
  "clickup_delete_own_chat_message",
  "clickup_get_chat_message_reactions",
  "clickup_add_chat_reaction",
  "clickup_remove_own_chat_reaction",
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
  "clickup_upload_task_attachment",
  "clickup_upload_file_field_attachment",
  "clickup_get_file_field_attachments",
  "clickup_associate_file_field_attachment",
  "clickup_get_workspace_plan",
  "clickup_get_workspace_seats",
  "clickup_update_own_time_entry",
  "clickup_delete_own_time_entry",
  "clickup_get_saved_view",
  "clickup_duplicate_saved_view",
  "clickup_rename_saved_view",
  "clickup_delete_saved_view",
  "clickup_create_webhook_subscription",
  "clickup_update_webhook_subscription",
  "clickup_delete_webhook_subscription",
  "clickup_get_workspace_custom_fields",
  "clickup_get_space_custom_fields",
  "clickup_get_folder_custom_fields",
  "clickup_clear_custom_field",
  "clickup_update_task_checklist",
  "clickup_delete_task_checklist",
  "clickup_delete_checklist_item",
  "clickup_create_list_comment",
  "clickup_get_space",
  "clickup_create_subfolder",
  "clickup_move_folder",
  "clickup_get_time_entry",
  "clickup_get_time_entry_history",
  "clickup_get_time_entry_tags",
  "clickup_get_user_groups",
  "clickup_get_chat_channel_followers",
  "clickup_get_space_views",
  "clickup_get_folder_views",
  "clickup_create_chat_channel",
  "clickup_update_goal_name",
  "clickup_update_key_result_progress",
  "clickup_get_pending_activity",
  "clickup_mark_consumer_activity_processed",
  "clickup_get_task_activity_timeline",
  "clickup_get_api_diagnostics",
  "clickup_acknowledge_activity",
  "clickup_get_shared_resources",
  "clickup_get_task_attachments",
  "clickup_get_list_templates",
  "clickup_get_folder_templates",
  "clickup_create_list_from_template",
  "clickup_create_folder_from_template",
  "clickup_preview_task_merge",
  "clickup_get_webhooks",
  // These tools have Workspace-wide effects or return data outside the home List.
  "clickup_get_workspace_goals",
  "clickup_get_goal_details",
  "clickup_get_space_tags",
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
  "clickup_get_chat_channel_details",
  "clickup_get_chat_channel_members",
  "clickup_open_direct_message",
  "clickup_verify_chat_recipients",
  "clickup_get_chat_channel_messages",
  "clickup_get_chat_message_replies",
  "clickup_create_chat_reply",
  "clickup_edit_own_chat_message",
  "clickup_delete_own_chat_message",
  "clickup_get_chat_message_reactions",
  "clickup_add_chat_reaction",
  "clickup_remove_own_chat_reaction",
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
  "clickup_read_task_image",
  "clickup_get_threaded_replies",
  "clickup_create_task_comment",
  "clickup_delete_task_comment",
  "clickup_edit_task_comment",
  "clickup_patch_task_comment",
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
  // Test seam: the live MCP uses a real asynchronous delay, never a spin-loop.
  waitAfterRateLimit: (ms: number) => Promise<void> = (ms) =>
    new Promise<void>((resolve) => setTimeout(resolve, ms)),
): Promise<Json> {
  if (
    g.resourceScope !== "workspace" &&
    WORKSPACE_SCOPE_OPERATIONS.has(name) &&
    !(g.companyListTaskAccess === true && COMPANY_LIST_TASK_OPERATIONS.has(name))
  )
    throw new ReadFailure("CLICKUP_WORKSPACE_SCOPE_REQUIRED");
  const W = id(g.workspaceId),
    N = count(
      name === "clickup_get_pending_activity" && a["max_results"] === undefined
        ? { ...a, max_results: 50 }
        : a,
    );
  const workspaceScope = g.resourceScope === "workspace";
  const call = (method: Method, path: string, body?: Json, responseMode: ResponseMode = "strict") =>
    send(g, f, method, path, body, responseMode);
  const allowSharedTask =
    name === "clickup_get_task_attachments" ||
    name === "clickup_get_task" ||
    name === "clickup_get_task_comments" ||
    name === "clickup_get_task_activity_timeline" ||
    name === "clickup_create_task_comment";
  const task = async (k: string) => taskInWorkspace(g, f, a[k], allowSharedTask);
  const readTaskComments = async (taskId: string): Promise<Json> => {
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
  };
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
  /** Use ClickUp's documented parent-filtered Workspace task page while
   * retaining exact home-List and parent identity checks. No cross-List scan. */
  const directSubtasksPage = async (parent: Json, page: number): Promise<Json[]> => {
    if (!Number.isSafeInteger(page) || page < 0 || page > 100_000)
      throw new ReadFailure("CLICKUP_INVALID_ARGUMENT");
    const parentId = id(parent["id"]);
    const listId = id(obj(parent["list"])?.["id"]);
    const params = new URLSearchParams({
      parent: parentId,
      subtasks: "true",
      include_closed: "true",
      page: String(page),
    });
    params.append("list_ids[]", listId);
    const result = await call("GET", v2("team/" + W + "/task?" + params));
    const rows = result["tasks"];
    if (!Array.isArray(rows) || rows.length > 100) throw new ReadFailure("CLICKUP_BAD_RESPONSE");
    return rows.map((entry) => {
      const item = obj(entry);
      if (
        !item ||
        typeof item["id"] !== "string" ||
        String(item["parent"]) !== String(parent["id"]) ||
        String(obj(item["list"])?.["id"]) !== listId
      )
        throw new ReadFailure("CLICKUP_SCOPE_OR_SCHEMA_REJECTED");
      return item;
    });
  };

  /** Parent assignment must not point to the child or any descendant. */
  const verifiedReparentTarget = async (child: Json, target: Json): Promise<void> => {
    const listId = String(obj(child["list"])?.["id"]);
    let current: Json = target;
    const seen = new Set<string>();
    for (let depth = 0; depth < 20; depth += 1) {
      const key = String(current["id"]);
      if (
        key === String(child["id"]) ||
        seen.has(key) ||
        String(obj(current["list"])?.["id"]) !== listId
      )
        throw new ReadFailure("CLICKUP_SCOPE_OR_SCHEMA_REJECTED");
      seen.add(key);
      const ancestor = current["parent"];
      if (ancestor === null) return;
      if (typeof ancestor !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(ancestor))
        throw new ReadFailure("CLICKUP_SCOPE_OR_SCHEMA_REJECTED");
      current = await taskInWorkspace(g, f, ancestor);
    }
    throw new ReadFailure("CLICKUP_SUBTASK_ANCESTRY_INCOMPLETE");
  };
  const list = async (k: string) => listInWorkspace(g, f, a[k]);
  const folder = async (k: string) => folderInWorkspace(g, f, a[k]);
  // Only input-declared Workspace IDs can be supplied; they must match OAuth-bound Workspace.
  if (a["workspace_id"] !== undefined && String(a["workspace_id"]) !== g.workspaceId)
    throw new ReadFailure("CLICKUP_SCOPE_OR_SCHEMA_REJECTED");
  switch (name) {
    case "clickup_get_shared_resources": {
      const result = await call("GET", v2("team/" + W + "/shared"));
      const shared = obj(result["shared"]);
      if (!shared) throw new ReadFailure("CLICKUP_BAD_RESPONSE");
      const offset = Number(a["resource_offset"] ?? 0);
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > 100000)
        throw new ReadFailure("CLICKUP_INVALID_ARGUMENT");
      const rows: Json[] = [];
      for (const kind of ["tasks", "lists", "folders"]) {
        const entries = shared[kind];
        if (!Array.isArray(entries)) throw new ReadFailure("CLICKUP_BAD_RESPONSE");
        for (const entry of entries) {
          const item = obj(entry);
          if (!item || item["id"] === undefined) throw new ReadFailure("CLICKUP_BAD_RESPONSE");
          rows.push({ kind, id: item["id"], name: item["name"] ?? null });
        }
      }
      const visible = rows.slice(offset, offset + N);
      return {
        source: "clickup-api-v2",
        workspace_id: W,
        resources: visible,
        total: rows.length,
        next_resource_offset: offset + N < rows.length ? offset + N : null,
        incomplete: offset + N < rows.length,
      };
    }
    case "clickup_associate_file_field_attachment": {
      if (a["confirm_file_association"] !== true) throw new ReadFailure("CLICKUP_INVALID_ARGUMENT");
      const target = await task("task_id");
      const fieldId = val(a, "field_id");
      await verifiedFileField(g, f, target, fieldId);
      const fields = target["custom_fields"];
      if (!Array.isArray(fields)) throw new ReadFailure("CLICKUP_BAD_RESPONSE");
      const current = fields.map(obj).find((item) => item?.["id"] === fieldId)?.["value"];
      if (
        current !== undefined &&
        current !== null &&
        !(Array.isArray(current) && current.length === 0)
      )
        throw new ReadFailure("CLICKUP_FILE_FIELD_NOT_EMPTY");
      const uploadedId = txt(a["attachment_id"], 100);
      // An ID's presence in a shared field collection cannot prove that the
      // attachment was uploaded for this task by this authorized principal.
      if (!(await filePendingLedger(g, val(a, "task_id"), fieldId, uploadedId, "verify")))
        throw new ReadFailure("CLICKUP_SCOPE_OR_SCHEMA_REJECTED");
      const params = new URLSearchParams({ limit: "100" });
      if (a["attachment_cursor"] !== undefined)
        params.set("cursor", txt(a["attachment_cursor"], 500));
      const available = await call(
        "GET",
        v3("workspaces/" + W + "/custom_fields/" + fieldId + "/attachments?" + params),
      );
      if (
        !Array.isArray(available["data"]) ||
        !available["data"].some((entry) => {
          const row = obj(entry);
          return (
            row?.["id"] === uploadedId &&
            (row["parent_id"] === undefined || String(row["parent_id"]) === fieldId)
          );
        })
      )
        throw new ReadFailure("CLICKUP_SCOPE_OR_SCHEMA_REJECTED");
      // A permanent atomic claim serializes this field across Worker isolates,
      // principals and concurrent MCP requests. A failed/ambiguous write never
      // releases the claim, so it cannot be replayed as a replacement.
      if (!(await filePendingLedger(g, val(a, "task_id"), fieldId, uploadedId, "claim")))
        throw new ReadFailure("CLICKUP_FILE_FIELD_ALREADY_CLAIMED");
      // Revalidate immediately before POST to narrow an external ClickUp-edit
      // race. ClickUp offers no documented compare-and-swap for this field API.
      const latest = await task("task_id");
      const latestFields = latest["custom_fields"];
      if (!Array.isArray(latestFields)) throw new ReadFailure("CLICKUP_BAD_RESPONSE");
      const latestValue = latestFields.map(obj).find((row) => row?.["id"] === fieldId)?.["value"];
      if (
        latestValue !== undefined &&
        latestValue !== null &&
        !(Array.isArray(latestValue) && latestValue.length === 0)
      )
        throw new ReadFailure("CLICKUP_FILE_FIELD_NOT_EMPTY");
      await call(
        "POST",
        v2("task/" + val(a, "task_id") + "/field/" + fieldId),
        { value: uploadedId },
        "empty-write-ack",
      );
      const after = await task("task_id");
      const updatedFields = after["custom_fields"];
      if (!Array.isArray(updatedFields)) throw new ReadFailure("CLICKUP_WRITE_OUTCOME_UNKNOWN");
      const value = updatedFields.map(obj).find((item) => item?.["id"] === fieldId)?.["value"];
      const linked =
        value === uploadedId ||
        (Array.isArray(value) &&
          value.some((item) => item === uploadedId || obj(item)?.["id"] === uploadedId));
      if (!linked) throw new ReadFailure("CLICKUP_WRITE_OUTCOME_UNKNOWN");
      return {
        task_id: target["id"],
        field_id: fieldId,
        attachment_id: uploadedId,
        linked: true,
        retry_safe: false,
      };
    }
    case "clickup_get_file_field_attachments":
    case "clickup_get_task_attachments": {
      const target = await task("task_id");
      const isFileField = name === "clickup_get_file_field_attachments";
      const entityId = isFileField ? val(a, "field_id") : val(a, "task_id");
      if (isFileField) await verifiedFileField(g, f, target, entityId);
      const exactId = a["attachment_id"] === undefined ? null : txt(a["attachment_id"], 100);
      // Files fields can contain uploads belonging to other tasks. Never
      // enumerate unrelated objects when the caller only authorized one task.
      const values = Array.isArray(target["custom_fields"]) ? target["custom_fields"] : [];
      const fieldValue = isFileField
        ? values.map(obj).find((field) => field?.["id"] === entityId)?.["value"]
        : null;
      const links = Array.isArray(fieldValue) ? fieldValue : fieldValue ? [fieldValue] : [];
      const linkedIds = new Set(
        links
          .map((entry) => (typeof entry === "string" ? entry : String(obj(entry)?.["id"] ?? "")))
          .filter(Boolean),
      );
      if (isFileField && exactId && !linkedIds.has(exactId)) {
        // A task identifier plus a foreign attachment ID is not authorization.
        // The pending record must match this principal's successful upload.
        if (!(await filePendingLedger(g, val(a, "task_id"), entityId, exactId, "verify")))
          throw new ReadFailure("CLICKUP_SCOPE_OR_SCHEMA_REJECTED");
      }
      if (isFileField && !exactId && linkedIds.size === 0)
        return {
          source: "clickup-api-v3",
          attachments: [],
          next_attachment_cursor: null,
          incomplete: false,
          note: "No files are associated with this task field; provide an exact uploaded ID to check a pending upload.",
        };
      const params = new URLSearchParams({ limit: String(N) });
      if (a["attachment_cursor"] !== undefined)
        params.set("cursor", txt(a["attachment_cursor"], 500));
      let result: Json;
      try {
        result = await call(
          "GET",
          v3(
            "workspaces/" +
              W +
              "/" +
              (isFileField ? "custom_fields" : "attachments") +
              "/" +
              entityId +
              "/attachments?" +
              params,
          ),
        );
      } catch (error) {
        // Some existing ClickUp workspaces return 404 from v3 even when the
        // authorized task GET contains real attachments. Fall back only for
        // task metadata and only without a v3 continuation cursor.
        if (
          isFileField ||
          a["attachment_cursor"] !== undefined ||
          !(error instanceof ReadFailure) ||
          error.code !== "CLICKUP_UPSTREAM_UNAVAILABLE" ||
          error.diagnostic?.http_status !== 404
        )
          throw error;
        const legacy = target["attachments"];
        if (!Array.isArray(legacy)) throw error;
        const attachments = legacy.slice(0, N).map((entry) => {
          const item = obj(entry);
          if (!item || typeof item["id"] !== "string")
            throw new ReadFailure("CLICKUP_BAD_RESPONSE");
          return {
            id: item["id"],
            title: item["title"] ?? item["name"] ?? null,
            extension: item["extension"] ?? null,
            size: item["size"] ?? null,
            date_created: item["date_created"] ?? null,
            date_updated: item["date_updated"] ?? null,
            mime_type: item["mime_type"] ?? null,
          };
        });
        return {
          source: "clickup-api-v2-task-fallback",
          attachments,
          next_attachment_cursor: null,
          incomplete: true,
          note: "ClickUp v3 attachment listing returned 404. Showing bounded task metadata without pagination; completeness cannot be confirmed.",
        };
      }
      // Only expose metadata, not signed download URLs.
      const rows = result["data"];
      if (!Array.isArray(rows)) throw new ReadFailure("CLICKUP_BAD_RESPONSE");
      const visible = isFileField
        ? rows.filter((entry) => {
            const attachment = obj(entry);
            return (
              attachment &&
              (exactId ? attachment["id"] === exactId : linkedIds.has(String(attachment["id"])))
            );
          })
        : rows;
      const attachments = visible.slice(0, N).map((entry) => {
        const item = obj(entry);
        if (!item || item["id"] === undefined) throw new ReadFailure("CLICKUP_BAD_RESPONSE");
        return {
          id: item["id"],
          title: item["title"] ?? item["name"] ?? null,
          extension: item["extension"] ?? null,
          size: item["size"] ?? null,
          date_created: item["date_created"] ?? null,
          date_updated: item["date_updated"] ?? null,
          mime_type: item["mime_type"] ?? null,
        };
      });
      const next = result["next_cursor"] || null;
      if (next !== null && typeof next !== "string") throw new ReadFailure("CLICKUP_BAD_RESPONSE");
      return {
        source: "clickup-api-v3",
        attachments,
        next_attachment_cursor: next,
        incomplete: next !== null || rows.length > N,
      };
    }
    case "clickup_get_list_templates":
    case "clickup_get_folder_templates":
    case "clickup_create_list_from_template":
    case "clickup_create_folder_from_template": {
      const isFolder = name.includes("folder");
      const kind = isFolder ? "folder_template" : "list_template";
      const result = await call("GET", v2("team/" + W + "/" + kind));
      const rows = result["templates"];
      if (!Array.isArray(rows)) throw new ReadFailure("CLICKUP_BAD_RESPONSE");
      if (name.startsWith("clickup_get_")) {
        const offset = Number(a["resource_offset"] ?? 0);
        if (!Number.isSafeInteger(offset) || offset < 0 || offset > 100000)
          throw new ReadFailure("CLICKUP_INVALID_ARGUMENT");
        return {
          templates: clip(rows.slice(offset, offset + N)),
          next_resource_offset: offset + N < rows.length ? offset + N : null,
          incomplete: offset + N < rows.length,
        };
      }
      const wanted = txt(a["hierarchy_template_id"], 80);
      if (!/^t-[0-9]+$/.test(wanted) || !rows.some((row) => obj(row)?.["id"] === wanted))
        throw new ReadFailure("CLICKUP_SCOPE_OR_SCHEMA_REJECTED");
      const folderId = a["folder_id"];
      const spaceId = a["space_id"];
      if ((folderId === undefined) === (spaceId === undefined) || (isFolder && !spaceId))
        throw new ReadFailure("CLICKUP_INVALID_ARGUMENT");
      if (folderId !== undefined) await folder("folder_id");
      else await inWorkspace(g, f, spaceId);
      const parent = folderId === undefined ? "space/" + id(spaceId) : "folder/" + id(folderId);
      const created = await call("POST", v2(parent + "/" + kind + "/" + id(wanted)), {
        name: txt(a["name"], 180),
        options: { return_immediately: true },
      });
      return {
        acknowledgement: clip(created),
        completion_verified: false,
        retry_safe: false,
      };
    }
    case "clickup_preview_task_merge":
    case "clickup_merge_tasks": {
      const target = await task("task_id");
      const sources = a["task_ids"];
      if (!Array.isArray(sources) || sources.length < 1 || sources.length > 20)
        throw new ReadFailure("CLICKUP_INVALID_ARGUMENT");
      const ids = sources.map(id);
      if (new Set(ids).size !== ids.length || ids.includes(val(a, "task_id")))
        throw new ReadFailure("CLICKUP_INVALID_ARGUMENT");
      const preview = [];
      for (const source of ids) {
        const item = await taskInWorkspace(g, f, source);
        preview.push({
          id: item["id"],
          name: item["name"],
          list: obj(item["list"])?.["id"],
          date_updated: item["date_updated"] ?? null,
        });
      }
      const mergePreview = {
        target: {
          id: target["id"],
          name: target["name"],
          list: obj(target["list"])?.["id"],
          date_updated: target["date_updated"] ?? null,
        },
        sources: preview,
      };
      const fingerprint = await commentPatchFingerprint({
        workspace: W,
        actor: g.clickupUserId,
        ...mergePreview,
      });
      if (name === "clickup_preview_task_merge")
        return { ...mergePreview, fingerprint, irreversible: true, merged: false };
      if (a["confirm_merge"] !== true || a["expected_merge_fingerprint"] !== fingerprint)
        throw new ReadFailure("CLICKUP_SCOPE_OR_SCHEMA_REJECTED");
      const result = await call(
        "POST",
        v2("task/" + val(a, "task_id") + "/merge"),
        { source_task_ids: ids },
        "empty-write-ack",
      );
      // The response acknowledges a native merge; never repeat after uncertainty.
      return { acknowledgement: clip(result), readback_verified: false, retry_safe: false };
    }
    case "clickup_get_pending_activity":
    case "clickup_mark_consumer_activity_processed":
    case "clickup_acknowledge_activity": {
      if (!g.webhookEvents) throw new ReadFailure("CLICKUP_EVENT_STORAGE_UNAVAILABLE");
      const binding = g.webhookEvents;
      const stub = binding.get(binding.idFromName(W + ":" + g.subject) as never);
      const validKey = (key: unknown): key is string =>
        typeof key === "string" && /^[a-f0-9-]{36}:[a-zA-Z0-9_-]{1,100}$/i.test(key);
      const consumer = a["activity_consumer"];
      if (consumer !== undefined && !validActivityConsumer(consumer))
        throw new ReadFailure("CLICKUP_INVALID_ARGUMENT");
      if (name === "clickup_mark_consumer_activity_processed") {
        const keys = a["event_keys"];
        if (
          !validActivityConsumer(consumer) ||
          !Array.isArray(keys) ||
          keys.length < 1 ||
          keys.length > 50 ||
          !keys.every(validKey)
        )
          throw new ReadFailure("CLICKUP_INVALID_ARGUMENT");
        await taskInWorkspace(g, f, a["task_id"], true);
        const result = await stub.fetch(
          new Request("https://internal/consumer-processed", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ task_id: a["task_id"], consumer, event_keys: keys }),
          }),
        );
        if (!result.ok) throw new ReadFailure("CLICKUP_EVENT_ACKNOWLEDGEMENT_FAILED");
        const body = obj(await result.json());
        const expected = [...new Set(keys)];
        if (
          body?.["consumer"] !== consumer ||
          JSON.stringify(body["processed_event_keys"]) !== JSON.stringify(expected)
        )
          throw new ReadFailure("CLICKUP_WRITE_OUTCOME_UNKNOWN");
        return { consumer, task_id: a["task_id"], processed_event_keys: expected };
      }
      if (name === "clickup_acknowledge_activity") {
        const keys = a["event_keys"];
        if (
          a["confirm_review"] !== true ||
          !Array.isArray(keys) ||
          keys.length < 1 ||
          keys.length > 50 ||
          !keys.every(validKey)
        )
          throw new ReadFailure("CLICKUP_INVALID_ARGUMENT");
        await taskInWorkspace(g, f, a["task_id"], true);
        const result = await stub.fetch(
          new Request("https://internal/acknowledge", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ task_id: a["task_id"], event_keys: keys }),
          }),
        );
        if (!result.ok) throw new ReadFailure("CLICKUP_EVENT_ACKNOWLEDGEMENT_FAILED");
        const body = obj(await result.json());
        const expected = [...new Set(keys)];
        if (
          !Array.isArray(body?.["acknowledged_event_keys"]) ||
          JSON.stringify(body["acknowledged_event_keys"]) !== JSON.stringify(expected)
        )
          throw new ReadFailure("CLICKUP_WRITE_OUTCOME_UNKNOWN");
        return { task_id: a["task_id"], acknowledged_event_keys: expected };
      }
      const eventTypes = a["activity_event_types"];
      const receivedSince = a["activity_received_since_ms"];
      const actor = a["activity_actor_user_id"];
      const mentioned = a["activity_mentioned_user_id"];
      const validUserId = (value: unknown): value is string =>
        typeof value === "string" && /^[1-9]\d{0,23}$/.test(value);
      if (
        (eventTypes !== undefined &&
          (!Array.isArray(eventTypes) ||
            eventTypes.length < 1 ||
            eventTypes.length > 20 ||
            eventTypes.some(
              (value: unknown) =>
                typeof value !== "string" || !/^task[A-Z][A-Za-z]{1,40}$/.test(value),
            ))) ||
        (receivedSince !== undefined &&
          (typeof receivedSince !== "number" ||
            !Number.isSafeInteger(receivedSince) ||
            receivedSince < 0)) ||
        (actor !== undefined && !validUserId(actor)) ||
        (mentioned !== undefined && !validUserId(mentioned))
      )
        throw new ReadFailure("CLICKUP_INVALID_ARGUMENT");
      const afterTime = a["event_after_time"];
      const afterKey = a["event_after_key"];
      if (
        (afterTime === undefined) !== (afterKey === undefined) ||
        (afterTime !== undefined &&
          (typeof afterTime !== "number" || !Number.isSafeInteger(afterTime) || afterTime < 0)) ||
        (afterKey !== undefined && !validKey(afterKey))
      )
        throw new ReadFailure("CLICKUP_INVALID_ARGUMENT");
      // The Durable Object deliberately emits just ten events per page.
      // Read until storage is exhausted (or an explicitly requested page size),
      // and verify each distinct task once. No application-imposed event,
      // page, task-verification or requests-per-minute budget.
      const grouped = new Map<string, Json>();
      const denied = new Set<string>();
      const notFound = new Set<string>();
      const verifiedLists = new Map<string, number>();
      const eventLimit = a["max_results"] === undefined ? Infinity : N;
      let cursorTime = afterTime as number | undefined;
      let cursorKey = afterKey as string | undefined;
      let eventsScanned = 0;
      let filteredEvents = 0;
      let missingMetadataEvents = 0;
      let pagesScanned = 0;
      let hasMore = true;
      let interruptedReason: string | null = null;
      let interruptedCode: string | null = null;
      let interruptedHttpStatus: number | null = null;
      while (hasMore && eventsScanned - filteredEvents < eventLimit) {
        const url = new URL("https://internal/pending");
        if (typeof consumer === "string") url.searchParams.set("consumer", consumer);
        if (cursorTime !== undefined && cursorKey !== undefined) {
          url.searchParams.set("after_time", String(cursorTime));
          url.searchParams.set("after_key", cursorKey);
        }
        const response = await stub.fetch(new Request(url));
        if (!response.ok) throw new ReadFailure("CLICKUP_EVENT_STORAGE_UNAVAILABLE");
        const body = obj(await response.json());
        const events = body?.["events"];
        if (
          !Array.isArray(events) ||
          events.length > 10 ||
          typeof body?.["incomplete"] !== "boolean" ||
          (events.length === 0 && body["incomplete"] === true)
        )
          throw new ReadFailure("CLICKUP_BAD_RESPONSE");
        pagesScanned++;
        hasMore = body["incomplete"] === true;
        for (const raw of events) {
          if (eventsScanned - filteredEvents === eventLimit) {
            hasMore = true;
            break;
          }
          const event = obj(raw);
          if (
            !event ||
            !validKey(event["event_key"]) ||
            typeof event["task_id"] !== "string" ||
            typeof event["event"] !== "string" ||
            typeof event["received_at"] !== "number" ||
            !Number.isSafeInteger(event["received_at"]) ||
            (cursorTime !== undefined &&
              (event["received_at"] < cursorTime ||
                (event["received_at"] === cursorTime && event["event_key"] <= (cursorKey ?? ""))))
          )
            throw new ReadFailure("CLICKUP_BAD_RESPONSE");
          const metadata = sanitizeWebhookMetadata(event["metadata"]);
          const mentions = metadata["mentioned_user_ids"];
          const baseMatches =
            (!Array.isArray(eventTypes) || eventTypes.includes(event["event"])) &&
            (typeof receivedSince !== "number" || event["received_at"] >= receivedSince);
          const actorUnknown = actor !== undefined && metadata["actor_user_id"] === undefined;
          const mentionUnknown = mentioned !== undefined && !Array.isArray(mentions);
          if (
            !baseMatches ||
            (actor !== undefined && metadata["actor_user_id"] !== actor) ||
            (typeof mentioned === "string" &&
              (!Array.isArray(mentions) || !mentions.includes(mentioned)))
          ) {
            if (baseMatches && (actorUnknown || mentionUnknown)) missingMetadataEvents++;
            cursorTime = event["received_at"];
            cursorKey = event["event_key"];
            eventsScanned++;
            filteredEvents++;
            continue;
          }
          const taskId = event["task_id"];
          let group = grouped.get(taskId);
          if (!group && !denied.has(taskId)) {
            // GET-only verification is safe to retry. A genuine ClickUp 429
            // pauses this read, then resumes the *same* event; there is no
            // artificial retry-count or request-rate ceiling. If the MCP
            // caller disconnects, unacknowledged storage remains untouched.
            let transientRetries = 0;
            for (;;) {
              try {
                const item = await taskInWorkspace(g, f, taskId, true, verifiedLists);
                group = {
                  task_id: item["id"],
                  name: item["name"],
                  status: clip(item["status"]),
                  url: item["url"],
                  events: [],
                };
                grouped.set(taskId, group);
                break;
              } catch (error) {
                if (!(error instanceof ReadFailure)) throw error;
                if (error.code === "CLICKUP_RATE_LIMITED") {
                  verifiedLists.clear();
                  await waitAfterRateLimit(60_000);
                  continue;
                }
                if (error.code === "CLICKUP_PENDING_TASK_NOT_FOUND") {
                  // Deleted/inaccessible tasks must not block all later hints.
                  // Keep their events unacknowledged and report only a count.
                  notFound.add(taskId);
                  denied.add(taskId);
                  break;
                }
                const status = error.diagnostic?.http_status;
                const retryable =
                  error.code === "CLICKUP_QUOTA_UNAVAILABLE" ||
                  error.code === "CLICKUP_BAD_RESPONSE" ||
                  (error.code === "CLICKUP_UPSTREAM_UNAVAILABLE" &&
                    (status === undefined || status === 408 || status === 425 || status >= 500));
                if (retryable && transientRetries < 2) {
                  verifiedLists.clear();
                  transientRetries++;
                  await waitAfterRateLimit(transientRetries * 1000);
                  continue;
                }
                if (
                  error.code !== "CLICKUP_UPSTREAM_DENIED" &&
                  error.code !== "CLICKUP_SCOPE_OR_SCHEMA_REJECTED" &&
                  error.code !== "CLICKUP_WORKSPACE_SCOPE_REQUIRED"
                ) {
                  interruptedReason = "task_verification_unavailable";
                  interruptedCode = error.code;
                  interruptedHttpStatus = error.diagnostic?.http_status ?? null;
                  hasMore = true;
                  break;
                }
                // Inaccessible task hints must never expose titles or IDs.
                denied.add(taskId);
                break;
              }
            }
          }
          if (interruptedReason) break;
          if (group) {
            (group["events"] as Json[]).push({
              event_key: event["event_key"],
              event: event["event"],
              received_at: event["received_at"],
              ...(Object.keys(metadata).length ? { metadata } : {}),
            });
          }
          // Advance only after processing this event. In particular, do not
          // skip the event if a read was interrupted by an upstream error.
          cursorTime = event["received_at"];
          cursorKey = event["event_key"];
          eventsScanned++;
        }
        if (interruptedReason) break;
      }
      const incomplete = hasMore || denied.size > 0 || interruptedReason !== null;
      return {
        tasks: [...grouped.values()],
        unverified_task_count: denied.size,
        task_not_found_count: notFound.size,
        events_scanned: eventsScanned,
        events_filtered_before_verification: filteredEvents,
        events_filtered_missing_metadata: missingMetadataEvents,
        ...(typeof consumer === "string" ? { consumer } : {}),
        pages_scanned: pagesScanned,
        partial: incomplete,
        interrupted_reason: interruptedReason,
        interrupted_code: interruptedCode,
        interrupted_http_status: interruptedHttpStatus,
        next_event_after_time: hasMore ? (cursorTime ?? null) : null,
        next_event_after_key: hasMore ? (cursorKey ?? null) : null,
        resume_from_beginning: hasMore && eventsScanned === 0 && afterTime === undefined,
        incomplete,
        read_only: true,
        note: "Reading never acknowledges events. Named consumers have independent processed-event receipts, including globally reviewed events until individually processed. Keep filters unchanged across cursor pages. Explicit actor and mention filters exclude unknown metadata; absence is not proof of no mention. Retrieve current comments for context.",
      };
    }
    case "clickup_get_workspace_custom_fields":
    case "clickup_get_space_custom_fields":
    case "clickup_get_folder_custom_fields": {
      let parent = "team/" + W;
      if (name === "clickup_get_space_custom_fields") {
        await inWorkspace(g, f, a["space_id"]);
        parent = "space/" + val(a, "space_id");
      } else if (name === "clickup_get_folder_custom_fields") {
        await folder("folder_id");
        parent = "folder/" + val(a, "folder_id");
      }
      const result = await call(
        "GET",
        v2(parent + "/field?include_applied_objects=" + (a["include_applied_objects"] !== false)),
      );
      if (!Array.isArray(result["fields"]) || result["fields"].some((x) => !obj(x)))
        throw new ReadFailure("CLICKUP_BAD_RESPONSE");
      const fields = result["fields"].slice(0, N);
      return {
        source: "clickup-api-v2",
        fields: clip(fields),
        fields_in_response: result["fields"].length,
        incomplete:
          result["fields"].length > N || hasClippedNestedArray(fields) || hasClippedText(fields),
      };
    }
    case "clickup_clear_custom_field": {
      const target = await task("task_id");
      const fields = target["custom_fields"];
      if (
        a["confirm_delete"] !== true ||
        !Array.isArray(fields) ||
        !fields.some((field) => String(obj(field)?.["id"]) === String(a["field_id"]))
      )
        throw new ReadFailure("CLICKUP_SCOPE_OR_SCHEMA_REJECTED");
      await call(
        "DELETE",
        v2("task/" + val(a, "task_id") + "/field/" + val(a, "field_id")),
        undefined,
        "empty-write-ack",
      );
      const after = await task("task_id");
      const updated = Array.isArray(after["custom_fields"])
        ? after["custom_fields"].map(obj).find((x) => String(x?.["id"]) === String(a["field_id"]))
        : null;
      if (!updated || (updated["value"] !== undefined && updated["value"] !== null))
        throw new ReadFailure("CLICKUP_WRITE_OUTCOME_UNKNOWN");
      return { success: true, task_id: a["task_id"], field_id: a["field_id"], verified: true };
    }
    case "clickup_update_task_checklist":
    case "clickup_delete_task_checklist":
    case "clickup_delete_checklist_item": {
      const target = await task("task_id");
      const checklist = authorizedTaskChecklist(target, a["checklist_id"]);
      const path = v2("checklist/" + checklistId(a["checklist_id"]));
      const patch: Json = {};
      let targetPath = path;
      if (name === "clickup_delete_checklist_item") {
        const items = checklist["items"];
        if (!Array.isArray(items) || !items.some((x) => obj(x)?.["id"] === a["checklist_item_id"]))
          throw new ReadFailure("CLICKUP_SCOPE_OR_SCHEMA_REJECTED");
        targetPath += "/checklist_item/" + checklistId(a["checklist_item_id"]);
      }
      if (name === "clickup_update_task_checklist") {
        if (a["name"] !== undefined) patch["name"] = txt(a["name"], 180);
        if (a["position"] !== undefined) {
          if (!Number.isSafeInteger(a["position"]) || Number(a["position"]) < 0)
            throw new ReadFailure("CLICKUP_INVALID_ARGUMENT");
          patch["position"] = a["position"];
        }
        if (!Object.keys(patch).length) throw new ReadFailure("CLICKUP_INVALID_ARGUMENT");
        await call("PUT", path, patch, "empty-write-ack");
      } else {
        if (a["confirm_delete"] !== true) throw new ReadFailure("CLICKUP_INVALID_ARGUMENT");
        await call("DELETE", targetPath, undefined, "empty-write-ack");
      }
      const after = await task("task_id");
      if (!Array.isArray(after["checklists"]))
        throw new ReadFailure("CLICKUP_WRITE_OUTCOME_UNKNOWN");
      const next = after["checklists"].map(obj).find((x) => x?.["id"] === a["checklist_id"]);
      const verified =
        name === "clickup_delete_task_checklist"
          ? !next
          : name === "clickup_delete_checklist_item"
            ? !!next &&
              Array.isArray(next["items"]) &&
              !next["items"].some((x) => obj(x)?.["id"] === a["checklist_item_id"])
            : !!next &&
              (patch["name"] === undefined || next["name"] === patch["name"]) &&
              (patch["position"] === undefined || next["position"] === patch["position"]);
      if (!verified) throw new ReadFailure("CLICKUP_WRITE_OUTCOME_UNKNOWN");
      return {
        success: true,
        verified_by_readback: true,
        task_id: a["task_id"],
        checklist_id: a["checklist_id"],
        ...(a["checklist_item_id"] !== undefined
          ? { checklist_item_id: a["checklist_item_id"] }
          : {}),
      };
    }
    case "clickup_create_list_comment": {
      await list("list_id");
      const assignee =
        a["assignee_id"] === undefined
          ? null
          : await verifiedCommentAssignee(a["assignee_id"], g, f);
      return short(
        await call("POST", v2("list/" + val(a, "list_id") + "/comment"), {
          comment_text: txt(a["text"], 6000),
          assignee,
          notify_all: false,
        }),
      );
    }
    case "clickup_get_space": {
      await inWorkspace(g, f, a["space_id"]);
      const result = await call("GET", v2("space/" + val(a, "space_id")));
      if (String(result["id"]) !== String(a["space_id"]))
        throw new ReadFailure("CLICKUP_SCOPE_OR_SCHEMA_REJECTED");
      return short(result);
    }
    case "clickup_create_subfolder": {
      const parent = await folder("folder_id");
      const spaceId = id(obj(parent["space"])?.["id"]);
      return short(
        await call("POST", v2("space/" + spaceId + "/folder"), {
          name: txt(a["name"], 180),
          parent_folder_id: a["folder_id"],
        }),
      );
    }
    case "clickup_move_folder": {
      await folder("folder_id");
      const destinationFolder = a["destination_folder_id"];
      const destinationSpace = a["space_id"];
      if ((destinationFolder === undefined) === (destinationSpace === undefined))
        throw new ReadFailure("CLICKUP_INVALID_ARGUMENT");
      if (destinationFolder !== undefined) {
        if (String(destinationFolder) === String(a["folder_id"]))
          throw new ReadFailure("CLICKUP_INVALID_ARGUMENT");
        await folder("destination_folder_id");
      } else await inWorkspace(g, f, destinationSpace);
      const body: Json =
        destinationFolder !== undefined
          ? { parent_folder_id: destinationFolder }
          : { space_id: destinationSpace };
      if (a["position"] !== undefined) {
        if (!Number.isSafeInteger(a["position"]) || Number(a["position"]) < 0)
          throw new ReadFailure("CLICKUP_INVALID_ARGUMENT");
        body["position"] = a["position"];
      }
      await call("PUT", v2("folder/" + val(a, "folder_id") + "/position"), body, "empty-write-ack");
      const after = await folder("folder_id");
      const actualParent = obj(after["parent_folder"])?.["id"] ?? after["parent_folder"];
      if (
        destinationFolder !== undefined
          ? String(actualParent) !== String(destinationFolder)
          : String(obj(after["space"])?.["id"]) !== String(destinationSpace) ||
            (actualParent !== undefined && actualParent !== null)
      )
        throw new ReadFailure("CLICKUP_WRITE_OUTCOME_UNKNOWN");
      return { success: true, verified_by_readback: true, folder: clip(after) };
    }
    case "clickup_get_time_entry":
    case "clickup_get_time_entry_history":
    case "clickup_update_own_time_entry":
    case "clickup_delete_own_time_entry": {
      const path = v2("team/" + W + "/time_entries/" + val(a, "timer_id"));
      const result = await call("GET", path);
      const entry = obj(result["data"]);
      if (!entry || String(entry["id"]) !== String(a["timer_id"]))
        throw new ReadFailure("CLICKUP_SCOPE_OR_SCHEMA_REJECTED");
      const linkedTask = obj(entry["task"])?.["id"];
      if (linkedTask !== undefined && linkedTask !== null) await taskInWorkspace(g, f, linkedTask);
      else if (String(obj(entry["user"])?.["id"]) !== g.clickupUserId)
        throw new ReadFailure("CLICKUP_SCOPE_OR_SCHEMA_REJECTED");
      if (name === "clickup_get_time_entry") return short(result, N);
      if (name === "clickup_get_time_entry_history")
        return short(await call("GET", path + "/history"), N);
      if (String(obj(entry["user"])?.["id"]) !== g.clickupUserId || Number(entry["duration"]) < 0)
        throw new ReadFailure("CLICKUP_SCOPE_OR_SCHEMA_REJECTED");
      if (name === "clickup_delete_own_time_entry") {
        if (a["confirm_delete"] !== true) throw new ReadFailure("CLICKUP_INVALID_ARGUMENT");
        await call("DELETE", path, undefined, "empty-write-ack");
        return { timer_id: a["timer_id"], deletion_acknowledged: true, retry_safe: false };
      }
      const patch: Json = {};
      if (a["description"] !== undefined) patch["description"] = txt(a["description"], 8000);
      if (a["billable"] !== undefined) {
        if (typeof a["billable"] !== "boolean") throw new ReadFailure("CLICKUP_INVALID_ARGUMENT");
        patch["billable"] = a["billable"];
      }
      if (a["start_ms"] !== undefined || a["end_ms"] !== undefined) {
        const start = a["start_ms"];
        const end = a["end_ms"];
        if (
          typeof start !== "number" ||
          typeof end !== "number" ||
          !Number.isSafeInteger(start) ||
          !Number.isSafeInteger(end) ||
          start <= 0 ||
          end <= start ||
          end > Date.now()
        )
          throw new ReadFailure("CLICKUP_INVALID_ARGUMENT");
        patch["start"] = start;
        patch["end"] = end;
      }
      if (!Object.keys(patch).length) throw new ReadFailure("CLICKUP_INVALID_ARGUMENT");
      await call("PUT", path, patch, "empty-write-ack");
      const after = obj((await call("GET", path))["data"]);
      if (
        !after ||
        String(after["id"]) !== String(a["timer_id"]) ||
        Object.entries(patch).some(([key, value]) =>
          key === "start" || key === "end" ? Number(after[key]) !== value : after[key] !== value,
        )
      )
        throw new ReadFailure("CLICKUP_WRITE_OUTCOME_UNKNOWN");
      return { timer_id: a["timer_id"], updated: true, verified_by_readback: true };
    }
    case "clickup_get_time_entry_tags":
      return short(await call("GET", v2("team/" + W + "/time_entries/tags")), N);
    case "clickup_get_user_groups":
      return short(await call("GET", v2("group?team_id=" + W)), N);
    case "clickup_get_chat_channel_followers": {
      await verifiedChatChannel(g, f, a["channel_id"]);
      const params = new URLSearchParams({ limit: String(N) });
      if (a["chat_cursor"] !== undefined) params.set("cursor", boundedV3Cursor(a["chat_cursor"]));
      const result = await call(
        "GET",
        v3("workspaces/" + W + "/chat/channels/" + val(a, "channel_id") + "/followers?" + params),
      );
      const entries = chatCollection(result, "followers", N);
      const cursor = nextV3Cursor(result);
      return {
        source: "clickup-api-v3",
        followers: clip(entries),
        next_cursor: cursor,
        incomplete: cursor !== null || entries.length === N,
      };
    }
    case "clickup_get_saved_view":
    case "clickup_duplicate_saved_view":
    case "clickup_rename_saved_view":
    case "clickup_delete_saved_view": {
      const parentType = a["view_parent_type"];
      const parentId = val(a, "view_parent_id");
      let route: string;
      let type: number;
      switch (parentType) {
        case "workspace":
          if (parentId !== W) throw new ReadFailure("CLICKUP_SCOPE_OR_SCHEMA_REJECTED");
          route = "team";
          type = 7;
          break;
        case "space":
          await inWorkspace(g, f, parentId);
          route = "space";
          type = 4;
          break;
        case "folder":
          await folderInWorkspace(g, f, parentId);
          route = "folder";
          type = 5;
          break;
        case "list":
          await listInWorkspace(g, f, parentId);
          route = "list";
          type = 6;
          break;
        default:
          throw new ReadFailure("CLICKUP_INVALID_ARGUMENT");
      }
      const viewId = val(a, "view_id");
      const path = v2("view/" + viewId);
      const read = async (target: string, expected: string) => {
        const response = await call("GET", target);
        const view = obj(response["view"]) ?? response;
        const parent = obj(view["parent"]);
        if (
          String(view["id"]) !== expected ||
          String(parent?.["id"]) !== parentId ||
          Number(parent?.["type"]) !== type
        )
          throw new ReadFailure("CLICKUP_SCOPE_OR_SCHEMA_REJECTED");
        return view;
      };
      const view = await read(path, viewId);
      if (name === "clickup_get_saved_view") return short(view);
      const title = txt(a["name"], 180);
      if (name === "clickup_delete_saved_view") {
        if (a["confirm_delete"] !== true || view["name"] !== title)
          throw new ReadFailure("CLICKUP_INVALID_ARGUMENT");
        await call("DELETE", path, undefined, "empty-write-ack");
        return { view_id: viewId, deletion_acknowledged: true, retry_safe: false };
      }
      const configuration: Json = { name: title, type: view["type"] };
      if (typeof view["type"] !== "string") throw new ReadFailure("CLICKUP_BAD_RESPONSE");
      for (const key of [
        "grouping",
        "divide",
        "sorting",
        "filters",
        "columns",
        "team_sidebar",
        "settings",
      ]) {
        const value = obj(view[key]);
        if (!value) throw new ReadFailure("CLICKUP_BAD_RESPONSE");
        configuration[key] = value;
      }
      if (name === "clickup_duplicate_saved_view") {
        const created = await call("POST", v2(route + "/" + parentId + "/view"), configuration);
        const newId = id((obj(created["view"]) ?? created)["id"]);
        const verified = await read(v2("view/" + newId), newId);
        if (verified["name"] !== title || newId === viewId)
          throw new ReadFailure("CLICKUP_WRITE_OUTCOME_UNKNOWN");
        return { view: clip(verified), verified_by_readback: true };
      }
      await call(
        "PUT",
        path,
        { ...configuration, parent: { id: parentId, type } },
        "empty-write-ack",
      );
      const verified = await read(path, viewId);
      if (verified["name"] !== title) throw new ReadFailure("CLICKUP_WRITE_OUTCOME_UNKNOWN");
      return { view: clip(verified), verified_by_readback: true };
    }
    case "clickup_get_space_views":
    case "clickup_get_folder_views": {
      const isSpace = name === "clickup_get_space_views";
      const key = isSpace ? "space_id" : "folder_id";
      if (isSpace) await inWorkspace(g, f, a[key]);
      else await folder(key);
      const result = await call(
        "GET",
        v2((isSpace ? "space/" : "folder/") + val(a, key) + "/view"),
      );
      if (!Array.isArray(result["views"])) throw new ReadFailure("CLICKUP_BAD_RESPONSE");
      return {
        views: clip(result["views"].slice(0, N)),
        incomplete: result["views"].length > N,
      };
    }
    case "clickup_create_chat_channel": {
      const visibility = a["channel_visibility"];
      if (visibility !== "PUBLIC" && visibility !== "PRIVATE")
        throw new ReadFailure("CLICKUP_INVALID_ARGUMENT");
      const users = a["user_ids"] ?? [];
      if (!Array.isArray(users) || users.length > 15 || users.some((x) => typeof x !== "string"))
        throw new ReadFailure("CLICKUP_INVALID_ARGUMENT");
      await verifiedRecipientIds(g, f, users as string[]);
      const result = await call("POST", v3("workspaces/" + W + "/chat/channels"), {
        name: txt(a["name"], 180),
        visibility,
        user_ids: users,
        ...(a["description"] !== undefined ? { description: txt(a["description"], 8000) } : {}),
      });
      const channel = chatEntity(result, "channel");
      const verified = await verifiedChatChannel(g, f, channel["id"]);
      return { channel: clip(verified), created_or_existing: true };
    }
    case "clickup_update_goal_name":
    case "clickup_update_key_result_progress": {
      const goalId = val(a, "goal_id");
      const before = await readGoalDetails(W, goalId, 1000, (path) => call("GET", path));
      if (name === "clickup_update_goal_name") {
        const title = txt(a["name"], 180);
        await call("PUT", v2("goal/" + goalId), { name: title }, "empty-write-ack");
        const after = await readGoalDetails(W, goalId, 1000, (path) => call("GET", path));
        if (obj(after["goal"])?.["name"] !== title)
          throw new ReadFailure("CLICKUP_WRITE_OUTCOME_UNKNOWN");
        return { success: true, goal_id: goalId, verified_by_readback: true };
      }
      const targets = obj(before["goal"])?.["key_results"];
      const resultId = val(a, "key_result_id");
      if (!Array.isArray(targets) || !targets.some((x) => obj(x)?.["id"] === resultId))
        throw new ReadFailure("CLICKUP_SCOPE_OR_SCHEMA_REJECTED");
      if (!Number.isSafeInteger(a["steps_current"]))
        throw new ReadFailure("CLICKUP_INVALID_ARGUMENT");
      await call(
        "PUT",
        v2("key_result/" + resultId),
        { steps_current: a["steps_current"], note: txt(a["text"], 6000) },
        "empty-write-ack",
      );
      const after = await readGoalDetails(W, goalId, 1000, (path) => call("GET", path));
      const updated = obj(after["goal"])?.["key_results"];
      const target = Array.isArray(updated)
        ? updated.map(obj).find((x) => x?.["id"] === resultId)
        : null;
      if (!target || Number(target["steps_current"]) !== a["steps_current"])
        throw new ReadFailure("CLICKUP_WRITE_OUTCOME_UNKNOWN");
      return { success: true, key_result_id: resultId, verified_by_readback: true };
    }
    case "clickup_create_webhook_subscription":
    case "clickup_update_webhook_subscription":
    case "clickup_delete_webhook_subscription": {
      if (!g.webhookEvents || !g.webhookOrigin)
        throw new ReadFailure("CLICKUP_EVENT_STORAGE_UNAVAILABLE");
      const origin = new URL(g.webhookOrigin);
      if (
        origin.protocol !== "https:" ||
        origin.origin !== g.webhookOrigin ||
        origin.username ||
        origin.password
      )
        throw new ReadFailure("CLICKUP_NOT_CONFIGURED");
      const endpoint = origin.origin + "/clickup/webhook";
      const allowedEvents = [
        "taskCreated",
        "taskUpdated",
        "taskDeleted",
        "taskPriorityUpdated",
        "taskStatusUpdated",
        "taskAssigneeUpdated",
        "taskDueDateUpdated",
        "taskTagUpdated",
        "taskMoved",
        "taskCommentPosted",
        "taskCommentUpdated",
        "taskTimeEstimateUpdated",
        "taskTimeTrackedUpdated",
      ];
      const events = a["webhook_events"] ?? allowedEvents;
      const validId = (value: unknown): value is string =>
        typeof value === "string" && /^[a-f0-9-]{36}$/i.test(value);
      const binding = g.webhookEvents;
      const registry = binding.get(binding.idFromName("registry:" + W) as never);
      const registryUrl = (webhookId: string) =>
        "https://internal/registry?webhook_id=" + encodeURIComponent(webhookId);
      if (name === "clickup_create_webhook_subscription") {
        if (a["confirm_subscription"] !== true) throw new ReadFailure("CLICKUP_INVALID_ARGUMENT");
        if (
          !Array.isArray(events) ||
          !events.length ||
          events.length > allowedEvents.length ||
          !events.every((event) => allowedEvents.includes(event as string)) ||
          new Set(events).size !== events.length
        )
          throw new ReadFailure("CLICKUP_INVALID_ARGUMENT");
        const keys = ["space_id", "folder_id", "list_id", "task_id"].filter(
          (key) => a[key] !== undefined,
        );
        if (keys.length > 1) throw new ReadFailure("CLICKUP_INVALID_ARGUMENT");
        const key = keys[0];
        if (key === "space_id") await inWorkspace(g, f, a[key]);
        else if (key === "folder_id") await folder(key);
        else if (key === "list_id") await list(key);
        else if (key === "task_id") await task(key);
        const scope = key ? { [key]: key === "task_id" ? a[key] : Number(a[key]) } : {};
        if (key && key !== "task_id" && !Number.isSafeInteger(scope[key]))
          throw new ReadFailure("CLICKUP_INVALID_ARGUMENT");
        const response = await call("POST", v2("team/" + W + "/webhook"), {
          endpoint,
          events,
          ...scope,
        });
        const webhook = obj(response["webhook"]) ?? response;
        const webhookId = webhook["id"] ?? response["id"];
        const secret = webhook["secret"] ?? response["secret"];
        if (!validId(webhookId) || typeof secret !== "string" || !secret || secret.length > 512)
          throw new ReadFailure("CLICKUP_WRITE_OUTCOME_UNKNOWN");
        let saved: Response;
        try {
          saved = await registry.fetch(
            new Request(registryUrl(webhookId), {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ workspaceId: W, subject: g.subject, secret }),
            }),
          );
        } catch {
          return { webhook_id: webhookId, registered: true, signing_secret_saved: false };
        }
        return {
          webhook_id: webhookId,
          registered: true,
          signing_secret_saved: saved.ok,
          delivery_verified: false,
          ...(saved.ok
            ? {}
            : { action_required: "Reconcile upstream registration; do not recreate blindly." }),
        };
      }
      const webhookId = a["webhook_id"];
      if (!validId(webhookId)) throw new ReadFailure("CLICKUP_INVALID_ARGUMENT");
      const stored = await registry.fetch(new Request(registryUrl(webhookId)));
      if (!stored.ok) throw new ReadFailure("CLICKUP_SCOPE_OR_SCHEMA_REJECTED");
      const registration = obj(await stored.json());
      if (registration?.["subject"] !== g.subject || registration["workspaceId"] !== W)
        throw new ReadFailure("CLICKUP_SCOPE_OR_SCHEMA_REJECTED");
      const inventory = await call("GET", v2("team/" + W + "/webhook"));
      const rows = inventory["webhooks"];
      if (
        !Array.isArray(rows) ||
        !rows.some((row) => {
          const item = obj(row);
          return item?.["id"] === webhookId && item["endpoint"] === endpoint;
        })
      )
        throw new ReadFailure("CLICKUP_SCOPE_OR_SCHEMA_REJECTED");
      if (name === "clickup_delete_webhook_subscription") {
        if (a["confirm_delete"] !== true) throw new ReadFailure("CLICKUP_INVALID_ARGUMENT");
        await call("DELETE", v2("webhook/" + webhookId), undefined, "empty-write-ack");
        const after = await call("GET", v2("team/" + W + "/webhook"));
        if (
          !Array.isArray(after["webhooks"]) ||
          after["webhooks"].some((row) => obj(row)?.["id"] === webhookId)
        )
          throw new ReadFailure("CLICKUP_WRITE_OUTCOME_UNKNOWN");
        const removed = await registry.fetch(
          new Request(registryUrl(webhookId), { method: "DELETE" }),
        );
        return { webhook_id: webhookId, deleted: true, signing_secret_removed: removed.ok };
      }
      if (
        a["confirm_subscription"] !== true ||
        !Array.isArray(events) ||
        !events.length ||
        events.length > allowedEvents.length ||
        !events.every((event) => allowedEvents.includes(event as string)) ||
        new Set(events).size !== events.length
      )
        throw new ReadFailure("CLICKUP_INVALID_ARGUMENT");
      await call(
        "PUT",
        v2("webhook/" + webhookId),
        { endpoint, events, status: "active" },
        "empty-write-ack",
      );
      const after = await call("GET", v2("team/" + W + "/webhook"));
      const updated = Array.isArray(after["webhooks"])
        ? after["webhooks"].map(obj).find((row) => row?.["id"] === webhookId)
        : null;
      const actual = updated?.["events"];
      if (
        updated?.["endpoint"] !== endpoint ||
        !Array.isArray(actual) ||
        actual.length !== events.length ||
        !events.every((event) => actual.includes(event))
      )
        throw new ReadFailure("CLICKUP_WRITE_OUTCOME_UNKNOWN");
      return { webhook_id: webhookId, updated: true, verified_by_readback: true };
    }
    case "clickup_get_workspace_plan":
    case "clickup_get_workspace_seats":
      return short(
        await call(
          "GET",
          v2("team/" + W + (name === "clickup_get_workspace_plan" ? "/plan" : "/seats")),
        ),
      );
    case "clickup_get_webhooks": {
      const result = await call("GET", v2("team/" + W + "/webhook"));
      const rows = result["webhooks"];
      if (!Array.isArray(rows)) throw new ReadFailure("CLICKUP_BAD_RESPONSE");
      const offset = Number(a["resource_offset"] ?? 0);
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > 100000)
        throw new ReadFailure("CLICKUP_INVALID_ARGUMENT");
      return {
        webhooks: rows.slice(offset, offset + N).map((entry) => {
          const item = obj(entry);
          if (!item || item["id"] === undefined) throw new ReadFailure("CLICKUP_BAD_RESPONSE");
          return { id: item["id"], events: clip(item["events"]), status: clip(item["health"]) };
        }),
        next_resource_offset: offset + N < rows.length ? offset + N : null,
        incomplete: offset + N < rows.length,
      };
    }
    case "clickup_get_workspace_goals": {
      const completed = a["include_completed"] ?? false;
      const offset = a["goal_offset"] ?? 0;
      if (
        typeof completed !== "boolean" ||
        !Number.isInteger(offset) ||
        Number(offset) < 0 ||
        Number(offset) > 10_000
      )
        throw new ReadFailure("CLICKUP_INVALID_ARGUMENT");
      const result = await readWorkspaceGoals(W, completed, Number(offset), N, (path) =>
        call("GET", path),
      );
      return {
        ...(clip(result) as Json),
        incomplete:
          result["incomplete"] === true || hasClippedNestedArray(result) || hasClippedText(result),
      };
    }
    case "clickup_get_goal_details": {
      const goalId = val(a, "goal_id");
      const result = await readGoalDetails(W, goalId, N, (path) => call("GET", path));
      return {
        ...(clip(result) as Json),
        incomplete:
          result["incomplete"] === true || hasClippedNestedArray(result) || hasClippedText(result),
      };
    }
    case "clickup_get_sprint_task_snapshot": {
      const page = a["task_page"] ?? 0;
      const offset = a["task_offset"] ?? 0;
      if (
        !Number.isInteger(page) ||
        Number(page) < 0 ||
        Number(page) > 100_000 ||
        !Number.isInteger(offset) ||
        Number(offset) < 0 ||
        Number(offset) > 99
      )
        throw new ReadFailure("CLICKUP_INVALID_ARGUMENT");
      // The preflight is required even for a Workspace-granted OAuth identity.
      await list("list_id");
      const result = await readSprintTaskSnapshot(
        val(a, "list_id"),
        Number(page),
        Number(offset),
        N,
        (path) => call("GET", path),
      );
      return {
        ...(clip(result) as Json),
        incomplete:
          result["incomplete"] === true || hasClippedNestedArray(result) || hasClippedText(result),
      };
    }
    case "clickup_get_list_custom_fields": {
      await list("list_id");
      const result = await call(
        "GET",
        v2(
          "list/" +
            val(a, "list_id") +
            "/field?include_applied_objects=" +
            (a["include_applied_objects"] === false ? "false" : "true"),
        ),
      );
      if (
        !Array.isArray(result["fields"]) ||
        result["fields"].some((field: unknown) => !obj(field))
      )
        throw new ReadFailure("CLICKUP_BAD_RESPONSE");
      const fields = result["fields"] as Json[];
      const selected = fields.slice(0, N);
      return {
        source: "clickup-api-v2",
        list_id: String(a["list_id"]),
        fields: clip(selected),
        fields_in_response: fields.length,
        include_applied_objects: a["include_applied_objects"] !== false,
        incomplete:
          fields.length > N || hasClippedNestedArray(selected) || hasClippedText(selected),
      };
    }
    case "clickup_get_list_members":
    case "clickup_get_task_members": {
      const listMembers = name === "clickup_get_list_members";
      if (listMembers) await list("list_id");
      else await task("task_id");
      const resourceId = val(a, listMembers ? "list_id" : "task_id");
      const result = await call(
        "GET",
        v2((listMembers ? "list/" : "task/") + resourceId + "/member"),
      );
      if (
        !Array.isArray(result["members"]) ||
        result["members"].some((member: unknown) => !obj(member))
      )
        throw new ReadFailure("CLICKUP_BAD_RESPONSE");
      const members = result["members"] as Json[];
      return {
        source: "clickup-api-v2",
        ...(listMembers ? { list_id: String(a["list_id"]) } : { task_id: String(a["task_id"]) }),
        members: clip(members.slice(0, N)),
        members_in_response: members.length,
        explicit_access_only: true,
        inherited_permissions_not_included: true,
        incomplete:
          members.length > N ||
          hasClippedNestedArray(members.slice(0, N)) ||
          hasClippedText(members.slice(0, N)),
      };
    }
    case "clickup_get_space_tags": {
      await inWorkspace(g, f, a["space_id"]);
      const result = await call("GET", v2("space/" + val(a, "space_id") + "/tag"));
      if (!Array.isArray(result["tags"]) || result["tags"].some((tag: unknown) => !obj(tag)))
        throw new ReadFailure("CLICKUP_BAD_RESPONSE");
      const tags = result["tags"] as Json[];
      return {
        source: "clickup-api-v2",
        space_id: String(a["space_id"]),
        tags: clip(tags.slice(0, N)),
        tags_in_response: tags.length,
        incomplete:
          tags.length > N ||
          hasClippedNestedArray(tags.slice(0, N)) ||
          hasClippedText(tags.slice(0, N)),
      };
    }
    case "clickup_get_list_comments": {
      await list("list_id");
      let cursor = inputCommentCursor(a);
      const comments: Json[] = [];
      const seen = new Set<string>();
      let pagesScanned = 0;
      let next: CommentCursor | null = null;
      let incomplete = false;
      let continuationUnavailable = false;
      for (let pageIndex = 0; pageIndex < 3; pageIndex++) {
        const params = new URLSearchParams();
        if (cursor !== null) {
          params.set("start", String(cursor.start));
          params.set("start_id", cursor.startId);
        }
        const result = await call(
          "GET",
          v2(
            "list/" +
              val(a, "list_id") +
              "/comment" +
              (cursor !== null ? "?" + params.toString() : ""),
          ),
        );
        if (
          !Array.isArray(result["comments"]) ||
          result["comments"].length > 25 ||
          result["comments"].some((entry: unknown) => {
            const comment = obj(entry);
            return !comment || typeof comment["id"] !== "string";
          })
        )
          throw new ReadFailure("CLICKUP_BAD_RESPONSE");
        const batch = result["comments"] as Json[];
        pagesScanned++;
        for (const comment of batch) {
          const key = String(comment["id"]);
          if (seen.has(key)) throw new ReadFailure("CLICKUP_BAD_RESPONSE");
          seen.add(key);
        }
        const visible = batch.slice(0, N - comments.length);
        comments.push(...visible);
        const mayHaveMore = batch.length === 25 || batch.length > visible.length;
        next = mayHaveMore ? commentCursorFrom(visible[visible.length - 1]!) : null;
        if (mayHaveMore && !next) continuationUnavailable = true;
        incomplete = mayHaveMore;
        if (comments.length === N || batch.length < 25 || !next) break;
        cursor = next;
      }
      const payloadClipped =
        hasClippedText({ comments }) ||
        comments.some(
          (entry) =>
            Array.isArray(entry["comment"]) && (entry["comment"] as unknown[]).length > 100,
        );
      return {
        source: "clickup-api-v2",
        list_id: String(a["list_id"]),
        comments: clip(comments),
        pages_scanned: pagesScanned,
        next_comment_start: next?.start ?? null,
        next_comment_start_id: next?.startId ?? null,
        incomplete: incomplete || payloadClipped,
        content_truncated: payloadClipped,
        continuation_unavailable: continuationUnavailable,
      };
    }
    case "clickup_get_my_attention_items": {
      const report = await getMyAttentionItems(
        a,
        g,
        (path) => call("GET", v2(path)),
        async (listId) => {
          await listInWorkspace(g, f, listId);
        },
      );
      if (!g.webhookEvents || !workspaceScope || a["list_id"] !== undefined) return report;
      // Events are only hints. Never disclose an ID or title without a fresh
      // authorized upstream task read, including individually shared tasks.
      const verified: Json[] = [];
      let incomplete: boolean;
      let scanned = 0;
      try {
        const binding = g.webhookEvents;
        const stub = binding.get(binding.idFromName(W + ":" + g.subject) as never);
        const result = await stub.fetch(new Request("https://internal/recent"));
        if (!result.ok) throw new ReadFailure("CLICKUP_EVENT_STORAGE_UNAVAILABLE");
        const body = obj(await result.json());
        const candidates = body?.["tasks"];
        if (!Array.isArray(candidates) || candidates.length > 50)
          throw new ReadFailure("CLICKUP_BAD_RESPONSE");
        const cap = Math.min(N, 10);
        incomplete = body?.["incomplete"] === true || candidates.length > cap;
        for (const row of candidates.slice(0, cap)) {
          const candidate = obj(row);
          scanned++;
          try {
            const item = await taskInWorkspace(g, f, candidate?.["task_id"], true);
            verified.push({
              task_id: item["id"],
              name: item["name"],
              status: clip(item["status"]),
              received_at: candidate?.["received_at"],
              url: item["url"],
            });
          } catch (error) {
            if (!(error instanceof ReadFailure)) throw error;
            incomplete = true;
          }
        }
      } catch {
        incomplete = true;
      }
      return {
        ...report,
        webhook_activity: {
          recent_verified_tasks: verified,
          candidates_scanned: scanned,
          incomplete,
          note: "Recent change hints, not Inbox notifications or proof that attention is required.",
        },
      };
    }
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
      // Search direct shares independently of normal task-page pagination.
      // Keep a distinct collection so these results never consume task cursors.
      let sharedResources: Json[] = [];
      let sharedDiscoveryUnavailable = false;
      try {
        const result = await call("GET", v2("team/" + W + "/shared"));
        const shared = obj(result["shared"]);
        if (!shared) throw new ReadFailure("CLICKUP_BAD_RESPONSE");
        for (const kind of ["tasks", "lists", "folders"]) {
          const entries = shared[kind];
          if (!Array.isArray(entries)) throw new ReadFailure("CLICKUP_BAD_RESPONSE");
          for (const entry of entries) {
            const item = obj(entry);
            if (!item || item["id"] === undefined) throw new ReadFailure("CLICKUP_BAD_RESPONSE");
            if (match(item))
              sharedResources.push({ kind, id: item["id"], name: item["name"] ?? null });
          }
        }
      } catch (error) {
        if (!(error instanceof ReadFailure)) throw error;
        sharedResources = [];
        sharedDiscoveryUnavailable = true;
      }
      return {
        source: "clickup-api",
        scope: "workspace",
        shared_resources: clip(sharedResources.slice(0, N)),
        shared_discovery_unavailable: sharedDiscoveryUnavailable,
        tasks: clip(matchingTasks.slice(0, N)),
        pages_scanned: pagesScanned,
        next_task_page: nextTaskPage,
        next_task_offset: nextTaskOffset,
        docs: clip(d.filter(match).slice(0, N)),
        lists: clip(foundLists.filter(match).slice(0, N)),
        folders: clip(foundFolders.filter(match).slice(0, N)),
        incomplete:
          taskPageTruncated ||
          sharedDiscoveryUnavailable ||
          sharedResources.length > N ||
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
    case "clickup_create_subtask": {
      // One real ClickUp child: parent is not a related-task link or checklist.
      const payload = taskBody(buildArgs(a, "new_task"));
      if (!payload["name"]) throw new ReadFailure("CLICKUP_INVALID_ARGUMENT");
      const parent = await task("parent_task_id");
      if (parent["parent"] === undefined) throw new ReadFailure("CLICKUP_BAD_RESPONSE");
      const homeListId = id(obj(parent["list"])?.["id"]);
      // A retry after an ambiguous POST may create duplicate work. Refuse a
      // duplicate title on this exact parent and any incomplete preflight page.
      const existing = await directSubtasksPage(parent, 0);
      if (existing.length === 100)
        throw new ReadFailure("CLICKUP_SUBTASK_DUPLICATE_CHECK_INCOMPLETE");
      if (existing.some((child) => child["name"] === payload["name"]))
        throw new ReadFailure("CLICKUP_SUBTASK_POSSIBLE_DUPLICATE");
      const created = await call("POST", v2("list/" + homeListId + "/task"), {
        ...payload,
        parent: parent["id"],
        notify_all: false,
      });
      const createdId = created["id"];
      if (typeof createdId !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(createdId))
        throw new ReadFailure("CLICKUP_WRITE_OUTCOME_UNKNOWN");
      let after: Json;
      try {
        after = await taskInWorkspace(g, f, createdId);
      } catch {
        // Do not repeat a possibly successful POST.
        throw new ReadFailure("CLICKUP_WRITE_OUTCOME_UNKNOWN");
      }
      if (
        String(after["parent"]) !== String(parent["id"]) ||
        String(obj(after["list"])?.["id"]) !== homeListId ||
        after["name"] !== payload["name"]
      )
        throw new ReadFailure("CLICKUP_WRITE_OUTCOME_UNKNOWN");
      return {
        source: "clickup-api-v2",
        task_id: createdId,
        parent_task_id: parent["id"],
        verified_by_readback: true,
        task: short(after),
      };
    }
    case "clickup_list_direct_subtasks": {
      const parent = await task("parent_task_id");
      const page = a["task_page"] ?? 0;
      const offset = a["task_offset"] ?? 0;
      if (
        !Number.isInteger(page) ||
        Number(page) < 0 ||
        Number(page) > 100_000 ||
        !Number.isInteger(offset) ||
        Number(offset) < 0 ||
        Number(offset) > 99
      )
        throw new ReadFailure("CLICKUP_INVALID_ARGUMENT");
      const children = await directSubtasksPage(parent, Number(page));
      const selected = children.slice(Number(offset), Number(offset) + N);
      const advanced = Number(offset) + selected.length;
      const hasNext = advanced < children.length || children.length === 100;
      return {
        source: "clickup-api-v2",
        parent_task_id: parent["id"],
        subtasks: clip(selected),
        next_task_page: hasNext ? (advanced < 100 ? page : Number(page) + 1) : null,
        next_task_offset: hasNext ? (advanced < 100 ? advanced : 0) : null,
        incomplete: hasNext,
        home_list_id: obj(parent["list"])?.["id"],
      };
    }
    case "clickup_reparent_task": {
      const childId = val(a, "task_id");
      const newParentId = val(a, "parent_task_id");
      if (childId === newParentId) throw new ReadFailure("CLICKUP_INVALID_ARGUMENT");
      const expectedName = txt(a["expected_task_name"], 180);
      const expectedBefore = a["expected_current_parent_id"];
      if (
        typeof expectedBefore !== "string" ||
        (expectedBefore !== "none" && !/^[a-zA-Z0-9_-]{1,80}$/.test(expectedBefore))
      )
        throw new ReadFailure("CLICKUP_INVALID_ARGUMENT");
      const child = await task("task_id");
      const parent = await task("parent_task_id");
      const wasParent = child["parent"];
      if (
        child["name"] !== expectedName ||
        (expectedBefore === "none" ? wasParent !== null : String(wasParent) !== expectedBefore) ||
        String(obj(child["list"])?.["id"]) !== String(obj(parent["list"])?.["id"])
      )
        throw new ReadFailure("CLICKUP_SCOPE_OR_SCHEMA_REJECTED");
      await verifiedReparentTarget(child, parent);
      if (String(wasParent) === newParentId)
        return {
          source: "clickup-api-v2",
          task_id: child["id"],
          parent_task_id: parent["id"],
          already_under_parent: true,
          verified_by_readback: true,
        };
      // Update Task documents {parent: <task id>}. It does not detach to
      // top-level by passing null; preserve the original task ID/history.
      try {
        await call("PUT", v2("task/" + childId), { parent: newParentId });
      } catch (error) {
        if (!(error instanceof ReadFailure) || error.code !== "CLICKUP_WRITE_OUTCOME_UNKNOWN")
          throw error;
      }
      let after: Json;
      try {
        after = await taskInWorkspace(g, f, child["id"]);
      } catch {
        throw new ReadFailure("CLICKUP_WRITE_OUTCOME_UNKNOWN");
      }
      if (
        String(after["id"]) !== childId ||
        String(after["parent"]) !== newParentId ||
        String(obj(after["list"])?.["id"]) !== String(obj(child["list"])?.["id"]) ||
        after["name"] !== expectedName
      )
        throw new ReadFailure("CLICKUP_WRITE_OUTCOME_UNKNOWN");
      return {
        source: "clickup-api-v2",
        task_id: child["id"],
        previous_parent_id: wasParent,
        parent_task_id: parent["id"],
        verified_by_readback: true,
        task: short(after),
      };
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
    case "clickup_get_task": {
      const observedAt = Date.now();
      const verified = await task("task_id");
      await captureVerifiedTask(g, verified, observedAt);
      return short(verified);
    }
    case "clickup_read_task_image": {
      // Same authoritative Workspace and home-List preflight as task/PDF reads.
      const verified = await task("task_id");
      const attachments = verified["attachments"];
      if (!Array.isArray(attachments) || attachments.length > 200)
        throw new ReadFailure("CLICKUP_SCOPE_OR_SCHEMA_REJECTED");
      const selected = attachments
        .map(obj)
        .find((item) => String(item?.["id"]) === String(a["attachment_id"]));
      if (!selected) throw new ReadFailure("CLICKUP_SCOPE_OR_SCHEMA_REJECTED");
      const { readVerifiedTaskImage } = await import("./image-reader.js");
      return readVerifiedTaskImage(selected, f, g.workspaceId);
    }
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
        // Verify task identity again before deleting, then independently enumerate
        // direct children. ClickUp may omit "subtasks" on GET even when there are none;
        // absence of that field must not be mistaken for an authorization failure.
        const before = await taskInWorkspace(g, f, val(a, "task_id"));
        if (
          String(before["id"]) !== String(existing["id"]) ||
          String(obj(before["list"])?.["id"]) !== String(obj(existing["list"])?.["id"]) ||
          before["name"] !== title
        )
          throw new ReadFailure("CLICKUP_SCOPE_OR_SCHEMA_REJECTED");
        const children = await directSubtasksPage(before, 0);
        if (children.length !== 0) throw new ReadFailure("CLICKUP_SCOPE_OR_SCHEMA_REJECTED");
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
    case "clickup_upload_task_attachment":
    case "clickup_upload_file_field_attachment":
    case "clickup_attach_file_to_task": {
      const entity =
        name === "clickup_upload_task_attachment"
          ? { type: "attachments" as const, id: val(a, "task_id") }
          : name === "clickup_upload_file_field_attachment"
            ? { type: "custom_fields" as const, id: val(a, "field_id") }
            : undefined;
      return uploadAttachment(
        g,
        f,
        String(a["task_id"]),
        txt(a["file_name"], 120),
        txt(a["file_base64"], 700000),
        typeof a["media_type"] === "string" ? a["media_type"] : "application/octet-stream",
        entity,
      );
    }
    case "clickup_get_task_activity_timeline": {
      const current = await task("task_id");
      const taskId = String(a["task_id"]);
      const events: Json[] = [];
      const issues: string[] = [];
      const timestamp = (value: unknown): number | null => {
        if (
          (typeof value !== "number" && typeof value !== "string") ||
          !/^\d{1,15}$/.test(String(value))
        )
          return null;
        const number = Number(value);
        return Number.isSafeInteger(number) && number > 0 ? number : null;
      };
      const addAnchor = (field: string, kind: string) => {
        const at = timestamp(current[field]);
        if (at !== null) events.push({ kind, at_ms: at, source: "current_task_snapshot" });
      };
      addAnchor("date_created", "task_created");
      addAnchor("date_updated", "task_last_updated");
      addAnchor("date_closed", "task_closed");
      addAnchor("date_done", "task_done");
      const comments = await readTaskComments(taskId).catch((error: unknown) => {
        issues.push(error instanceof ReadFailure ? error.code : "comment_read_unavailable");
        return null;
      });
      const rows = comments?.["comments"];
      const commentIds = new Set<string>();
      if (Array.isArray(rows)) {
        for (const value of rows) {
          const row = obj(value);
          const at = timestamp(row?.["date"]);
          if (!row || at === null) {
            issues.push("comment_timestamp_unavailable");
            continue;
          }
          const commentId = String(row["id"]);
          commentIds.add(commentId);
          const author = obj(row["user"]);
          const text = row["comment_text"];
          events.push({
            kind: "comment",
            at_ms: at,
            source: "clickup_comment",
            comment_id: commentId,
            author_id: author?.["id"] ?? null,
            author_name: typeof author?.["username"] === "string" ? author["username"] : null,
            text: typeof text === "string" ? text.slice(0, 1000) : null,
            text_truncated: typeof text === "string" && text.length > 1000,
            resolved: row["resolved"] ?? null,
            assigned_to: obj(row["assignee"])?.["id"] ?? null,
          });
        }
      }
      let webhookCount = 0;
      let webhookIncomplete = true;
      if (g.webhookEvents) {
        try {
          const binding = g.webhookEvents;
          const stub = binding.get(binding.idFromName(W + ":" + g.subject) as never);
          const result = await stub.fetch(
            new Request("https://internal/task-timeline?task_id=" + id(taskId)),
          );
          if (!result.ok) throw new ReadFailure("CLICKUP_EVENT_STORAGE_UNAVAILABLE");
          const body = obj(await result.json());
          if (!Array.isArray(body?.["events"]) || body["events"].length > 50)
            throw new ReadFailure("CLICKUP_BAD_RESPONSE");
          webhookIncomplete = body["incomplete"] === true;
          for (const value of body["events"]) {
            const row = obj(value);
            if (!row || typeof row["event"] !== "string") {
              webhookIncomplete = true;
              continue;
            }
            const metadata = sanitizeWebhookMetadata(row["metadata"]);
            const at = timestamp(metadata["occurred_at"] ?? row["received_at"]);
            if (at === null) {
              webhookIncomplete = true;
              continue;
            }
            webhookCount++;
            if (
              row["event"] === "taskCommentPosted" &&
              typeof metadata["comment_id"] === "string" &&
              commentIds.has(metadata["comment_id"])
            )
              continue;
            events.push({
              kind: row["event"],
              at_ms: at,
              source: "retained_webhook_hint",
              time_basis: metadata["occurred_at"] ? "occurred_at" : "received_at",
              metadata,
            });
          }
        } catch (error) {
          issues.push(error instanceof ReadFailure ? error.code : "event_storage_unavailable");
        }
      } else issues.push("event_storage_unconfigured");
      events.sort((left, right) => Number(left["at_ms"]) - Number(right["at_ms"]));
      return {
        task: {
          id: taskId,
          name: current["name"],
          status: obj(current["status"])?.["status"] ?? null,
          list_id: obj(current["list"])?.["id"] ?? null,
          url: current["url"] ?? null,
        },
        timeline: events,
        coverage: {
          comments_read: Array.isArray(rows) ? rows.length : 0,
          comments_incomplete: comments === null || comments["incomplete"] !== false,
          next_comment_start: comments?.["next_comment_start"] ?? null,
          next_comment_start_id: comments?.["next_comment_start_id"] ?? null,
          webhook_events_read: webhookCount,
          webhook_incomplete: webhookIncomplete,
          webhook_retention_days: 7,
          threaded_replies_included: false,
          native_activity_history_available: false,
          issues: [...new Set(issues)],
        },
        incomplete: true,
        note: "Chronological evidence, not a complete native activity log. Snapshot timestamps do not identify the change or actor. Webhook hints are bounded and may overlap comments.",
      };
    }
    case "clickup_get_api_diagnostics": {
      const issues: string[] = [];
      let quota: Json | null = null;
      let webhook: Json | null = null;
      try {
        const stub = g.quota.get(g.quota.idFromName("clickup-account:" + g.clickupUserId) as never);
        const result = await stub.fetch(
          new Request("https://internal.invalid/diagnostics", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ subject: g.subject }),
          }),
        );
        if (!result.ok) throw new Error("quota unavailable");
        const parsed = obj(await result.json());
        if (!parsed || !Array.isArray(parsed["days"])) throw new Error("quota unavailable");
        quota = parsed;
      } catch {
        issues.push("quota_diagnostics_unavailable");
      }
      if (g.webhookEvents) {
        try {
          const binding = g.webhookEvents;
          const stub = binding.get(binding.idFromName(W + ":" + g.subject) as never);
          const result = await stub.fetch(new Request("https://internal/diagnostics"));
          if (!result.ok) throw new Error("event storage unavailable");
          webhook = obj(await result.json());
          if (!webhook) throw new Error("event storage unavailable");
        } catch {
          issues.push("webhook_diagnostics_unavailable");
        }
      } else issues.push("event_storage_unconfigured");
      return {
        quota,
        webhook,
        issues,
        incomplete: issues.length > 0,
        note: "UTC day buckets since instrumentation was deployed. Allowed reservations are not confirmed upstream responses; cooldowns count recorded reset signals, not every 429. Upstream outcomes cover instrumented catalogue invocations only; status 0 means no HTTP response. Latency is time to response headers. Telemetry is best-effort. No request bodies, credentials or URLs are retained.",
      };
    }
    case "clickup_get_task_comments": {
      const observedAt = Date.now();
      const verified = await task("task_id");
      const result = await readTaskComments(String(a["task_id"]));
      await captureVerifiedTask(g, verified, observedAt);
      await captureVerifiedComments(
        g,
        verified,
        result["comments"],
        observedAt,
        result["incomplete"] === false,
      );
      return result;
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
        // Unknown upstream outcomes must become *data*, not an MCP transport
        // error that a caller might interpret as permission to repeat the POST.
        // In particular a timed-out/5xx POST may already have been committed.
        const uncertain = (commentId?: string) => ({
          ...(commentId === undefined ? {} : { id: commentId, comment_id: commentId }),
          write_acknowledged: commentId !== undefined,
          write_outcome: "unknown",
          readback_status: "inconclusive",
          verified_by_readback: false,
          native_rich_structure_verified_by_readback: false,
          verified_tag_structure_by_readback: false,
          mention_identity_verified_by_readback: false,
          requested_mention_user_ids: requestedIds,
          notification_delivery_unverified: true,
          retry_safe: false,
          reconciliation: {
            tool: "clickup_get_task_comments",
            task_id: taskId,
            ...(commentId === undefined ? {} : { comment_id: commentId }),
          },
          warning:
            "The comment write could not be fully verified. Inspect existing task comments before any new write; do not automatically repost.",
        });
        let posted: Json;
        try {
          posted = await call("POST", v2("task/" + taskId + "/comment"), {
            comment: rich,
            notify_all: false,
            ...(assignee === null ? {} : { assignee }),
          });
        } catch (error) {
          if (error instanceof ReadFailure && error.code === "CLICKUP_WRITE_OUTCOME_UNKNOWN")
            return uncertain();
          throw error;
        }
        const commentId = posted["id"];
        if (
          (typeof commentId !== "number" && typeof commentId !== "string") ||
          !/^[0-9]{1,24}$/.test(String(commentId))
        )
          return uncertain();
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
          // The POST returned a valid ID, but readback could not verify it.
          return uncertain(String(commentId));
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
    case "clickup_patch_task_comment": {
      await task("task_id");
      const taskId = val(a, "task_id");
      const commentId = val(a, "comment_id");
      const path = v2("task/" + taskId + "/comment");
      const readOwn = async (): Promise<Json> => {
        const result = await call("GET", path);
        if (!Array.isArray(result["comments"])) throw new ReadFailure("CLICKUP_BAD_RESPONSE");
        const item = result["comments"]
          .map(obj)
          .find((entry) => String(entry?.["id"]) === commentId);
        if (!item || String(obj(item["user"])?.["id"]) !== g.clickupUserId)
          throw new ReadFailure("CLICKUP_SCOPE_OR_SCHEMA_REJECTED");
        return item;
      };
      const original = await readOwn();
      const before = canonicalPatchComment(original["comment"]);
      const rawAssignee = original["assignee"];
      const assignee = rawAssignee === null ? 0 : Number(obj(rawAssignee)?.["id"] ?? rawAssignee);
      if (
        original["group_assignee"] != null ||
        !Number.isSafeInteger(assignee) ||
        assignee < 0 ||
        (typeof original["resolved"] !== "boolean" &&
          !(original["resolved"] === undefined && assignee === 0))
      )
        throw new ReadFailure("CLICKUP_SCOPE_OR_SCHEMA_REJECTED");
      const resolved = original["resolved"] === true;
      const input = a["rich_segments"];
      const wantsMentions =
        Array.isArray(input) &&
        input.some((segment) => obj(segment)?.["mention_user_id"] !== undefined);
      const eligible = new Set(
        wantsMentions ? (await members(g, f)).map((user) => String(user["id"])) : [],
      );
      const replacement =
        input === undefined ? [] : compileClickUpRichSegments(input, eligible).segments;
      const next = patchRichComment(before, a["patch_start"], a["patch_delete_count"], replacement);
      const fingerprint = await commentPatchFingerprint({
        taskId,
        commentId,
        author: g.clickupUserId,
        before,
        next,
        assignee,
        resolved,
        start: a["patch_start"],
        count: a["patch_delete_count"],
      });
      if (a["confirm_patch"] !== true) {
        if (a["expected_patch_fingerprint"] !== undefined)
          throw new ReadFailure("CLICKUP_INVALID_ARGUMENT");
        return {
          preview: true,
          task_id: taskId,
          comment_id: commentId,
          fingerprint,
          before,
          after: next,
          write_performed: false,
        };
      }
      if (a["expected_patch_fingerprint"] !== fingerprint)
        throw new ReadFailure("CLICKUP_SCOPE_OR_SCHEMA_REJECTED");
      // Recheck immediately before writing. ClickUp offers no atomic conditional
      // PUT; a concurrent change between this check and PUT remains possible.
      const latest = await readOwn();
      if (
        (await commentPatchFingerprint(canonicalPatchComment(latest["comment"]))) !==
          (await commentPatchFingerprint(before)) ||
        JSON.stringify(latest["assignee"]) !== JSON.stringify(original["assignee"]) ||
        latest["resolved"] !== original["resolved"] ||
        latest["group_assignee"] != null
      )
        throw new ReadFailure("CLICKUP_SCOPE_OR_SCHEMA_REJECTED");
      await call(
        "PUT",
        v2("comment/" + commentId),
        { comment: next, assignee, resolved },
        "empty-write-ack",
      );
      try {
        const stored = await readOwn();
        const storedAssignee =
          stored["assignee"] === null
            ? 0
            : Number(obj(stored["assignee"])?.["id"] ?? stored["assignee"]);
        const replyCount = original["reply_count"];
        if (
          (await commentPatchFingerprint(canonicalPatchComment(stored["comment"]))) !==
            (await commentPatchFingerprint(next)) ||
          storedAssignee !== assignee ||
          (stored["resolved"] !== resolved && !(stored["resolved"] === undefined && !resolved)) ||
          stored["group_assignee"] != null ||
          (replyCount !== undefined &&
            (!Number.isFinite(Number(stored["reply_count"])) ||
              Number(stored["reply_count"]) < Number(replyCount)))
        )
          throw new Error("Rich comment patch readback mismatch");
      } catch {
        throw new ReadFailure("CLICKUP_WRITE_OUTCOME_UNKNOWN");
      }
      return {
        success: true,
        task_id: taskId,
        comment_id: commentId,
        verified_by_readback: true,
        fingerprint,
        previous_segments: before,
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
    case "clickup_get_chat_channel_details": {
      const channel = await verifiedChatChannel(g, f, a["channel_id"]);
      return {
        source: "clickup-api-v3",
        channel_id: String(channel["id"]),
        channel: clip(channel),
        recipient_identity_verified: false,
      };
    }
    case "clickup_get_chat_channel_members": {
      await verifiedChatChannel(g, f, a["channel_id"]);
      const params = new URLSearchParams({ limit: String(N) });
      if (a["chat_cursor"] !== undefined) params.set("cursor", boundedV3Cursor(a["chat_cursor"]));
      const result = await call(
        "GET",
        v3("workspaces/" + W + "/chat/channels/" + val(a, "channel_id") + "/members?" + params),
      );
      const entries = chatCollection(result, "members", N);
      const cursor = nextV3Cursor(result);
      return {
        source: "clickup-api-v3",
        channel_id: a["channel_id"],
        members: clip(entries),
        next_cursor: cursor,
        incomplete: cursor !== null || entries.length === N,
      };
    }
    case "clickup_verify_chat_recipients": {
      const requested = validateRequestedRecipients(a["user_ids"], a["self_dm"]);
      const channel = await verifiedChatChannel(g, f, a["channel_id"]);
      await verifiedRecipientIds(g, f, requested);
      const actual = await verifiedChannelMembers(g, f, a["channel_id"]);
      validateDirectMessageRecipients(channel, actual, g.clickupUserId, requested);
      return {
        source: "clickup-api-v3",
        channel_id: a["channel_id"],
        channel_type: chatChannelType(channel),
        verified_recipient_ids: requested,
        participant_ids: actual.memberIds,
        exact_recipients_verified: true,
        message_sent: false,
      };
    }
    case "clickup_open_direct_message": {
      const requested = validateRequestedRecipients(a["user_ids"], a["self_dm"]);
      await verifiedRecipientIds(g, f, requested);
      // Opening a DM is separate from sending a message: no message body here.
      const response = await call("POST", v3("workspaces/" + W + "/chat/channels/direct_message"), {
        user_ids: requested,
      });
      const opened = chatEntity(response, "channel");
      const channel = await verifiedChatChannel(g, f, opened["id"]);
      const actual = await verifiedChannelMembers(g, f, opened["id"]);
      validateDirectMessageRecipients(channel, actual, g.clickupUserId, requested);
      return {
        source: "clickup-api-v3",
        channel_id: String(channel["id"]),
        channel_type: chatChannelType(channel),
        verified_recipient_ids: requested,
        participant_ids: actual.memberIds,
        exact_recipients_verified: true,
        message_sent: false,
      };
    }
    case "clickup_create_chat_reply": {
      const content = requiredChatText(a["content"]);
      await verifiedChatMessage(g, f, a);
      const response = await call(
        "POST",
        v3("workspaces/" + W + "/chat/messages/" + val(a, "message_id") + "/replies"),
        { type: "message", content, content_format: validatedContentFormat(a) },
      );
      let created: Json;
      try {
        created = chatEntity(response, "message");
      } catch {
        throw new ReadFailure("CLICKUP_WRITE_OUTCOME_UNKNOWN");
      }
      const check = new URLSearchParams({ limit: "50", content_format: "text/plain" });
      try {
        const readback = await call(
          "GET",
          v3("workspaces/" + W + "/chat/messages/" + val(a, "message_id") + "/replies?" + check),
        );
        const sent = chatCollection(readback, "messages", 50).find(
          (item) => String(item["id"]) === String(created["id"]),
        );
        if (!sent || sent["content"] !== content || chatMessageAuthorId(sent) !== g.clickupUserId)
          throw new ReadFailure("CLICKUP_WRITE_OUTCOME_UNKNOWN");
      } catch {
        throw new ReadFailure("CLICKUP_WRITE_OUTCOME_UNKNOWN");
      }
      return { source: "clickup-api-v3", id: created["id"], verified_by_readback: true };
    }
    case "clickup_edit_own_chat_message": {
      const wanted = requiredChatText(a["content"]);
      const expected = requiredChatText(a["expected_content"]);
      const before = await verifiedChatMessage(g, f, a);
      requireOwnChatMessage(before, g.clickupUserId, expected);
      try {
        await call("PATCH", v3("workspaces/" + W + "/chat/messages/" + val(a, "message_id")), {
          content: wanted,
          content_format: validatedContentFormat(a),
        });
      } catch (error) {
        if (!(error instanceof ReadFailure) || error.code !== "CLICKUP_WRITE_OUTCOME_UNKNOWN")
          throw error;
      }
      let after: Json;
      try {
        after = await verifiedChatMessage(g, f, a);
      } catch {
        throw new ReadFailure("CLICKUP_WRITE_OUTCOME_UNKNOWN");
      }
      try {
        if (after["content"] !== wanted || chatMessageAuthorId(after) !== g.clickupUserId)
          throw new ReadFailure("CLICKUP_WRITE_OUTCOME_UNKNOWN");
      } catch {
        throw new ReadFailure("CLICKUP_WRITE_OUTCOME_UNKNOWN");
      }
      return { source: "clickup-api-v3", id: a["message_id"], verified_by_readback: true };
    }
    case "clickup_delete_own_chat_message": {
      if (a["confirm_delete"] !== true) throw new ReadFailure("CLICKUP_INVALID_ARGUMENT");
      const expected = requiredChatText(a["expected_content"]);
      const before = await verifiedChatMessage(g, f, a);
      requireOwnChatMessage(before, g.clickupUserId, expected);
      await call("DELETE", v3("workspaces/" + W + "/chat/messages/" + val(a, "message_id")));
      // Only a complete post-delete page supports an absence conclusion.
      // For reply deletions, the parent must be independently verified again.
      const channelId = val(a, "channel_id");
      let path = "workspaces/" + W + "/chat/channels/" + channelId + "/messages";
      const params = new URLSearchParams({ limit: "50", content_format: "text/plain" });
      if (a["parent_message_id"] !== undefined) {
        path = "workspaces/" + W + "/chat/messages/" + val(a, "parent_message_id") + "/replies";
        if (a["reply_cursor"] !== undefined)
          params.set("cursor", boundedV3Cursor(a["reply_cursor"]));
      } else if (a["chat_cursor"] !== undefined) {
        params.set("cursor", boundedV3Cursor(a["chat_cursor"]));
      }
      let page: Json;
      try {
        page = await call("GET", v3(path + "?" + params));
      } catch {
        throw new ReadFailure("CLICKUP_WRITE_OUTCOME_UNKNOWN");
      }
      const messages = chatCollection(page, "messages", 50);
      if (
        nextV3Cursor(page) !== null ||
        messages.length >= 50 ||
        messages.some((item) => String(item["id"]) === String(a["message_id"]))
      )
        throw new ReadFailure("CLICKUP_WRITE_OUTCOME_UNKNOWN");
      return {
        source: "clickup-api-v3",
        id: a["message_id"],
        deleted: true,
        verified_by_readback: true,
      };
    }
    case "clickup_get_chat_message_reactions": {
      await verifiedChatMessage(g, f, a);
      const result = await scopedChatReactions(g, f, a["message_id"], a["reaction_cursor"]);
      return {
        source: "clickup-api-v3",
        message_id: a["message_id"],
        reactions: clip(result.reactions),
        next_cursor: result.nextCursor,
        incomplete: result.nextCursor !== null || result.reactions.length === 50,
      };
    }
    case "clickup_add_chat_reaction": {
      await verifiedChatMessage(g, f, a);
      const name = chatReactionName(a["reaction_name"]);
      const existing = await scopedChatReactions(g, f, a["message_id"]);
      if (
        existing.nextCursor !== null ||
        existing.reactions.length >= 50 ||
        existing.reactions.some((r) => chatReactionOwned(r, g.clickupUserId, name))
      )
        throw new ReadFailure("CLICKUP_CHAT_REACTION_NOT_VERIFIED");
      try {
        await call(
          "POST",
          v3("workspaces/" + W + "/chat/messages/" + val(a, "message_id") + "/reactions"),
          { reaction: name },
          "empty-write-ack",
        );
      } catch (error) {
        if (!(error instanceof ReadFailure) || error.code !== "CLICKUP_WRITE_OUTCOME_UNKNOWN")
          throw error;
      }
      let after: { reactions: Json[]; nextCursor: string | null };
      try {
        after = await scopedChatReactions(g, f, a["message_id"]);
      } catch {
        throw new ReadFailure("CLICKUP_WRITE_OUTCOME_UNKNOWN");
      }
      if (!after.reactions.some((r) => chatReactionOwned(r, g.clickupUserId, name)))
        throw new ReadFailure("CLICKUP_WRITE_OUTCOME_UNKNOWN");
      return {
        source: "clickup-api-v3",
        message_id: a["message_id"],
        reaction: name,
        verified_by_readback: true,
      };
    }
    case "clickup_remove_own_chat_reaction": {
      await verifiedChatMessage(g, f, a);
      const name = chatReactionName(a["reaction_name"]);
      const existing = await scopedChatReactions(g, f, a["message_id"]);
      if (!existing.reactions.some((r) => chatReactionOwned(r, g.clickupUserId, name)))
        throw new ReadFailure("CLICKUP_CHAT_REACTION_NOT_VERIFIED");
      await call(
        "DELETE",
        v3("workspaces/" + W + "/chat/messages/" + val(a, "message_id") + "/reactions/" + name),
      );
      let after: { reactions: Json[]; nextCursor: string | null };
      try {
        after = await scopedChatReactions(g, f, a["message_id"]);
      } catch {
        throw new ReadFailure("CLICKUP_WRITE_OUTCOME_UNKNOWN");
      }
      if (
        after.nextCursor !== null ||
        after.reactions.length >= 50 ||
        after.reactions.some((r) => chatReactionOwned(r, g.clickupUserId, name))
      )
        throw new ReadFailure("CLICKUP_WRITE_OUTCOME_UNKNOWN");
      return {
        source: "clickup-api-v3",
        message_id: a["message_id"],
        reaction: name,
        removed: true,
        verified_by_readback: true,
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
      if (a["chat_cursor"] !== undefined) params.set("cursor", boundedV3Cursor(a["chat_cursor"]));
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
        const parentMessages = chatCollection(page, "messages", 50);
        const claimed = parentMessages
          .map(obj)
          .find((msg) => String(msg?.["id"]) === String(a["message_id"]));
        if (
          !claimed ||
          (claimed["channel_id"] !== undefined &&
            String(claimed["channel_id"]) !== String(a["channel_id"]))
        )
          throw new ReadFailure("CLICKUP_SCOPE_OR_SCHEMA_REJECTED");
        // Only after the parent is proven to belong to this authorized
        // channel may an API path addressing a message ID be called.
        const result = await call(
          "GET",
          v3(prefix + "messages/" + val(a, "message_id") + "/replies?" + params.toString()),
        );
        const replies = chatCollection(result, "messages", N);
        const cursor = nextV3Cursor(result);
        return {
          source: "clickup-api-v3",
          channel_id: a["channel_id"],
          parent_message_id: a["message_id"],
          messages: clip(replies),
          next_cursor: cursor,
          incomplete: cursor !== null || replies.length === N || hasClippedNestedArray(replies),
          continuation_unavailable: cursor === null && replies.length === N,
        };
      }
      const result = await call(
        "GET",
        v3(prefix + "channels/" + channelId + "/messages?" + params.toString()),
      );
      const messages = chatCollection(result, "messages", N);
      if (
        messages.some(
          (entry) =>
            entry["channel_id"] !== undefined &&
            String(entry["channel_id"]) !== String(a["channel_id"]),
        )
      )
        throw new ReadFailure("CLICKUP_SCOPE_OR_SCHEMA_REJECTED");
      const cursor = nextV3Cursor(result);
      return {
        source: "clickup-api-v3",
        channel_id: a["channel_id"],
        messages: clip(messages),
        next_cursor: cursor,
        incomplete: cursor !== null || messages.length === N || hasClippedNestedArray(messages),
        continuation_unavailable: cursor === null && messages.length === N,
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
      const params = new URLSearchParams({
        limit: String(limit),
        archived: "false",
        deleted: "false",
      });
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
      if (a["docs_cursor"] !== undefined) params.set("cursor", boundedV3Cursor(a["docs_cursor"]));
      const result = await call("GET", v3("workspaces/" + W + "/docs?" + params.toString()));
      if (
        !Array.isArray(result["docs"]) ||
        result["docs"].length > Number(limit) ||
        result["docs"].some((entry) => !obj(entry))
      )
        throw new ReadFailure("CLICKUP_BAD_RESPONSE");
      const cursor = nextV3Cursor(result);
      return {
        source: "clickup-api-v3",
        docs: clip(result["docs"]),
        next_cursor: cursor,
        incomplete:
          cursor !== null ||
          result["docs"].length === Number(limit) ||
          hasClippedNestedArray(result["docs"]),
        continuation_unavailable: cursor === null && result["docs"].length === Number(limit),
      };
    }
    case "clickup_get_chat_channels": {
      const result = await call(
        "GET",
        v3("workspaces/" + W + "/chat/channels?limit=" + Math.min(N, 50)),
      );
      const channels = chatCollection(result, "channels", N);
      const cursor = nextV3Cursor(result);
      return {
        source: "clickup-api-v3",
        channels: clip(channels),
        next_cursor: cursor,
        incomplete: cursor !== null || channels.length === N,
      };
    }
    case "clickup_send_chat_message": {
      if (a["text"] !== undefined && a["content"] !== undefined)
        throw new ReadFailure("CLICKUP_INVALID_ARGUMENT");
      // Reject malformed content before spending a read or risking a write.
      const channelId = val(a, "channel_id");
      const content = txt(a["content"] ?? a["text"], 40_000);
      const contentFormat = validatedContentFormat(a);
      // A supplied channel ID is never sufficient authority to post.
      // Reuse the same OAuth-bound Workspace/channel verification as Chat reads.
      const channel = await verifiedChatChannel(g, f, a["channel_id"]);
      const kind = chatChannelType(channel);
      if (kind === null) throw new ReadFailure("CLICKUP_SCOPE_OR_SCHEMA_REJECTED");
      if (kind === "CHANNEL" && (a["user_ids"] !== undefined || a["self_dm"] !== undefined))
        throw new ReadFailure("CLICKUP_INVALID_ARGUMENT");
      if (kind === "DM" || kind === "GROUP_DM") {
        const requested = validateRequestedRecipients(a["user_ids"], a["self_dm"]);
        await verifiedRecipientIds(g, f, requested);
        const actual = await verifiedChannelMembers(g, f, a["channel_id"]);
        validateDirectMessageRecipients(channel, actual, g.clickupUserId, requested);
      }
      return call("POST", v3("workspaces/" + W + "/chat/channels/" + channelId + "/messages"), {
        type: "message",
        content,
        content_format: contentFormat,
      });
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
