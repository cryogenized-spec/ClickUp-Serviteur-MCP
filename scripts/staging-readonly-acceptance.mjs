/**
 * Optional OWNER-OPERATED staging-only readback acceptance. All network MCP
 * operations are fixed READ tools; no admin, Chat send or task write endpoints.
 * The caller supplies a short-lived staging MCP bearer token privately.
 *
 * Never print tool response bodies, IDs, user names, bearer tokens or upstream
 * errors: even a "read-only" response may contain staff/customer information.
 */
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

// Pin this owner's known Worker account. Do not accept a look-alike workers.dev host.
const STAGING_HOST = "clickup-serviteur-staging.cryogenized.workers.dev";
const SHA = /^[a-f0-9]{40}$/i;
const NUMERIC_ID = /^[1-9][0-9]{0,23}$/;
const GOAL_ID = /^[a-zA-Z0-9_-]{1,80}$/;
const REQUIRED_READ_TOOLS = Object.freeze([
  "service_info",
  "get_clickup_connection_status",
  "clickup_get_workspace_goals",
  "clickup_get_sprint_task_snapshot",
]);

export class StagingAcceptanceError extends Error {
  constructor(stage) {
    super("STAGING_ACCEPTANCE_FAILED");
    this.name = "StagingAcceptanceError";
    this.stage = stage;
  }
}

function requireShape(value, stage) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new StagingAcceptanceError(stage);
  return value;
}

/** No request may be configured to target the protected company Worker. */
export function stagingConfig(env) {
  const endpointText = env.STAGING_MCP_URL;
  let endpoint;
  try {
    endpoint = new URL(endpointText);
  } catch {
    throw new StagingAcceptanceError("configuration");
  }
  if (
    endpoint.protocol !== "https:" ||
    endpoint.hostname !== STAGING_HOST ||
    endpoint.pathname !== "/mcp" ||
    endpoint.username ||
    endpoint.password ||
    endpoint.port ||
    endpoint.search ||
    endpoint.hash
  )
    throw new StagingAcceptanceError("configuration");

  const token = env.STAGING_ACCESS_TOKEN;
  const buildSha = env.STAGING_EXPECTED_BUILD_SHA;
  const workspaceId = env.STAGING_EXPECTED_WORKSPACE_ID;
  const listId = env.STAGING_EXPECTED_LIST_ID;
  const goalId = env.STAGING_GOAL_ID;
  if (
    typeof token !== "string" ||
    token.length < 12 ||
    token.length > 4096 ||
    /\s/.test(token) ||
    typeof buildSha !== "string" ||
    !SHA.test(buildSha) ||
    typeof workspaceId !== "string" ||
    !NUMERIC_ID.test(workspaceId) ||
    typeof listId !== "string" ||
    !NUMERIC_ID.test(listId) ||
    (goalId !== undefined && (typeof goalId !== "string" || !GOAL_ID.test(goalId)))
  )
    throw new StagingAcceptanceError("configuration");

  return { endpoint, token, buildSha, workspaceId, listId, goalId };
}

export function sameOriginAuthorizedFetch(endpoint, token, fetcher) {
  return async (input, init) => {
    const isRequest = input instanceof Request;
    const url = new URL(isRequest ? input.url : String(input));
    if (
      url.origin !== endpoint.origin ||
      url.pathname !== "/mcp" ||
      url.search ||
      url.hash ||
      url.username ||
      url.password
    )
      throw new StagingAcceptanceError("network_origin");
    const headers = new Headers(isRequest ? input.headers : undefined);
    for (const [name, value] of new Headers(init?.headers)) headers.set(name, value);
    headers.set("Authorization", "Bearer " + token);
    // Preserve an SDK Request's method and body; never follow an OAuth redirect.
    return fetcher(isRequest ? input : url, { ...init, headers, redirect: "manual" });
  };
}

/** Executes only a fixed list of GET-backed MCP tools. Client and output are
 * injectable so CI can prove the no-writes behavior without live credentials. */
