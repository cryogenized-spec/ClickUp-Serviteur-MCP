import type { ReadGrant } from "./policy.js";

export type VerifiedCommentObservation = {
  recorded: boolean;
  action_key?: string;
  revision?: number;
  reason?:
    | "private_storage_unavailable"
    | "private_storage_failed"
    | "private_storage_timeout"
    | "invalid_evidence"
    | "conflicting_record"
    | "concurrent_followup_update"
    | "malformed_private_response";
};

// A comment has already succeeded before this best-effort observation begins.
// Bound all three private RPCs under one overall deadline.
const PRIVATE_OBSERVATION_DEADLINE_MS = 4_000;
class PrivateObservationTimeout extends Error {}

const states = new Set([
  "detected",
  "verified",
  "action_required",
  "action_taken",
  "awaiting_response",
  "response_received",
  "resolved",
]);

const obj = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

/**
 * Only call AFTER a live ClickUp readback confirmed the exact comment ID and
 * author under the current OAuth principal. This observation does not assert
 * that any customer saw a message or that a colleague complied with it.
 *
 * Storage is private to the same (Workspace, actor) Durable Object used by
 * the follow-up ledger. Failed writes MUST NOT roll back or retry the actual
 * ClickUp POST, which may already have succeeded.
 */
export async function recordVerifiedCommentObservation(
  grant: ReadGrant,
  taskId: string,
  commentId: string,
): Promise<VerifiedCommentObservation> {
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(taskId) || !/^[a-zA-Z0-9_-]{1,100}$/.test(commentId))
    return { recorded: false, reason: "invalid_evidence" };
  if (!grant.taskIndex) return { recorded: false, reason: "private_storage_unavailable" };

  const actionKey = "verified-comment:" + commentId;
  const deadline = Date.now() + PRIVATE_OBSERVATION_DEADLINE_MS;

  try {
    // Private binding acquisition can throw. Protect it, too: the ClickUp
    // comment is already posted and its result must still be returned.
    const stub = grant.taskIndex.get(
      grant.taskIndex.idFromName(grant.workspaceId + ":" + grant.subject) as never,
    );
    const readPrivate = async (
      request: Request,
    ): Promise<{
      response: Response;
      payload: unknown;
    }> => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new PrivateObservationTimeout();
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          (async () => {
            // Abort where supported; race guarantees a deadline even if
            // Durable Object binding ignores the abort signal.
            const response = await stub.fetch(
              new Request(request, {
                signal: controller.signal,
              }),
            );
            return {
              response,
              payload: response.ok ? await response.json() : null,
            };
          })(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              controller.abort();
              reject(new PrivateObservationTimeout());
            }, remaining);
          }),
        ]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    };
    // An exact committed receipt takes precedence over a fresh current
    // revision. This keeps repeated observations idempotent even if later
    // private follow-up changes have already advanced the state.
    const receiptUrl = new URL("https://internal/followups/receipt");
    receiptUrl.searchParams.set("task_id", taskId);
    receiptUrl.searchParams.set("action_key", actionKey);
    const { response: receiptResponse, payload: receiptPayload } = await readPrivate(
      new Request(receiptUrl),
    );
    if (!receiptResponse.ok) return { recorded: false, reason: "private_storage_failed" };
    const receiptEnvelope = obj(receiptPayload);
    if (!receiptEnvelope) return { recorded: false, reason: "malformed_private_response" };
    const receipt = obj(receiptEnvelope["receipt"]);
    if (receipt) {
      const original =
        typeof receipt["request_json"] === "string"
          ? obj(JSON.parse(receipt["request_json"]))
          : null;
      if (
        receipt["task_id"] !== taskId ||
        receipt["action_key"] !== actionKey ||
        !Number.isSafeInteger(receipt["revision"]) ||
        original?.["task_id"] !== taskId ||
        original["action_key"] !== actionKey ||
        original["action_kind"] !== "verified_comment_posted" ||
        original["evidence_comment_id"] !== commentId
      )
        return { recorded: false, reason: "conflicting_record" };
      return {
        recorded: true,
        action_key: actionKey,
        revision: receipt["revision"] as number,
      };
    }

    const stateUrl = new URL("https://internal/followups/task");
    stateUrl.searchParams.set("task_id", taskId);
    stateUrl.searchParams.set("limit", "1");
    const { response: stateResponse, payload: statePayload } = await readPrivate(
      new Request(stateUrl),
    );
    if (!stateResponse.ok) return { recorded: false, reason: "private_storage_failed" };
    const snapshot = obj(statePayload);
    if (!snapshot || snapshot["task_id"] !== taskId)
      return { recorded: false, reason: "malformed_private_response" };
    const current = obj(snapshot["state"]);
    let expectedRevision = 0;
    let stateAfter = "verified";
    let waitingOn: string | null = null;
    let nextCheck: number | null = null;
    if (current) {
      const state = current["state"];
      const revision = current["revision"];
      const waiting = current["waiting_on_user_id"];
      const due = current["next_check_at_ms"];
      if (
        typeof state !== "string" ||
        !states.has(state) ||
        !Number.isSafeInteger(revision) ||
        Number(revision) < 1 ||
        (waiting !== null &&
          waiting !== undefined &&
          (typeof waiting !== "string" || !/^[1-9]\d{0,23}$/.test(waiting))) ||
        (due !== null && due !== undefined && (!Number.isSafeInteger(due) || Number(due) < 0))
      )
        return { recorded: false, reason: "malformed_private_response" };
      expectedRevision = revision as number;
      stateAfter = state;
      waitingOn = typeof waiting === "string" ? waiting : null;
      nextCheck = typeof due === "number" ? due : null;
    }

    // Preserve all existing curated obligations, responsibilities, due dates,
    // and resolved state. A verified sent comment is NOT itself a confirmed
    // customer response, newly owed task, notification delivery, or resolution.
    const body = {
      task_id: taskId,
      action_key: actionKey,
      action_kind: "verified_comment_posted",
      state_after: stateAfter,
      expected_revision: expectedRevision,
      note: "Connected actor's ClickUp comment ID and authorship verified by readback; delivery and recipient response unverified.",
      evidence_comment_id: commentId,
      waiting_on_user_id: waitingOn,
      next_check_at_ms: nextCheck,
    };
    const { response: saved, payload: savedPayload } = await readPrivate(
      new Request("https://internal/followups/record", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
    if (saved.status === 409) return { recorded: false, reason: "concurrent_followup_update" };
    if (!saved.ok) return { recorded: false, reason: "private_storage_failed" };
    const result = obj(savedPayload);
    if (!result || result["task_id"] !== taskId || !Number.isSafeInteger(result["revision"]))
      return { recorded: false, reason: "malformed_private_response" };
    return {
      recorded: true,
      action_key: actionKey,
      revision: result["revision"] as number,
    };
  } catch (error) {
    // A timed-out private write may still commit later. Report uncertainty
    // and reconcile by its stable action key; never repeat the ClickUp POST.
    return {
      recorded: false,
      reason:
        error instanceof PrivateObservationTimeout
          ? "private_storage_timeout"
          : "private_storage_failed",
    };
  }
}
