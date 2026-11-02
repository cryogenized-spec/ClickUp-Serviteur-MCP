import { ReadFailure, type ReadGrant } from "./policy.js";

export interface ScopedTask {
  readonly id: string;
  readonly name: string;
  readonly status: string;
  readonly list_id: string;
  readonly due_date_ms: number | null;
  readonly date_updated_ms: number | null;
  readonly assignee_ids: readonly string[];
  readonly url: string | null;
}

/** Detailed single-task reads, never included in bulk task search output. */
export interface ScopedTaskDetail extends ScopedTask {
  readonly description: string | null;
  readonly description_format: "markdown" | "plain" | "none";
  readonly description_truncated: boolean;
  readonly priority: number | null;
}

export interface PageResult {
  readonly tasks: readonly ScopedTask[];
  readonly pages_scanned: number;
  readonly incomplete: boolean;
  readonly source: "clickup-api-v2";
  readonly list_id: string;
}

type Fetcher = typeof fetch;
type JsonObject = Record<string, unknown>;
const API_ROOT = "https://api.clickup.com/api/v2/";
const MAX_BODY = 1_000_000;

function object(raw: unknown): JsonObject | null {
  return raw !== null && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as JsonObject)
    : null;
}

function epoch(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === "") return null;
  if (typeof raw !== "string" && typeof raw !== "number")
    throw new ReadFailure("CLICKUP_BAD_RESPONSE");
  if (!/^\d{1,15}$/.test(String(raw))) throw new ReadFailure("CLICKUP_BAD_RESPONSE");
  const number = Number(raw);
  if (!Number.isSafeInteger(number)) throw new ReadFailure("CLICKUP_BAD_RESPONSE");
  return number;
}

function normalizeTask(raw: unknown, requiredListId: string): ScopedTask {
  const task = object(raw);
  const list = object(task?.["list"]);
  const status = object(task?.["status"]);
  if (
    !task ||
    typeof task["id"] !== "string" ||
    !/^[a-zA-Z0-9_-]{1,80}$/.test(task["id"]) ||
    typeof task["name"] !== "string" ||
    !list ||
    String(list["id"]) !== requiredListId ||
    !status ||
    typeof status["status"] !== "string"
  ) {
    throw new ReadFailure("CLICKUP_SCOPE_OR_SCHEMA_REJECTED");
  }
  const ids = task["assignees"];
  if (ids !== undefined && !Array.isArray(ids)) throw new ReadFailure("CLICKUP_BAD_RESPONSE");
  const assigneeIds = (ids ?? []).map((member: unknown) => {
    const id = object(member)?.["id"];
    if ((typeof id !== "number" && typeof id !== "string") || !/^\d+$/.test(String(id))) {
      throw new ReadFailure("CLICKUP_BAD_RESPONSE");
    }
    return String(id);
  });
  const rawUrl = task["url"];
  let safeUrl: string | null = null;
  if (typeof rawUrl === "string") {
    try {
      const parsed = new URL(rawUrl);
      if (
        parsed.protocol === "https:" &&
        parsed.hostname === "app.clickup.com" &&
        parsed.username === "" &&
        parsed.password === "" &&
        parsed.pathname.startsWith("/t/")
      ) {
        safeUrl = parsed.href;
      }
    } catch {
      // Untrusted upstream URLs are never returned.
    }
  }
  return {
    id: task["id"],
    name: task["name"].slice(0, 180),
    status: status["status"].slice(0, 60),
    list_id: requiredListId,
    due_date_ms: epoch(task["due_date"]),
    date_updated_ms: epoch(task["date_updated"]),
    assignee_ids: assigneeIds.slice(0, 12),
    url: safeUrl,
  };
}

export async function quotaCall(
  grant: ReadGrant,
  kind: "reserve" | "cooldown",
  until?: number,
): Promise<void> {
  try {
    const binding = grant.quota;
    const id = binding.idFromName("clickup-account:" + grant.clickupUserId);
    const stub = binding.get(id as never);
    const response = await stub.fetch(
      new Request("https://internal.invalid/" + kind, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subject: grant.subject, ...(until === undefined ? {} : { until }) }),
      }),
    );
    if (!response.ok) throw new Error("quota request failure");
    const body: unknown = await response.json();
    if (object(body)?.["allowed"] !== true) throw new ReadFailure("CLICKUP_RATE_LIMITED");
  } catch (error) {
    if (error instanceof ReadFailure) throw error;
    throw new ReadFailure("CLICKUP_QUOTA_UNAVAILABLE");
  }
}

