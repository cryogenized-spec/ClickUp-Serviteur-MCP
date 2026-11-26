import type { ReadGrant } from "./policy.js";

export type VerifiedCommentObservation = {
  recorded: boolean;
  action_key?: string;
  revision?: number;
  reason?:
    | "private_storage_unavailable"
    | "private_storage_failed"
    | "invalid_evidence"
    | "conflicting_record"
    | "concurrent_followup_update"
    | "malformed_private_response";
};

const states = new Set([
  "detected", "verified", "action_required", "action_taken",
  "awaiting_response", "response_received", "resolved",
]);

const obj = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
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
  if (
    !/^[a-zA-Z0-9_-]{1,80}$/.test(taskId) ||
    !/^[a-zA-Z0-9_-]{1,100}$/.test(commentId)
  ) return { recorded: false, reason: "invalid_evidence" };
  if (!grant.taskIndex)
    return { recorded: false, reason: "private_storage_unavailable" };

  const actionKey = "verified-comment:" + commentId;
  const stub = grant.taskIndex.get(
    grant.taskIndex.idFromName(grant.workspaceId + ":" + grant.subject) as never,
  );

  try {
    // An exact committed receipt takes precedence over a fresh current
    // revision. This keeps repeated observations idempotent even if later
    // private follow-up changes have already advanced the state.
    const receiptUrl = new URL("https://internal/followups/receipt");
    receiptUrl.searchParams.set("task_id", taskId);
    receiptUrl.searchParams.set("action_key", actionKey);
    const receiptResponse = await stub.fetch(new Request(receiptUrl));
    if (!receiptResponse.ok)
      return { recorded: false, reason: "private_storage_failed" };
    const receiptEnvelope = obj(await receiptResponse.json());
    if (!receiptEnvelope)
      return { recorded: false, reason: "malformed_private_response" };
    const receipt = obj(receiptEnvelope["receipt"]);
    if (receipt) {
      const original = typeof receipt["request_json"] === "string"
        ? obj(JSON.parse(receipt["request_json"])) : null;
      if (
        receipt["task_id"] !== taskId ||
        receipt["action_key"] !== actionKey ||
        !Number.isSafeInteger(receipt["revision"]) ||
        original?.["task_id"] !== taskId ||
        original["action_key"] !== actionKey ||
        original["action_kind"] !== "verified_comment_posted" ||
        original["evidence_comment_id"] !== commentId
      ) return { recorded: false, reason: "conflicting_record" };
      return {
        recorded: true,
        action_key: actionKey,
        revision: receipt["revision"] as number,
      };
    }

    const stateUrl = new URL("https://internal/followups/task");
    stateUrl.searchParams.set("task_id", taskId);
    stateUrl.searchParams.set("limit", "1");
    const stateResponse = await stub.fetch(new Request(stateUrl));
    if (!stateResponse.ok)
      return { recorded: false, reason: "private_storage_failed" };
    const snapshot = obj(await stateResponse.json());
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
        (waiting !== null && waiting !== undefined &&
          (typeof waiting !== "string" || !/^[1-9]\d{0,23}$/.test(waiting))) ||
        (due !== null && due !== undefined &&
          (!Number.isSafeInteger(due) || Number(due) < 0))
      ) return { recorded: false, reason: "malformed_private_response" };
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
    const saved = await stub.fetch(new Request("https://internal/followups/record", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }));
    if (saved.status === 409)
      return { recorded: false, reason: "concurrent_followup_update" };
    if (!saved.ok) return { recorded: false, reason: "private_storage_failed" };
    const result = obj(await saved.json());
    if (
      !result ||
      result["task_id"] !== taskId ||
      !Number.isSafeInteger(result["revision"])
    ) return { recorded: false, reason: "malformed_private_response" };
    return {
      recorded: true,
      action_key: actionKey,
      revision: result["revision"] as number,
    };
  } catch {
    // Never treat a private write timeout/unknown result as reason to repeat
    // the already-posted ClickUp comment.
    return { recorded: false, reason: "private_storage_failed" };
  }
}
