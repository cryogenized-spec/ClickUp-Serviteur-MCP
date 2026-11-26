import type { OAuthEnv } from "../auth/env.js";
import { readVerifiedTaskForIndex, runCatalogOperation } from "./catalog-runtime.js";
import { ReadFailure, requireReadGrant, type ReadGrant } from "./policy.js";
import { projectCommentSnapshot, projectTaskSnapshot, type TaskIndexStore } from "./task-index.js";

/** Only a verified, signed webhook registration may supply this identity.
 * No public MCP tool accepts an actor string for background synchronization.
 */
export interface SignedWebhookOwner {
  readonly workspaceId: string;
  readonly subject: string;
}

/** Authorization is re-derived on EVERY alarm from the current allowlist,
 * existing per-user ClickUp OAuth vault and the configured List/Workspace scope.
 * This is not an impersonation grant available to model/tool inputs.
 */
export async function grantForSignedWebhook(
  owner: SignedWebhookOwner,
  env: OAuthEnv,
): Promise<ReadGrant> {
  if (
    owner.workspaceId !== env.CLICKUP_WORKSPACE_ID ||
    !/^github:[1-9]\d{0,15}$/.test(owner.subject)
  )
    throw new ReadFailure("CLICKUP_ACCESS_DENIED");
  // This internal authorization envelope exists solely after signed ingress.
  // requireReadGrant performs the normal staff consent, OAuth credential,
  // configured Workspace and List authority checks.
  const auth = { scopes: ["mcp:read"], extra: { subject: owner.subject } };
  const grant = await requireReadGrant(auth, env);
  if (grant.workspaceId !== owner.workspaceId || grant.subject !== owner.subject)
    throw new ReadFailure("CLICKUP_ACCESS_DENIED");
  // The Durable Object refresh operates on its own TaskIndexStore, avoiding
  // re-entrant self-RPC from ordinary capture hooks during alarm processing.
  const uncached: ReadGrant = { ...grant };
  Reflect.deleteProperty(uncached, "taskIndex");
  Reflect.deleteProperty(uncached, "webhookEvents");
  return uncached;
}

export interface DirtyTask {
  readonly task_id: string;
  readonly task_dirty: boolean;
  readonly comments_dirty: boolean;
  readonly attempts: number;
}

/** The provider remains authoritative; only GETs with the current person's
 * ClickUp OAuth grant can advance the private persistent checkpoints.
 */
export async function synchronizeDirtyTask(
  item: DirtyTask,
  grant: ReadGrant,
  store: TaskIndexStore,
  transport: typeof fetch,
  call: typeof runCatalogOperation = runCatalogOperation,
  now: () => number = Date.now,
  readTask: typeof readVerifiedTaskForIndex = readVerifiedTaskForIndex,
): Promise<{ complete: boolean; indexed_comments: number }> {
  const startedAt = now();
  if (!Number.isSafeInteger(startedAt) || startedAt <= 0) throw new Error("SYNC_CLOCK_UNAVAILABLE");
  try {
    if (item.task_dirty) {
      const task = await readTask(grant, transport, item.task_id);
      const snapshot = projectTaskSnapshot(task);
      if (!snapshot) throw new ReadFailure("CLICKUP_BAD_RESPONSE");
      if (grant.resourceScope !== "workspace" && snapshot.list_id !== grant.listId)
        throw new ReadFailure("CLICKUP_SCOPE_OR_SCHEMA_REJECTED");
      // A late, older upstream revision must not be reported as complete:
      // its SQLite UPSERT is rejected and the dirty marker remains pending.
      if (!store.storeTask(snapshot, startedAt)) return { complete: false, indexed_comments: 0 };
    }
    if (!item.comments_dirty) return { complete: true, indexed_comments: 0 };
    const page = await call(
      "clickup_get_task_comments",
      { task_id: item.task_id, max_results: 50 },
      grant,
      transport,
    );
    if (!Array.isArray(page["comments"])) throw new ReadFailure("CLICKUP_BAD_RESPONSE");
    const comments = page["comments"].map(projectCommentSnapshot);
    if (comments.some((comment) => comment === null)) throw new ReadFailure("CLICKUP_BAD_RESPONSE");
    const verifiedComments = comments.filter(
      (comment): comment is NonNullable<typeof comment> => comment !== null,
    );
    const complete =
      page["incomplete"] === false &&
      page["continuation_unavailable"] !== true &&
      page["content_truncated"] !== true;
    store.storeComments(item.task_id, verifiedComments, startedAt, complete);
    return { complete, indexed_comments: comments.length };
  } catch (error) {
    // Never let a formerly accessible task leak through a later cached read
    // when ClickUp's current authorization has explicitly denied it.
    if (
      error instanceof ReadFailure &&
      (error.code === "CLICKUP_SCOPE_OR_SCHEMA_REJECTED" ||
        error.code === "CLICKUP_ACCESS_DENIED" ||
        error.code === "CLICKUP_UPSTREAM_DENIED" ||
        (error.code === "CLICKUP_UPSTREAM_UNAVAILABLE" && error.diagnostic?.http_status === 404))
    )
      store.discardSnapshots(item.task_id);
    throw error;
  }
}

export function retryDelayMs(error: unknown, attempts: number): number {
  if (error instanceof ReadFailure && error.code === "CLICKUP_RATE_LIMITED") return 60_000;
  const count = Math.max(0, Math.min(7, attempts));
  return Math.min(60 * 60_000, 30_000 * 2 ** count);
}
