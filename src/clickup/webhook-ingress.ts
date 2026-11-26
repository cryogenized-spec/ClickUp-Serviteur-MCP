import { verifyClickUpWebhookSignature } from "./webhook-signature.js";

type Json = Record<string, unknown>;
const object = (value: unknown): Json | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Json) : null;

export interface WebhookRegistration {
  readonly workspaceId: string;
  readonly subject: string;
  readonly secret: string;
}

export interface WebhookHint {
  readonly key: string;
  readonly taskId: string;
  readonly event: string;
  readonly receivedAt: number;
  readonly metadata?: WebhookMetadata;
}


// Optional, bounded routing hints. Never copy arbitrary before/after values or text.
type WebhookMetadata = Record<string, string | number | string[]>;

const fields = new Set([
  "comment",
  "assignee_add",
  "assignee_rem",
  "assignee_remove",
  "status",
  "priority",
  "due_date",
  "tag",
  "content",
  "name",
  "list",
  "time_estimate",
  "time_spent",
  "custom_field",
]);

function numericId(value: unknown): string | undefined {
  if (typeof value === "number" && !Number.isSafeInteger(value)) return undefined;
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const id = String(value);
  return /^[1-9]\d{0,23}$/.test(id) ? id : undefined;
}

/** Reconstruct only known metadata keys at each storage and retrieval boundary. */
export function sanitizeWebhookMetadata(value: unknown): WebhookMetadata {
  const row = object(value);
  const result: WebhookMetadata = {};
  for (const key of ["actor_user_id", "comment_id", "list_id", "assignee_user_id"]) {
    const id = numericId(row?.[key]);
    if (id) result[key] = id;
  }
  const field = row?.["field"];
  if (typeof field === "string" && fields.has(field)) result["field"] = field;
  const timestamp = row?.["occurred_at"];
  if (
    typeof timestamp === "number" &&
    Number.isSafeInteger(timestamp) &&
    timestamp > 0
  )
    result["occurred_at"] = timestamp;
  const mentions = row?.["mentioned_user_ids"];
  if (Array.isArray(mentions)) {
    const ids = mentions.slice(0, 100).map(numericId).filter((id) => id !== undefined);
    if (ids.length) result["mentioned_user_ids"] = [...new Set(ids)];
  }
  return result;
}

function historyMetadata(row: Json): WebhookMetadata {
  const comment = object(row["comment"]);
  const segments = comment?.["comment"];
  const mentions = Array.isArray(segments)
    ? segments.slice(0, 500).flatMap((segment: unknown) => {
        const tag = object(segment);
        return tag?.["type"] === "tag" ? [object(tag["user"])?.["id"]] : [];
      })
    : [];
  const field = row["field"];
  const assignment =
    field === "assignee_add"
      ? object(row["after"])
      : field === "assignee_rem" || field === "assignee_remove"
        ? object(row["before"])
        : null;
  const date = row["date"];
  const timestamp =
    typeof date === "number" || (typeof date === "string" && /^\d{1,16}$/.test(date))
      ? Number(date)
      : undefined;
  return sanitizeWebhookMetadata({
    actor_user_id: object(row["user"])?.["id"],
    comment_id: field === "comment" ? (comment?.["id"] ?? row["after"]) : undefined,
    list_id: row["parent_id"],
    assignee_user_id: assignment?.["id"],
    field,
    occurred_at: timestamp,
    mentioned_user_ids: mentions,
  });
}

export interface WebhookIngressDependencies {
  readonly resolve: (webhookId: string) => Promise<WebhookRegistration | null>;
  readonly persist: (
    registration: WebhookRegistration,
    hints: readonly WebhookHint[],
  ) => Promise<void>;
}

const MAX_BYTES = 1_000_000;
const taskIdPattern = /^[a-zA-Z0-9_-]{1,80}$/;
const webhookIdPattern = /^[a-f0-9-]{36}$/i;
const taskEvents = new Set([
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
]);

const response = (status: number) =>
  new Response(null, { status, headers: { "Cache-Control": "no-store" } });

async function boundedBody(request: Request): Promise<Uint8Array> {
  const declared = request.headers.get("content-length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > MAX_BYTES)) {
    throw new Error("SIZE");
  }
  if (!request.body) throw new Error("BODY");
  const reader = request.body.getReader();
  const buffer = new Uint8Array(MAX_BYTES);
  let used = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      if (used + next.value.byteLength > MAX_BYTES) {
        void reader.cancel().catch(() => undefined);
        throw new Error("SIZE");
      }
      buffer.set(next.value, used);
      used += next.value.byteLength;
    }
    return buffer.slice(0, used);
  } finally {
    reader.releaseLock();
  }
}

/** Only retain task-change hints, not comments, descriptions or raw webhook bodies.
 * These hints are NOT evidence of current access: consumers must re-read ClickUp.
 */
export async function receiveClickUpWebhook(
  request: Request,
  deps: WebhookIngressDependencies,
  now = Date.now(),
): Promise<Response> {
  if (request.method !== "POST") return response(405);
  const signature = request.headers.get("x-signature") ?? "";
  if (!/^[a-f0-9]{64}$/i.test(signature)) return response(401);
  let body: Uint8Array;
  let payload: Json | null;
  try {
    body = await boundedBody(request);
    const decoded = new TextDecoder().decode(body);
    const roundtrip = new TextEncoder().encode(decoded);
    if (roundtrip.length !== body.length || roundtrip.some((byte, i) => byte !== body[i]))
      return response(400);
    payload = object(JSON.parse(decoded));
  } catch {
    return response(400);
  }
  const webhookId = payload?.["webhook_id"];
  if (typeof webhookId !== "string" || !webhookIdPattern.test(webhookId)) return response(401);
  let registration: WebhookRegistration | null;
  try {
    registration = await deps.resolve(webhookId);
    if (!registration) return response(401);
    const verified = await verifyClickUpWebhookSignature(body, signature, registration.secret);
    if (!verified) return response(401);
  } catch {
    return response(503);
  }
  const taskId = payload?.["task_id"];
  const event = payload?.["event"];
  // Acknowledge authenticated events outside this task-hint consumer's scope.
  if (typeof event !== "string" || !taskEvents.has(event)) return response(204);
  if (typeof taskId !== "string" || !taskIdPattern.test(taskId)) return response(400);
  const history = payload?.["history_items"];
  const ids = new Map<string, WebhookMetadata>();
  if (Array.isArray(history)) {
    if (history.length > 500) return response(400);
    for (const row of history) {
      const item = object(row);
      const historyId = item?.["id"];
      if (
        (typeof historyId !== "string" && typeof historyId !== "number") ||
        !/^[a-zA-Z0-9_-]{1,100}$/.test(String(historyId))
      )
        return response(400);
      if (item) ids.set(String(historyId), historyMetadata(item));
    }
  } else if (history !== undefined) return response(400);
  // Some event types omit history_items. Deduplicate exact retransmissions by digest.
  if (!ids.size) {
    const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(body));
    const digestHex = Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    ids.set(digestHex, {});
  }
  const hints = [...ids].map(([id, metadata]) => ({
    key: webhookId + ":" + id,
    taskId,
    event,
    receivedAt: now,
    ...(Object.keys(metadata).length ? { metadata } : {}),
  }));
  try {
    await deps.persist(registration, hints);
    return response(204);
  } catch {
    // Do not acknowledge before durable persistence. ClickUp may retry.
    return response(503);
  }
}
