/**
 * Fail-closed verification primitives for a future, independently reviewed
 * ClickUp webhook receiver. This module is NOT mounted as an HTTP endpoint.
 *
 * The registration owner must store the unique per-webhook secret server-side.
 * Never return it to an MCP client, store it in repository files or log it.
 */

export const MAX_CLICKUP_WEBHOOK_BYTES = 131_072;

export interface VerifiedClickUpWebhookEnvelope {
  readonly webhook_id: string;
  readonly event: string;
  readonly task_id?: string;
  readonly list_id?: string;
  readonly history_item_ids: readonly string[];
  /** Stable idempotency keys. The consumer must claim them atomically. */
  readonly deduplication_keys: readonly string[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function boundedIdentity(value: unknown, max: number): string | null {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= max &&
    /^[a-zA-Z0-9_-]+$/.test(value)
    ? value
    : null;
}

/**
 * Verify the exact received byte sequence. Re-serializing JSON would change
 * the signed message; this routine never parses before authenticating.
 */
export async function verifyClickUpWebhookSignature(
  rawBody: Uint8Array,
  signatureHeader: string | null | undefined,
  secret: string,
): Promise<boolean> {
  if (
    !(rawBody instanceof Uint8Array) ||
    rawBody.byteLength === 0 ||
    rawBody.byteLength > MAX_CLICKUP_WEBHOOK_BYTES ||
    typeof signatureHeader !== "string" ||
    !/^[a-fA-F0-9]{64}$/.test(signatureHeader) ||
    typeof secret !== "string" ||
    secret.length === 0 ||
    secret.length > 1024
  )
    return false;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const expected = new Uint8Array(await crypto.subtle.sign("HMAC", key, rawBody));
  // Both buffers are exactly 32 bytes. Do not short-circuit on mismatch.
  let mismatch = 0;
  for (let i = 0; i < expected.length; i++) {
    const received = Number.parseInt(signatureHeader.slice(2 * i, 2 * i + 2), 16);
    mismatch |= expected[i]! ^ received;
  }
  return mismatch === 0;
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Combine authentication, origin correlation and metadata minimization.
 * Neither this routine nor its caller may treat event payload text as an
 * instruction or a source of ClickUp authorization.
 */
export async function validateClickUpWebhookMessage(
  rawBody: Uint8Array,
  signatureHeader: string | null | undefined,
  secret: string,
  expectedWebhookId: string,
): Promise<VerifiedClickUpWebhookEnvelope | null> {
  if (!boundedIdentity(expectedWebhookId, 100)) return null;
  if (!(await verifyClickUpWebhookSignature(rawBody, signatureHeader, secret))) return null;

  let json: unknown;
  try {
    // Reject every UTF-8 replacement character. This also rejects valid
    // literal U+FFFD content deliberately, rather than accepting malformed bytes.
    const decoded = new TextDecoder().decode(rawBody);
    if (decoded.includes("\uFFFD")) return null;
    json = JSON.parse(decoded);
  } catch {
    return null;
  }
  const record = asRecord(json);
  if (!record) return null;
  const webhookId = boundedIdentity(record["webhook_id"], 100);
  if (webhookId !== expectedWebhookId) return null;
  const event = boundedIdentity(record["event"], 80);
  if (!event || !/^[a-zA-Z][a-zA-Z0-9]*$/.test(event)) return null;
  const task = record["task_id"] === undefined ? undefined : boundedIdentity(record["task_id"], 80);
  const list = record["list_id"] === undefined ? undefined : boundedIdentity(record["list_id"], 80);
  if ((record["task_id"] !== undefined && !task) || (record["list_id"] !== undefined && !list))
    return null;

  const history = record["history_items"];
  if (history !== undefined && (!Array.isArray(history) || history.length > 50)) return null;
  const historyIds: string[] = [];
  if (Array.isArray(history)) {
    for (const entry of history) {
      const id = boundedIdentity(asRecord(entry)?.["id"], 100);
      if (!id || historyIds.includes(id)) return null;
      historyIds.push(id);
    }
  }

  // ClickUp recommends webhook_id:history_item_id. Not every event carries
  // history_items; fall back to the SHA-256 digest of the *signed raw bytes*.
  // No raw user content or credential is incorporated into returned keys.
  const digest = hex(new Uint8Array(await crypto.subtle.digest("SHA-256", rawBody)));
  const deduplicationKeys = historyIds.length
    ? historyIds.map((id) => webhookId + ":" + id)
    : [webhookId + ":body-sha256:" + digest];
  return {
    webhook_id: webhookId,
    event,
    ...(task ? { task_id: task } : {}),
    ...(list ? { list_id: list } : {}),
    history_item_ids: historyIds,
    deduplication_keys: deduplicationKeys,
  };
}
