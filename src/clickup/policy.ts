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
  readonly workspaceId: string;
  readonly apiToken: string;
  readonly quota: {
    readonly idFromName: (name: string) => unknown;
    readonly get: (id: never) => { fetch: (request: Request) => Promise<Response> };
  };
}

export class ReadFailure extends Error {
  constructor(readonly code: string) {
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
  return {
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
  "create_scoped_task",
  "clickup_create_task",
  "clickup_create_bulk_tasks",
  "clickup_update_task",
  "clickup_set_custom_field",
  "clickup_update_bulk_tasks",
  "clickup_attach_file_to_task",
  "clickup_attach_chatgpt_file_to_task",
  "clickup_create_task_comment",
  "clickup_edit_task_comment",
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
  "clickup_create_bulk_tasks",
  "clickup_update_task",
  "clickup_set_custom_field",
  "clickup_update_bulk_tasks",
  "clickup_attach_file_to_task",
  "clickup_attach_chatgpt_file_to_task",
  "clickup_create_task_comment",
  "clickup_edit_task_comment",
  "clickup_add_tag_to_task",
  "clickup_add_task_link",
  "clickup_add_dependency",
  "clickup_start_time_tracking",
  "clickup_add_time_entry",
  "clickup_get_task_comments",
  "clickup_get_threaded_replies",
  "clickup_get_task_time_entries",
  "clickup_get_task_time_in_status",
]);

export function isCompanyNonDestructiveOperation(name: string): boolean {
  return COMPANY_SAFE_WRITE_OPERATIONS.has(name);
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
    if (!operation || !isCompanyNonDestructiveOperation(operation))
      throw new ReadFailure("CLICKUP_COMPANY_OPERATION_DISABLED");
  }
  const details = record(auth);
  const scopes = details?.["scopes"];
  if (!Array.isArray(scopes) || !scopes.includes("mcp:write")) {
    throw new ReadFailure("CLICKUP_WRITE_SCOPE_REQUIRED");
  }
  return requireReadGrant(auth, bindings);
}