export async function verifyStagingReadOnly(client, config, report = () => {}) {
  const toolsReply = await client.listTools();
  const tools = toolsReply?.tools;
  if (!Array.isArray(tools)) throw new StagingAcceptanceError("discovery");
  for (const name of [
    ...REQUIRED_READ_TOOLS,
    ...(config.goalId ? ["clickup_get_goal_details"] : []),
  ]) {
    const entry = tools.find((tool) => tool?.name === name);
    if (!entry || entry.annotations?.readOnlyHint !== true)
      throw new StagingAcceptanceError("discovery");
  }
  report("discovery");

  const read = async (name, arguments_, stage) => {
    let result;
    try {
      result = await client.callTool({ name, arguments: arguments_ });
    } catch {
      throw new StagingAcceptanceError(stage);
    }
    if (result?.isError === true)
      throw new StagingAcceptanceError(stage);
    return requireShape(result?.structuredContent, stage);
  };

  const service = await read("service_info", {}, "build");
  if (
    service.build_sha !== config.buildSha ||
    service.liveClickUp !== true ||
    service.authentication !== "github-oauth-plus-individual-clickup-oauth"
  )
    throw new StagingAcceptanceError("build");
  report("build");

  const connection = await read("get_clickup_connection_status", {}, "connection");
  if (
    connection.connected !== true ||
    String(connection.workspace_id) !== config.workspaceId ||
    String(connection.selected_list_id) !== config.listId ||
    connection.workspace_exclusive !== true ||
    connection.workspace_scope_enabled !== true ||
    connection.workspace_scope_approved !== true ||
    connection.mcp_read_scope_granted !== true
  )
    throw new StagingAcceptanceError("connection");
  report("connection");

  const goals = await read(
    "clickup_get_workspace_goals",
    { include_completed: true, max_results: 5 },
    "goals",
  );
  if (
    String(goals.workspace_id) !== config.workspaceId ||
    goals.source !== "clickup-api-v2" ||
    goals.local_offset_only !== true ||
    !Array.isArray(goals.goals) ||
    goals.goals.length > 5 ||
    goals.goals.some((g) => !g || typeof g.id !== "string")
  )
    throw new StagingAcceptanceError("goals");
  report("goals");

  if (config.goalId) {
    const goal = await read(
      "clickup_get_goal_details",
      { goal_id: config.goalId, max_results: 5 },
      "goal_details",
    );
    if (
      String(goal.workspace_id) !== config.workspaceId ||
      goal.goal_id !== config.goalId ||
      goal.source !== "clickup-api-v2" ||
      requireShape(goal.goal, "goal_details").id !== config.goalId ||
      !Array.isArray(goal.goal.key_results) ||
      goal.goal.key_results.length > 5
    )
      throw new StagingAcceptanceError("goal_details");
    report("goal_details");
  }

  const sprint = await read(
    "clickup_get_sprint_task_snapshot",
    { list_id: config.listId, max_results: 5, task_page: 0, task_offset: 0 },
    "sprint_snapshot",
  );
  if (
    String(sprint.list_id) !== config.listId ||
    sprint.source !== "clickup-api-v2" ||
    sprint.official_sprint_report !== false ||
    sprint.snapshot_not_velocity_or_burndown !== true ||
    sprint.list_verified_as_sprint !== false ||
    sprint.home_list_tasks_only !== true ||
    !Array.isArray(sprint.tasks) ||
    sprint.tasks.length > 5 ||
    sprint.tasks.some((task) => !task || typeof task.id !== "string")
  )
    throw new StagingAcceptanceError("sprint_snapshot");
  report("sprint_snapshot");
  return true;
}

async function main() {
  try {
    const config = stagingConfig(process.env);
    const { Client, StreamableHTTPClientTransport } = await import("@modelcontextprotocol/client");
    const client = new Client({ name: "serviteur-staging-readonly-check", version: "0.1.0" });
    const transport = new StreamableHTTPClientTransport(config.endpoint, {
      fetch: sameOriginAuthorizedFetch(config.endpoint, config.token, fetch),
    });
    try {
      await client.connect(transport);
      await verifyStagingReadOnly(client, config, (stage) => {
        process.stdout.write("PASS staging " + stage + " (no private data emitted)\n");
      });
      process.stdout.write("PASS staging read-only acceptance (NO Chat send, NO writes)\n");
    } finally {
      await client.close();
    }
  } catch (error) {
    // Never echo a remote exception or token-bearing URL to CI or shell logs.
    const stage = error instanceof StagingAcceptanceError ? error.stage : "transport";
    process.stderr.write("FAIL staging " + stage + " (details withheld)\n");
    process.exitCode = 1;
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)
  await main();
