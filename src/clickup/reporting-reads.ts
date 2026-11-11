import { ReadFailure } from "./policy.js";

/** Read-only reporting projections. The caller supplies an OAuth-bound ClickUp GET
 * adapter and must enforce Workspace/List scope before calling a resource read.
 * No mutation routes, raw path inputs or high-level permissions live here. */
type Json = Record<string, unknown>;
type FetchRead = (path: string) => Promise<Json>;
const record = (value: unknown): Json | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Json)
    : null;

const validId = (value: unknown): value is string =>
  typeof value === "string" && /^[a-zA-Z0-9_-]{1,80}$/.test(value);

function goalBelongsToWorkspace(goal: Json, workspaceId: string): void {
  for (const candidate of [
    goal["team_id"],
    goal["workspace_id"],
    record(goal["team"])?.["id"],
    record(goal["workspace"])?.["id"],
  ]) {
    if (candidate !== undefined && candidate !== null && String(candidate) !== workspaceId)
      throw new ReadFailure("CLICKUP_SCOPE_OR_SCHEMA_REJECTED");
  }
}

function verifiedWorkspaceGoals(response: Json, workspaceId: string): Json[] {
  if (!Array.isArray(response["goals"]) || response["goals"].length > 1000)
    throw new ReadFailure("CLICKUP_BAD_RESPONSE");
  const ids = new Set<string>();
  return response["goals"].map((value: unknown) => {
    const goal = record(value);
    if (!goal || !validId(goal["id"]) || ids.has(goal["id"]))
      throw new ReadFailure("CLICKUP_BAD_RESPONSE");
    ids.add(goal["id"]);
    goalBelongsToWorkspace(goal, workspaceId);
    return goal;
  });
}

/** The v2 Get Goals endpoint does not document remote pagination. The offset
 * is intentionally local to this single response, not an invented API cursor. */
export async function readWorkspaceGoals(
  workspaceId: string,
  includeCompleted: boolean,
  offset: number,
  maxResults: number,
  get: FetchRead,
): Promise<Json> {
  const result = await get(
    "api/v2/team/" + workspaceId + "/goal?include_completed=" + String(includeCompleted),
  );
  const goals = verifiedWorkspaceGoals(result, workspaceId);
  const visible = goals.slice(offset, offset + maxResults);
  const nextOffset = offset + visible.length < goals.length ? offset + visible.length : null;
  return {
    source: "clickup-api-v2",
    workspace_id: workspaceId,
    include_completed: includeCompleted,
    goals: visible,
    goals_in_response: goals.length,
    goal_offset: offset,
    next_goal_offset: nextOffset,
    incomplete: nextOffset !== null,
    local_offset_only: true,
  };
}

/** A bare UUID is not authority for a detail read. Fetch the authenticated
 * Workspace's Goals first and prove exact membership before using /goal/{id}. */
export async function readGoalDetails(
  workspaceId: string,
  goalId: string,
  maxResults: number,
  get: FetchRead,
): Promise<Json> {
  const listing = await get("api/v2/team/" + workspaceId + "/goal?include_completed=true");
  const goals = verifiedWorkspaceGoals(listing, workspaceId);
  if (!goals.some((goal) => goal["id"] === goalId))
    throw new ReadFailure("CLICKUP_SCOPE_OR_SCHEMA_REJECTED");
  const response = await get("api/v2/goal/" + goalId);
  const goal = record(response["goal"]);
  if (!goal || goal["id"] !== goalId)
    throw new ReadFailure("CLICKUP_SCOPE_OR_SCHEMA_REJECTED");
  goalBelongsToWorkspace(goal, workspaceId);

  const raw = goal["key_results"];
  if (raw !== undefined && raw !== null && !Array.isArray(raw))
    throw new ReadFailure("CLICKUP_BAD_RESPONSE");
  const targets = Array.isArray(raw) ? raw : [];
  if (targets.length > 1000 || targets.some((entry: unknown) => !record(entry)))
    throw new ReadFailure("CLICKUP_BAD_RESPONSE");
  const visible = targets.slice(0, maxResults);

  return {
    source: "clickup-api-v2",
    workspace_id: workspaceId,
    goal_id: goalId,
    goal: { ...goal, key_results: visible },
    targets_in_response: targets.length,
    targets_returned: visible.length,
    targets_available_in_response: Array.isArray(raw),
    incomplete: targets.length > visible.length,
    continuation_unavailable: targets.length > visible.length,
  };
}

