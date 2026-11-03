import { quotaCall } from "./client.js";
import { ReadFailure, type ReadGrant } from "./policy.js";

/**
 * Minimal native ClickUp REST adapter. ClickUp remains the ONLY task/activity
 * system of record; no journal, duplicate approvals, or compensating rollbacks.
 * Only authenticated per-user OAuth tokens enter here, from requireWriteGrant.
 */
const ROOT = "https://api.clickup.com/api/v2/";
const MAX_JSON_BYTES = 1_000_000;
const idPattern = /^[A-Za-z0-9_-]{2,40}$/;
const obj = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

async function requestJson(
  grant: ReadGrant,
  fetcher: typeof fetch,
  method: "GET" | "POST" | "PUT",
  path: string,
  body?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  await quotaCall(grant, "reserve");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetcher(new URL(path, ROOT), {
      method,
      headers: {
        Authorization: grant.apiToken,
        Accept: "application/json",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      redirect: "manual",
      signal: controller.signal,
    });
    if (response.status === 401 || response.status === 403)
      throw new ReadFailure("CLICKUP_UPSTREAM_DENIED");
    if (response.status === 429) {
      const reset = response.headers.get("X-RateLimit-Reset");
      const seconds = reset && /^\d{1,12}$/.test(reset) ? Number(reset) : 0;
      if (Number.isSafeInteger(seconds) && seconds > Date.now() / 1000) {
        await quotaCall(grant, "cooldown", seconds * 1000);
      }
      throw new ReadFailure("CLICKUP_RATE_LIMITED");
    }
    if (!response.ok) {
      if (method !== "GET" && response.status >= 500) {
        throw new ReadFailure("CLICKUP_WRITE_OUTCOME_UNKNOWN");
      }
      throw new ReadFailure("CLICKUP_UPSTREAM_UNAVAILABLE");
    }
    const malformed = () =>
      new ReadFailure(method === "GET" ? "CLICKUP_BAD_RESPONSE" : "CLICKUP_WRITE_OUTCOME_UNKNOWN");
    const type = response.headers.get("content-type") ?? "";
    const size = response.headers.get("content-length");
    if (
      !type.toLowerCase().includes("application/json") ||
      (size !== null && Number(size) > MAX_JSON_BYTES)
    )
      throw malformed();
    const text = await response.text();
    if (text.length > MAX_JSON_BYTES) throw malformed();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw malformed();
    }
    const decoded = obj(parsed);
    if (!decoded) throw malformed();
    return decoded;
  } catch (error) {
    if (error instanceof ReadFailure) throw error;
    // A timeout after POST/PUT may mean the operation actually succeeded.
    throw new ReadFailure(
      method === "GET" ? "CLICKUP_UPSTREAM_UNAVAILABLE" : "CLICKUP_WRITE_OUTCOME_UNKNOWN",
    );
  } finally {
    clearTimeout(timeout);
  }
}
const optionalText = (value: unknown, limit: number): string | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length < 1 || value.length > limit)
    throw new ReadFailure("CLICKUP_INVALID_ARGUMENT");
  return value;
};
const optionalPriority = (v: unknown): number | undefined => {
  if (v === undefined) return undefined;
  if (!Number.isInteger(v) || (v as number) < 1 || (v as number) > 4)
    throw new ReadFailure("CLICKUP_INVALID_ARGUMENT");
  return v as number;
};
const optionalDate = (v: unknown): number | undefined => {
  if (v === undefined) return undefined;
  if (!Number.isSafeInteger(v) || (v as number) <= 0 || (v as number) > 9_000_000_000_000)
    throw new ReadFailure("CLICKUP_INVALID_ARGUMENT");
  return v as number;
};
export interface TaskInput {
  name?: string;
  description?: string;
  status?: string;
  priority?: number;
  due_date_ms?: number;
}
function bodyFromInput(raw: unknown, create: boolean): Record<string, unknown> {
  const value = obj(raw);
  if (
    !value ||
    Object.keys(value).some(
      (key) => !["name", "description", "status", "priority", "due_date_ms"].includes(key),
    )
  )
    throw new ReadFailure("CLICKUP_INVALID_ARGUMENT");
  const name = optionalText(value["name"], 180);
  const description = optionalText(value["description"], 8000);
  const status = optionalText(value["status"], 80);
  const priority = optionalPriority(value["priority"]);
  const due = optionalDate(value["due_date_ms"]);
  if ((create && !name) || (!create && Object.keys(value).length === 0))
    throw new ReadFailure("CLICKUP_INVALID_ARGUMENT");
  return {
    ...(name !== undefined ? { name } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(status !== undefined ? { status } : {}),
    ...(priority !== undefined ? { priority } : {}),
    ...(due !== undefined ? { due_date: due, due_date_time: true } : {}),
    ...(create ? { check_required_custom_fields: true, notify_all: false } : {}),
  };
}
function responseId(payload: Record<string, unknown>, expected?: string): string {
  const id = payload["id"];
  if (typeof id !== "string" || !idPattern.test(id) || (expected && id !== expected))
    throw new ReadFailure("CLICKUP_WRITE_OUTCOME_UNKNOWN");
  return id;
}

/**
 * Fail closed unless ClickUp itself associates the configured List with
 * a Space returned by its authorized Workspace-specific endpoint.
 * The account credential is individual, and workspaceId comes from
 * its verified OAuth connection, never from model-supplied arguments.
 *
 * This guards mistaken cross-Workspace LIST_ID configuration. It does not
 * claim to lock a List against concurrent Workspace moves.
 */
/**
 * Shared-with-me List authority. Both scoped and catalogue readers must use
 * exactly this Workspace-bound check; the List GET alone is not permission.
 */
export async function verifySharedListWorkspace(
  grant: ReadGrant,
  fetcher: typeof fetch,
  listId: string,
): Promise<void> {
  // Shared-List fallback is NEVER a way to gain a second List, even if an
  // individual OAuth token can read it.
  if (listId !== grant.listId || !/^[1-9]\d{0,17}$/.test(listId))
    throw new ReadFailure("CLICKUP_SCOPE_OR_SCHEMA_REJECTED");
  const hierarchy = await requestJson(
    grant,
    fetcher,
    "GET",
    "team/" + grant.workspaceId + "/shared",
  );
  const sharedLists = obj(hierarchy["shared"])?.["lists"];
  if (
    !Array.isArray(sharedLists) ||
    sharedLists.length > 500 ||
    !sharedLists.some((value) => {
      const entry = obj(value);
      return entry !== null && String(entry["id"]) === listId;
    })
  )
    throw new ReadFailure("CLICKUP_SCOPE_OR_SCHEMA_REJECTED");
}

export async function verifyListWorkspace(grant: ReadGrant, fetcher: typeof fetch): Promise<void> {
  if (!/^[1-9]\d{0,17}$/.test(grant.workspaceId) || !/^[1-9]\d{0,17}$/.test(grant.listId)) {
    throw new ReadFailure("CLICKUP_SCOPE_OR_SCHEMA_REJECTED");
  }
  const list = await requestJson(grant, fetcher, "GET", "list/" + grant.listId);
  const space = obj(list["space"]);
  const spaceId = space?.["id"];
  if (
    String(list["id"]) !== grant.listId ||
    (typeof spaceId !== "string" && typeof spaceId !== "number") ||
    !/^[1-9]\d{0,17}$/.test(String(spaceId))
  ) {
    throw new ReadFailure("CLICKUP_SCOPE_OR_SCHEMA_REJECTED");
  }
  const workspace = await requestJson(
    grant,
    fetcher,
    "GET",
    "team/" + grant.workspaceId + "/space?archived=false",
  );
  const spaces = workspace["spaces"];
  if (!Array.isArray(spaces) || spaces.length > 500)
    throw new ReadFailure("CLICKUP_SCOPE_OR_SCHEMA_REJECTED");
  if (
    spaces.some((value) => {
      const entry = obj(value);
      return entry !== null && String(entry["id"]) === String(spaceId);
    })
  )
    return;

  await verifySharedListWorkspace(grant, fetcher, grant.listId);
}

export async function createScopedTask(
  grant: ReadGrant,
  data: TaskInput,
  fetcher: typeof fetch,
): Promise<Record<string, unknown>> {
  const body = bodyFromInput(data, true);
  const upstream = await requestJson(
    grant,
    fetcher,
    "POST",
    "list/" + grant.listId + "/task",
    body,
  );
  const id = responseId(upstream);
  if (upstream["list"] !== undefined && String(obj(upstream["list"])?.["id"]) !== grant.listId)
    throw new ReadFailure("CLICKUP_WRITE_OUTCOME_UNKNOWN");
  return {
    action: "task_created",
    task_id: id,
    list_id: grant.listId,
    source: "clickup-api-v2",
    accepted: true,
  };
}
/**
 * Intentionally no task-ID write endpoints.
 * ClickUp v2 PUT /task/{id} and POST /task/{id}/comment do not accept an
 * atomic home-List precondition. The task can be moved after a GET, so
 * advertising these mutations would violate our strict List boundary.
 * Restore only when upstream provides a List-bound conditional mutation.
 */
// ClickUp task-ID comment reads also lack a list-scoped endpoint: an item can
// move between preflight and the subsequent read. Keep this unavailable until
// the same upstream atomicity issue is resolved.
export async function getScopedList(
  grant: ReadGrant,
  fetcher: typeof fetch,
): Promise<Record<string, unknown>> {
  const list = await requestJson(grant, fetcher, "GET", "list/" + grant.listId);
  if (String(list["id"]) !== grant.listId)
    throw new ReadFailure("CLICKUP_SCOPE_OR_SCHEMA_REJECTED");
  if (typeof list["name"] !== "string") throw new ReadFailure("CLICKUP_BAD_RESPONSE");
  const statuses = Array.isArray(list["statuses"])
    ? list["statuses"]
        .slice(0, 60)
        .map((v: unknown) => obj(v)?.["status"])
        .filter((v: unknown) => typeof v === "string")
    : [];
  return {
    source: "clickup-api-v2",
    list_id: grant.listId,
    name: list["name"].slice(0, 180),
    statuses,
  };
}
