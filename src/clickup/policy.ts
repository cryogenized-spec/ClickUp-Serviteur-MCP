import { parseStaffAllowlist } from "../auth/staff.js";
import { personalClickUpCredential } from "./per-user-oauth.js";

export interface ReadGrant {
  readonly subject: string;
  readonly clickupUserId: string;
  readonly listId: string;
  /** Private OAuth credential generation; never exposed to model/tool outputs. */
  readonly connectionGeneration?: string | null;
  /** Explicit owner-controlled catalogue authority; unset is legacy single-List. */
  readonly resourceScope?: "list" | "workspace";
  /** Runtime-proven company List-only mode; permits preflight-verified task edits. */
  readonly companyListTaskAccess?: boolean;
  /** Company owner opt-in cleanup, never inferred from ordinary write grants. */
  readonly companyCleanupAccess?: boolean;
  readonly workspaceId: string;
  readonly apiToken: string;
  readonly webhookEvents?: ReadGrant["quota"];
  readonly webhookOrigin?: string;
  readonly quota: {
    readonly idFromName: (name: string) => unknown;
    readonly get: (id: never) => { fetch: (request: Request) => Promise<Response> };
  };
}

/** Only fixed, non-sensitive categories and HTTP statuses may cross the MCP error boundary. */
export interface UpstreamDiagnostic {
  readonly endpoint_category: "chat_message_send" | "clickup_api_read" | "clickup_api_write";
  readonly http_status?: number;
  readonly upstream_ecode?: string;
  readonly authorization_target?: "task" | "list" | "workspace" | "other";
  readonly write_outcome?: "rejected" | "unknown";
}

/** Status-only diagnostic; deliberately never consumes or forwards error bodies. */
export function apiDiagnostic(method: string, status: number): UpstreamDiagnostic {
  if (method === "GET") return { endpoint_category: "clickup_api_read", http_status: status };
  return {
    endpoint_category: "clickup_api_write",
    http_status: status,
    write_outcome: status >= 500 || status === 408 || status === 425 ? "unknown" : "rejected",
  };
}

/** Only documented, fixed OAuth codes may leave the upstream response. */
export async function authorizationDiagnostic(
  method: string,
  response: Response,
  path: string,
): Promise<UpstreamDiagnostic> {
  const base = apiDiagnostic(method, response.status);
  const target = path.replace(/^api\/v[23]\//, "").split("/")[0];
  const authorization_target =
    target === "task" || target === "list" ? target : target === "team" ? "workspace" : "other";
  const result: UpstreamDiagnostic = { ...base, authorization_target };
  const body = response.body;
  if (!body) return result;
  const length = response.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > 2048)) {
    void body.cancel().catch(() => undefined);
    return result;
  }
  const reader = body.getReader();
  const bytes = new Uint8Array(2048);
  let used = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      if (used + part.value.byteLength > bytes.length) {
        void reader.cancel().catch(() => undefined);
        return result;
      }
      bytes.set(part.value, used);
      used += part.value.byteLength;
    }
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes.subarray(0, used)));
    const data = record(parsed);
    const code = data?.["ECODE"] ?? data?.["ecode"];
    if (
      typeof code === "string" &&
      /^OAUTH_(007|010|017|019|021|023|025|026|027|029|03[0-9]|04[0-5]|077|171)$/.test(code)
    )
      return { ...result, upstream_ecode: code };
    return result;
  } catch {
    void reader.cancel().catch(() => undefined);
    return result;
  } finally {
    reader.releaseLock();
  }
}

export class ReadFailure extends Error {
  constructor(
    readonly code: string,
    readonly diagnostic?: UpstreamDiagnostic,
  ) {
    super(code);
    this.name = "ReadFailure";
  }
}
function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Mandatory two-authority check: current app List grant AND the individual's
 * ClickUp OAuth credential. Shared service tokens can never authorize reads.
 */