/** A sampled List task view, not ClickUp's Sprint Dashboard reporting API.
 * Only home-List tasks are fetched, avoiding cross-List reads in List scope.
 * Task-level fields are projected to a small allowlist. */
export async function readSprintTaskSnapshot(
  listId: string,
  page: number,
  offset: number,
  maxResults: number,
  get: FetchRead,
): Promise<Json> {
  const params = new URLSearchParams({
    page: String(page),
    archived: "false",
    include_closed: "true",
    subtasks: "true",
    include_timl: "false",
  });
  const result = await get("api/v2/list/" + listId + "/task?" + params.toString());
  if (
    !Array.isArray(result["tasks"]) ||
    result["tasks"].length > 100 ||
    (result["last_page"] !== undefined && typeof result["last_page"] !== "boolean")
  )
    throw new ReadFailure("CLICKUP_BAD_RESPONSE");

  const ids = new Set<string>();
  const tasks = result["tasks"].map((value: unknown) => {
    const task = record(value);
    if (!task || !validId(task["id"]) || ids.has(task["id"]))
      throw new ReadFailure("CLICKUP_BAD_RESPONSE");
    ids.add(task["id"]);
    const homeList = record(task["list"])?.["id"];
    if (String(homeList) !== listId)
      throw new ReadFailure("CLICKUP_SCOPE_OR_SCHEMA_REJECTED");
    const status = task["status"] == null ? null : record(task["status"]);
    if (task["status"] != null && !status) throw new ReadFailure("CLICKUP_BAD_RESPONSE");
    const points = task["points"];
    if (
      points !== undefined &&
      points !== null &&
      (typeof points !== "number" || !Number.isFinite(points) || points < 0)
    )
      throw new ReadFailure("CLICKUP_BAD_RESPONSE");
    return {
      id: task["id"],
      name: typeof task["name"] === "string" ? task["name"].slice(0, 180) : null,
      status: typeof status?.["status"] === "string" ? status["status"].slice(0, 80) : null,
      status_type: typeof status?.["type"] === "string" ? status["type"].slice(0, 40) : null,
      points: typeof points === "number" ? points : null,
    };
  });

  const visible = tasks.slice(offset, offset + maxResults);
  const nextLocal = offset + visible.length;
  const pageHasMore = nextLocal < tasks.length;
  const remoteMayHaveMore = tasks.length === 100 || result["last_page"] === false;
  const nextTaskPage = pageHasMore ? page : remoteMayHaveMore ? page + 1 : null;
  const nextTaskOffset = pageHasMore ? nextLocal : remoteMayHaveMore ? 0 : null;
  const completed = visible.filter(
    (task) => task.status_type === "closed" || task.status_type === "done",
  ).length;
  const points = visible.reduce((total, task) => total + (task.points ?? 0), 0);
  return {
    source: "clickup-api-v2",
    list_id: listId,
    official_sprint_report: false,
    list_verified_as_sprint: false,
    home_list_tasks_only: true,
    snapshot_not_velocity_or_burndown: true,
    tasks: visible,
    task_page: page,
    task_offset: offset,
    sampled_tasks: visible.length,
    completed_in_sample: completed,
    points_in_sample: points,
    tasks_without_points_in_sample: visible.filter((task) => task.points === null).length,
    tasks_in_upstream_page: tasks.length,
    next_task_page: nextTaskPage,
    next_task_offset: nextTaskOffset,
    incomplete: page > 0 || offset > 0 || nextTaskPage !== null,
  };
}
