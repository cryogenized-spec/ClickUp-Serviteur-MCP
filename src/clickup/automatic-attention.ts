/**
 * Backend-only attention classification. It derives routing from an authorised,
 * freshly synchronized task snapshot and signed webhook metadata; it never
 * interprets text, assumes the user read a notification, or mutates ClickUp.
 */
export interface AttentionHint {
  readonly event_key: string;
  readonly event: string;
  readonly received_at: number;
  readonly metadata?: {
    readonly actor_user_id?: string;
    readonly assignee_user_id?: string;
    readonly mentioned_user_ids?: readonly string[];
    readonly field?: string;
  };
}

export interface AttentionSnapshot {
  readonly task_id: string;
  readonly source_updated_at_ms: number;
  readonly closed_at_ms: number | null;
  readonly assignee_ids: readonly string[];
}

export interface AttentionFollowup {
  readonly state?: string;
  readonly waiting_on_user_id?: string | null;
}

export interface AttentionDecision {
  readonly ownership: "assigned" | "delegated" | "unassigned" | "closed";
  readonly needs_attention: boolean;
  readonly changed: boolean;
  readonly reason: "assigned_change" | "direct_mention" | "owned_change" | "delegated_change" | "unassigned_change" | "no_change";
  readonly event_count: number;
}

/** Pure, deterministic decision; user-awareness/report-delivery is a separate state. */
export function classifyAutomaticAttention(
  snapshot: AttentionSnapshot,
  me: string,
  hints: readonly AttentionHint[],
  followup: AttentionFollowup | null,
): AttentionDecision {
  const closed = snapshot.closed_at_ms !== null || followup?.state === "resolved";
  const assigned = snapshot.assignee_ids.includes(me);
  const delegated =
    !assigned &&
    followup?.state === "awaiting_response" &&
    !!followup.waiting_on_user_id &&
    followup.waiting_on_user_id !== me;
  const ownership: AttentionDecision["ownership"] = closed
    ? "closed"
    : assigned
      ? "assigned"
      : delegated
        ? "delegated"
        : "unassigned";
  const mentioned = hints.some(
    (event) =>
      event.metadata?.actor_user_id !== me &&
      event.metadata?.mentioned_user_ids?.includes(me) === true,
  );
  const assignedChange = hints.some(
    (event) =>
      event.metadata?.assignee_user_id === me &&
      (event.metadata.field === "assignee_add" || event.event === "taskAssigneeUpdated") &&
      event.metadata.actor_user_id !== me,
  );
  const ownedExternalChange = hints.some(
    (event) =>
      event.metadata?.actor_user_id !== me &&
      event.event !== "taskTimeTrackedUpdated",
  );
  const changed = hints.length > 0;
  const needsAttention =
    !closed && (assignedChange || mentioned || (assigned && ownedExternalChange));
  const reason: AttentionDecision["reason"] = !changed
    ? "no_change"
    : assignedChange
      ? "assigned_change"
      : mentioned
        ? "direct_mention"
        : assigned && ownedExternalChange
          ? "owned_change"
          : delegated
            ? "delegated_change"
            : "unassigned_change";
  return {
    ownership,
    needs_attention: needsAttention,
    changed,
    reason,
    event_count: hints.length,
  };
}
