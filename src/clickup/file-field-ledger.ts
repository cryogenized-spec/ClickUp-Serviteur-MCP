import { ReadFailure, type ReadGrant } from "./policy.js";

/**
 * A task/Files-field-scoped Durable Object keeps an owner-bound pending-upload
 * ledger and an irreversible one-shot association claim. The caller cannot
 * create ledger entries merely by supplying an attachment ID.
 *
 * The ledger lives in the existing CLICKUP_QUOTA namespace but uses separate
 * object IDs from rate-limit instances. Internal-only routes are never public.
 */
export async function filePendingLedger(
  grant: ReadGrant,
  taskId: string,
  fieldId: string,
  attachmentId: string,
  action: "register" | "verify" | "claim",
): Promise<boolean> {
  if (
    !/^[1-9][0-9]{0,17}$/.test(grant.workspaceId) ||
    !/^[a-zA-Z0-9_-]{1,80}$/.test(taskId) ||
    !/^[a-zA-Z0-9_-]{1,100}$/.test(fieldId) ||
    !/^[a-zA-Z0-9._-]{1,100}$/.test(attachmentId)
  ) {
    throw new ReadFailure("CLICKUP_INVALID_ARGUMENT");
  }
  try {
    // Delimiter cannot occur in any identifier, preserving one DO per field.
    const name = "file-field:" + grant.workspaceId + "/" + taskId + "/" + fieldId;
    const binding = grant.quota;
    const instance = binding.get(binding.idFromName(name) as never);
    const response = await instance.fetch(
      new Request("https://internal.invalid/file-pending-" + action, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          subject: grant.subject,
          clickupUserId: grant.clickupUserId,
          generation: grant.connectionGeneration ?? "",
          attachmentId,
        }),
      }),
    );
    if (!response.ok) throw new Error("ledger unavailable");
    const raw: unknown = await response.json();
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("invalid ledger");
    return (raw as Record<string, unknown>)["allowed"] === true;
  } catch {
    // Never fall back to trusting a caller-supplied opaque attachment ID.
    throw new ReadFailure("CLICKUP_FILE_PROVENANCE_UNAVAILABLE");
  }
}