export async function requireReadGrant(auth: unknown, bindings: unknown): Promise<ReadGrant> {
  const identity = record(auth);
  const extra = record(identity?.["extra"]);
  const env = record(bindings);
  const subject = extra?.["subject"];
  const scopes = identity?.["scopes"];
  if (
    !identity ||
    !env ||
    typeof subject !== "string" ||
    !/^github:[1-9]\d{0,15}$/.test(subject) ||
    !Array.isArray(scopes) ||
    (!(scopes.length === 1 && scopes[0] === "mcp:read") &&
      !(scopes.length === 2 && scopes.includes("mcp:read") && scopes.includes("mcp:write")))
  ) {
    throw new ReadFailure("CLICKUP_ACCESS_DENIED");
  }
  if (env["CLICKUP_LIVE_ENABLED"] !== "true") {
    throw new ReadFailure("CLICKUP_NOT_CONFIGURED");
  }
  const listId = env["CLICKUP_LIST_ID"];
  const resourceScope = env["CLICKUP_RESOURCE_SCOPE"] ?? "list";
  const readIds = env["CLICKUP_READ_GITHUB_IDS"];
  const quota = record(env["CLICKUP_QUOTA"]);
  if (
    (resourceScope !== "list" && resourceScope !== "workspace") ||
    typeof listId !== "string" ||
    !/^[1-9]\d{0,17}$/.test(listId) ||
    typeof readIds !== "string" ||
    !quota ||
    typeof quota["idFromName"] !== "function" ||
    typeof quota["get"] !== "function"
  ) {
    throw new ReadFailure("CLICKUP_NOT_CONFIGURED");
  }
  let approved: ReadonlySet<string>;
  try {
    approved = parseStaffAllowlist(readIds);
    const loggedIn = parseStaffAllowlist(env["ALLOWED_GITHUB_IDS"]);
    if ([...approved].some((id) => !loggedIn.has(id))) throw Error("Inconsistent grants");
  } catch {
    throw new ReadFailure("CLICKUP_NOT_CONFIGURED");
  }
  if (!approved.has(subject.slice(7))) throw new ReadFailure("CLICKUP_ACCESS_DENIED");
  const user = await personalClickUpCredential(auth, bindings);
  if (user.subject !== subject) throw new ReadFailure("CLICKUP_ACCESS_DENIED");
  // Workspace-wide catalogue operations are safe only with an OAuth credential
  // proven at consent to cover precisely this one Workspace; legacy cached
  // tokens carry no such proof and must reconnect rather than be grandfathered.
  // Staging may default to Workspace mode, but only owner-allowlisted GitHub
  // identities with exclusive ClickUp OAuth can gain broader authority.
  // Revoking the owner allowlist immediately returns their scope to List-only.
  let workspaceApproved = false;
  const workspaceIds = env["CLICKUP_WORKSPACE_GITHUB_IDS"];
  if (typeof workspaceIds === "string") {
    try {
      const permitted = parseStaffAllowlist(workspaceIds);
      workspaceApproved =
        permitted.has(subject.slice(7)) && [...permitted].every((entry) => approved.has(entry));
    } catch {
      throw new ReadFailure("CLICKUP_NOT_CONFIGURED");
    }
  }
  const effectiveScope =
    workspaceApproved && (resourceScope === "workspace" || user.workspaceEnabled === true)
      ? "workspace"
      : "list";
  if (effectiveScope === "workspace" && user.workspaceExclusive !== true)
    throw new ReadFailure("CLICKUP_WORKSPACE_RECONSENT_REQUIRED");
  const eventBinding = record(env["CLICKUP_WEBHOOK_EVENTS"]);
  const webhookEvents =
    env["CLICKUP_WEBHOOK_ENABLED"] === "true" &&
    effectiveScope === "workspace" &&
    eventBinding &&
    typeof eventBinding["idFromName"] === "function" &&
    typeof eventBinding["get"] === "function"
      ? (eventBinding as unknown as ReadGrant["quota"])
      : undefined;
  return {
    ...(webhookEvents ? { webhookEvents } : {}),
    ...(webhookEvents && typeof env["MCP_PUBLIC_ORIGIN"] === "string"
      ? { webhookOrigin: env["MCP_PUBLIC_ORIGIN"] }
      : {}),
    subject,
    clickupUserId: user.clickupUserId,
    // A user's selected List is scoped to the same OAuth Workspace and
    // never broadens their resourceScope. Stale/missing selections fall back.
    listId: effectiveScope === "workspace" ? (user.selectedListId ?? listId) : listId,
    connectionGeneration: user.connectionGeneration,
    resourceScope: effectiveScope,
    companyListTaskAccess:
      env["CLICKUP_COMPANY_PROFILE"] === "true" &&
      env["CLICKUP_COMPANY_WRITE_MODE"] === "non_destructive" &&
      effectiveScope === "list",
    companyCleanupAccess:
      env["CLICKUP_COMPANY_PROFILE"] === "true" &&
      env["CLICKUP_COMPANY_WRITE_MODE"] === "non_destructive" &&
      env["CLICKUP_COMPANY_CLEANUP_ENABLED"] === "true" &&
      workspaceApproved &&
      effectiveScope === "workspace" &&
      user.workspaceExclusive === true,
    workspaceId: user.workspaceId,
    apiToken: user.token,
    quota: quota as unknown as ReadGrant["quota"],
  };
}

