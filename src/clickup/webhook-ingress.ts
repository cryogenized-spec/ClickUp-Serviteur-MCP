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
    payload = object(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)));
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
  const ids = new Set<string>();
  if (Array.isArray(history)) {
    if (history.length > 500) return response(400);
    for (const row of history) {
      const historyId = object(row)?.["id"];
      if (
        (typeof historyId !== "string" && typeof historyId !== "number") ||
        !/^[a-zA-Z0-9_-]{1,100}$/.test(String(historyId))
      )
        return response(400);
      ids.add(String(historyId));
    }
  } else if (history !== undefined) return response(400);
  // Some event types omit history_items. Deduplicate exact retransmissions by digest.
  if (!ids.size) {
    const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(body));
    const digestHex = Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    ids.add(digestHex);
  }
  const hints = [...ids].map((id) => ({
    key: webhookId + ":" + id,
    taskId,
    event,
    receivedAt: now,
  }));
  try {
    await deps.persist(registration, hints);
    return response(204);
  } catch {
    // Do not acknowledge before durable persistence. ClickUp may retry.
    return response(503);
  }
}