/** One path template, no caller-provided URL, no redirects, no non-GET methods. */
async function getJson(grant: ReadGrant, path: string, fetcher: Fetcher): Promise<unknown> {
  await quotaCall(grant, "reserve");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetcher(new URL(path, API_ROOT), {
      method: "GET",
      headers: { Authorization: grant.apiToken, Accept: "application/json" },
      redirect: "manual",
      signal: controller.signal,
    });
    if (response.status === 429) {
      const reset = response.headers.get("X-RateLimit-Reset");
      const seconds = reset && /^\d{1,12}$/.test(reset) ? Number(reset) : 0;
      if (Number.isSafeInteger(seconds) && seconds > Date.now() / 1000) {
        await quotaCall(grant, "cooldown", seconds * 1_000);
      }
      throw new ReadFailure("CLICKUP_RATE_LIMITED");
    }
    if (response.status === 401 || response.status === 403)
      throw new ReadFailure("CLICKUP_UPSTREAM_DENIED");
    if (!response.ok) throw new ReadFailure("CLICKUP_UPSTREAM_UNAVAILABLE");
    const declaredSize = response.headers.get("content-length");
    if (declaredSize !== null && Number(declaredSize) > MAX_BODY)
      throw new ReadFailure("CLICKUP_BAD_RESPONSE");
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().includes("application/json"))
      throw new ReadFailure("CLICKUP_BAD_RESPONSE");
    const body = await response.text();
    if (body.length > MAX_BODY) throw new ReadFailure("CLICKUP_BAD_RESPONSE");
    try {
      return JSON.parse(body) as unknown;
    } catch {
      throw new ReadFailure("CLICKUP_BAD_RESPONSE");
    }
  } catch (error) {
    if (error instanceof ReadFailure) throw error;
    throw new ReadFailure("CLICKUP_UPSTREAM_UNAVAILABLE");
  } finally {
    clearTimeout(timeout);
  }
}

export async function findScopedTasks(
  grant: ReadGrant,
  fetcher: Fetcher,
  maxResults = 20,
  requestedStatus?: string,
): Promise<PageResult> {
  if (
    !Number.isInteger(maxResults) ||
    maxResults < 1 ||
    maxResults > 50 ||
    (requestedStatus !== undefined && (requestedStatus.length > 64 || !requestedStatus.trim()))
  ) {
    throw new ReadFailure("CLICKUP_INVALID_ARGUMENT");
  }
  const found: ScopedTask[] = [];
  const ids = new Set<string>();
  let pages = 0;
  let incomplete = false;
  for (let page = 0; page < 3; page++) {
    const raw = object(
      await getJson(
        grant,
        "list/" +
          grant.listId +
          "/task?page=" +
          page +
          "&include_closed=false&subtasks=false&include_timl=false",
        fetcher,
      ),
    );
    if (!raw || !Array.isArray(raw["tasks"]) || raw["tasks"].length > 100) {
      throw new ReadFailure("CLICKUP_BAD_RESPONSE");
    }
    pages++;
    for (const item of raw["tasks"]) {
      const task = normalizeTask(item, grant.listId);
      if (ids.has(task.id)) continue;
      ids.add(task.id);
      if (requestedStatus && task.status.toLowerCase() !== requestedStatus.toLowerCase()) continue;
      if (found.length >= maxResults) {
        incomplete = true;
        break;
      }
      found.push(task);
    }
    if (incomplete) break;
    if (raw["tasks"].length < 100 || raw["last_page"] === true) break;
    if (page === 2) incomplete = true;
  }
  return {
    tasks: found,
    pages_scanned: pages,
    incomplete,
    source: "clickup-api-v2",
    list_id: grant.listId,
  };
}

export async function getScopedTask(
  grant: ReadGrant,
  taskId: string,
  fetcher: Fetcher,
): Promise<ScopedTaskDetail> {
  if (!/^[a-zA-Z0-9_-]{2,40}$/.test(taskId)) throw new ReadFailure("CLICKUP_INVALID_ARGUMENT");
  const taskPath = "task/" + encodeURIComponent(taskId);
  const raw = await getJson(
    grant,
    taskPath + "?custom_task_ids=false&include_markdown_description=true",
    fetcher,
  );
  const task = normalizeTask(raw, grant.listId);
  if (task.id !== taskId) throw new ReadFailure("CLICKUP_SCOPE_OR_SCHEMA_REJECTED");

  // Only project verbose content after checking the returned task's home List.
  // Do not add descriptions to bulk search or attention report payloads.
  const detail = object(raw)!;
  const markdown = detail["markdown_description"];
  const plain = detail["description"];
  if (
    (markdown != null && typeof markdown !== "string") ||
    (plain != null && typeof plain !== "string")
  ) {
    throw new ReadFailure("CLICKUP_BAD_RESPONSE");
  }
  let description: string | null = null;
  let descriptionFormat: "markdown" | "plain" | "none" = "none";
  if (typeof markdown === "string" && markdown.length > 0) {
    description = markdown;
    descriptionFormat = "markdown";
  } else if (typeof plain === "string") {
    description = plain;
    descriptionFormat = "plain";
  } else if (typeof markdown === "string") {
    description = markdown;
    descriptionFormat = "markdown";
  }
  const priorityRaw = detail["priority"];
  let priority: number | null = null;
  if (priorityRaw != null) {
    const value = object(priorityRaw)?.["id"];
    if ((typeof value !== "string" && typeof value !== "number") || !/^[1-4]$/.test(String(value)))
      throw new ReadFailure("CLICKUP_BAD_RESPONSE");
    priority = Number(value);
  }
  const MAX_DESCRIPTION = 8000;
  return {
    ...task,
    description: description === null ? null : description.slice(0, MAX_DESCRIPTION),
    description_format: descriptionFormat,
    description_truncated: description !== null && description.length > MAX_DESCRIPTION,
    priority,
  };
}