/**
 * Explicit company-only, non-destructive mutation policy. This list does not
 * grant Workspace rights. Task-ID edits are allowed only after a verified
 * home-List preflight using the connected employee's own OAuth permission.
 *
 * Deletions, removals, moves, document-content replacement and authority
 * expansion are deliberately absent. Every name must be reviewed individually.
 */
export const COMPANY_SAFE_WRITE_OPERATIONS: ReadonlySet<string> = new Set([
  "clickup_create_webhook_subscription",
  "clickup_update_webhook_subscription",
  "clickup_update_task_checklist",
  "clickup_create_list_comment",
  "clickup_create_subfolder",
  "clickup_move_folder",
  "clickup_create_chat_channel",
  "clickup_update_goal_name",
  "clickup_update_key_result_progress",
  "clickup_acknowledge_activity",
  "clickup_create_list_from_template",
  "clickup_create_folder_from_template",
  "create_scoped_task",
  "clickup_create_task",
  "clickup_create_subtask",
  "clickup_reparent_task",
  "clickup_create_task_from_template",
  "clickup_create_bulk_tasks",
  "clickup_update_task",
  "clickup_set_custom_field",
  "clickup_update_bulk_tasks",
  "clickup_attach_file_to_task",
  "clickup_attach_chatgpt_file_to_task",
  "clickup_create_task_comment",
  "clickup_edit_task_comment",
  "clickup_patch_task_comment",
  "clickup_create_task_checklist",
  "clickup_create_checklist_item",
  "clickup_update_checklist_item",
  "clickup_add_tag_to_task",
  "clickup_add_task_link",
  "clickup_add_dependency",
  "clickup_start_time_tracking",
  "clickup_stop_time_tracking",
  "clickup_add_time_entry",
  "clickup_create_list",
  "clickup_create_list_in_folder",
  "clickup_update_list",
  "clickup_create_folder",
  "clickup_update_folder",
  "clickup_send_chat_message",
  "clickup_open_direct_message",
  "clickup_create_chat_reply",
  "clickup_edit_own_chat_message",
  "clickup_add_chat_reaction",
  "clickup_create_document",
  "clickup_create_document_page",
]);

/**
 * Operations whose target task (and any second task) is checked against the
 * configured List immediately before access. No cross-List write or Workspace
 * authority is implied. Existing task fields, comments and assignments are
 * ordinary edits, not destructive actions.
 */
export const COMPANY_LIST_TASK_OPERATIONS: ReadonlySet<string> = new Set([
  "clickup_create_task",
  "clickup_create_subtask",
  "clickup_reparent_task",
  "clickup_list_direct_subtasks",
  "clickup_create_bulk_tasks",
  "clickup_update_task",
  "clickup_set_custom_field",
  "clickup_update_bulk_tasks",
  "clickup_attach_file_to_task",
  "clickup_attach_chatgpt_file_to_task",
  "clickup_create_task_comment",
  "clickup_edit_task_comment",
  "clickup_patch_task_comment",
  "clickup_add_tag_to_task",
  "clickup_add_task_link",
  "clickup_add_dependency",
  "clickup_start_time_tracking",
  "clickup_add_time_entry",
  "clickup_get_task_comments",
  "clickup_create_task_checklist",
  "clickup_create_checklist_item",
  "clickup_update_checklist_item",
  "clickup_read_task_pdf",
  "clickup_read_task_image",
  "clickup_get_threaded_replies",
  "clickup_get_task_time_entries",
  "clickup_get_task_time_in_status",
]);

export function isCompanyNonDestructiveOperation(name: string): boolean {
  return COMPANY_SAFE_WRITE_OPERATIONS.has(name);
}

/** Owner-only cleanup operations that become available only after an explicit
 * company deployment opt-in; ordinary non-destructive mode remains unchanged.
 * No general delete-List/Folder/Doc privilege is inferred from this grant.
 */
export const COMPANY_OWNER_CLEANUP_OPERATIONS: ReadonlySet<string> = new Set([
  "clickup_delete_webhook_subscription",
  "clickup_clear_custom_field",
  "clickup_delete_task_checklist",
  "clickup_delete_checklist_item",
  "clickup_merge_tasks",
  "clickup_delete_task",
  "clickup_delete_task_comment",
  "clickup_remove_tag_from_task",
  "clickup_remove_task_link",
  "clickup_remove_dependency",
  "clickup_delete_own_chat_message",
  "clickup_remove_own_chat_reaction",
]);

export function isCompanyOwnerCleanupOperation(name: string): boolean {
  return COMPANY_OWNER_CLEANUP_OPERATIONS.has(name);
}

/** Enforced before obtaining the per-user token, including direct MCP calls. */
export async function requireWriteGrant(
  auth: unknown,
  bindings: unknown,
  operation?: string,
): Promise<ReadGrant> {
  const env = record(bindings);
  if (env?.["CLICKUP_COMPANY_READ_ONLY"] === "true")
    throw new ReadFailure("CLICKUP_COMPANY_WRITE_DISABLED");
  if (env?.["CLICKUP_COMPANY_PROFILE"] === "true") {
    if (env["CLICKUP_COMPANY_WRITE_MODE"] !== "non_destructive")
      throw new ReadFailure("CLICKUP_COMPANY_WRITE_DISABLED");
    if (
      !operation ||
      !(
        isCompanyNonDestructiveOperation(operation) ||
        (env["CLICKUP_COMPANY_CLEANUP_ENABLED"] === "true" &&
          isCompanyOwnerCleanupOperation(operation))
      )
    )
      throw new ReadFailure("CLICKUP_COMPANY_OPERATION_DISABLED");
  }
  const details = record(auth);
  const scopes = details?.["scopes"];
  if (!Array.isArray(scopes) || !scopes.includes("mcp:write")) {
    throw new ReadFailure("CLICKUP_WRITE_SCOPE_REQUIRED");
  }
  const grant = await requireReadGrant(auth, bindings);
  if (
    operation &&
    isCompanyOwnerCleanupOperation(operation) &&
    env?.["CLICKUP_COMPANY_PROFILE"] === "true" &&
    !grant.companyCleanupAccess
  )
    throw new ReadFailure("CLICKUP_COMPANY_OPERATION_DISABLED");
  return grant;
}
