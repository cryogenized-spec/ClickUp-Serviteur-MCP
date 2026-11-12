import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  StagingAcceptanceError,
  sameOriginAuthorizedFetch,
  stagingConfig,
  verifyStagingReadOnly,
} from "../staging-readonly-acceptance.mjs";

const env = (extra = {}) => ({
  STAGING_MCP_URL: "https://clickup-serviteur-staging.example.workers.dev/mcp",
  STAGING_ACCESS_TOKEN: "test-only-fake-bearer-value",
  STAGING_EXPECTED_BUILD_SHA: "a".repeat(40),
  STAGING_EXPECTED_WORKSPACE_ID: "555",
  STAGING_EXPECTED_LIST_ID: "12345",
  ...extra,
});

const valid = () => stagingConfig(env());

const responses = {
  service_info: {
    build_sha: "a".repeat(40),
    liveClickUp: true,
    authentication: "github-oauth-plus-individual-clickup-oauth",
  },
  get_clickup_connection_status: {
    connected: true,
    workspace_id: "555",
    selected_list_id: "12345",
    workspace_exclusive: true,
    workspace_scope_enabled: true,
    workspace_scope_approved: true,
    mcp_read_scope_granted: true,
  },
  clickup_get_workspace_goals: {
    source: "clickup-api-v2",
    workspace_id: "555",
    local_offset_only: true,
    goals: [{ id: "goal-1" }],
  },
  clickup_get_goal_details: {
    source: "clickup-api-v2",
    workspace_id: "555",
    goal_id: "goal-1",
    goal: { id: "goal-1", key_results: [{ id: "target-one" }] },
  },
  clickup_get_sprint_task_snapshot: {
    source: "clickup-api-v2",
    list_id: "12345",
    official_sprint_report: false,
    snapshot_not_velocity_or_burndown: true,
    list_verified_as_sprint: false,
    home_list_tasks_only: true,
    tasks: [{ id: "task-1", status: "open", points: 3 }],
  },
};

const tools = Object.keys(responses).map((name) => ({
  name,
  annotations: { readOnlyHint: true, destructiveHint: false },
}));

function fakeClient({ entries = tools, reply = responses, failName } = {}) {
  const calls = [];
  const client = {
    listTools: async () => ({ tools: entries }),
    callTool: async ({ name, arguments: args }) => {
      calls.push({ name, args });
      if (name === failName) return { isError: true, content: [{ type: "text", text: "private user@example.com" }] };
      assert(Object.hasOwn(reply, name), "Unexpected MCP tool called: " + name);
      return { structuredContent: reply[name] };
    },
  };
  return { client, calls };
}

async function expectStage(client, cfg, stage) {
  await assert.rejects(
    verifyStagingReadOnly(client, cfg),
    (error) => error instanceof StagingAcceptanceError && error.stage === stage,
  );
}

describe("staging readonly acceptance configuration guards", () => {
  it("requires the exact staging Worker naming convention, TLS and MCP path", () => {
    for (const url of [
      "https://clickup-serviteur-company.example.workers.dev/mcp",
      "https://clickup-serviteur-staging.example.workers.dev/auth",
      "http://clickup-serviteur-staging.example.workers.dev/mcp",
      "https://clickup-serviteur-staging.example.workers.dev/mcp?access_token=a",
      "https://clickup-serviteur-staging.example.workers.dev:8443/mcp",
      "https://attacker.example/clickup-serviteur-staging.example.workers.dev/mcp",
      "https://clickup-serviteur-staging.example.workers.dev@attacker.example/mcp",
    ]) {
      assert.throws(
        () => stagingConfig(env({ STAGING_MCP_URL: url })),
        (error) => error instanceof StagingAcceptanceError && error.stage === "configuration",
      );
    }
  });

  it("fails closed without an exact SHA, Workspace/List identity or ephemeral token", () => {
    for (const overrides of [
      { STAGING_ACCESS_TOKEN: "" },
      { STAGING_ACCESS_TOKEN: "bad\nvalue" },
      { STAGING_EXPECTED_BUILD_SHA: "unknown" },
      { STAGING_EXPECTED_WORKSPACE_ID: "not-an-id" },
      { STAGING_EXPECTED_LIST_ID: "" },
      { STAGING_GOAL_ID: "../../escape" },
    ]) {
      assert.throws(() => stagingConfig(env(overrides)), StagingAcceptanceError);
    }
    assert.equal(valid().buildSha, "a".repeat(40));
  });

  it("never forwards the staging bearer token off origin or after a redirect", async () => {
    let observed;
    const fetcher = async (url, init) => {
      observed = { url, init };
      return new Response("", { status: 200 });
    };
    const fetch = sameOriginAuthorizedFetch(valid().endpoint, valid().token, fetcher);
    await assert.rejects(
      fetch("https://clickup-serviteur-company.example.workers.dev/mcp"),
      StagingAcceptanceError,
    );
    await assert.rejects(
      fetch("https://clickup-serviteur-staging.example.workers.dev/github/callback"),
      StagingAcceptanceError,
    );
    assert.equal(observed, undefined);
    await fetch(new Request("https://clickup-serviteur-staging.example.workers.dev/mcp"));
    assert.equal(observed.init.headers.get("Authorization"), "Bearer test-only-fake-bearer-value");
    assert.equal(observed.init.redirect, "manual");
    assert.equal(observed.url.pathname, "/mcp");
  });
});

describe("staging tool checks use only fixed READ operations", () => {
  it("accepts a healthy staging source and records no raw results", async () => {
    const { client, calls } = fakeClient();
    const stages = [];
    const passed = await verifyStagingReadOnly(client, valid(), (stage) => stages.push(stage));
    assert.equal(passed, true);
    assert.deepEqual(stages, ["discovery", "build", "connection", "goals", "sprint_snapshot"]);
    assert.deepEqual(calls.map((call) => call.name), [
      "service_info",
      "get_clickup_connection_status",
      "clickup_get_workspace_goals",
      "clickup_get_sprint_task_snapshot",
    ]);
    assert.deepEqual(calls[2].args, { include_completed: true, max_results: 5 });
    assert.deepEqual(calls[3].args, {
      list_id: "12345", max_results: 5, task_page: 0, task_offset: 0,
    });
    assert(!calls.some((call) => /send|post|create|update|delete|disconnect/.test(call.name)));
  });

  it("optionally checks an explicitly identified Goal only, with no write operations", async () => {
    const { client, calls } = fakeClient();
    await verifyStagingReadOnly(client, stagingConfig(env({ STAGING_GOAL_ID: "goal-1" })));
    assert.deepEqual(calls.map((call) => call.name).slice(-3), [
      "clickup_get_workspace_goals",
      "clickup_get_goal_details",
      "clickup_get_sprint_task_snapshot",
    ]);
    assert.deepEqual(calls.at(-2).args, { goal_id: "goal-1", max_results: 5 });
  });

  it("rejects a missing or mis-annotated tool before calling any upstream tool", async () => {
    const { client, calls } = fakeClient({
      entries: tools.map((tool) =>
        tool.name === "clickup_get_workspace_goals"
          ? { ...tool, annotations: { readOnlyHint: false } }
          : tool,
      ),
    });
    await expectStage(client, valid(), "discovery");
    assert.equal(calls.length, 0);
  });

  it("rejects stale builds and never proceeds to a private Workspace read", async () => {
    const { client, calls } = fakeClient({
      reply: { ...responses, service_info: { ...responses.service_info, build_sha: "b".repeat(40) } },
    });
    await expectStage(client, valid(), "build");
    assert.deepEqual(calls.map((call) => call.name), ["service_info"]);
  });

  it("rejects a foreign Workspace, wrong List or disabled Workspace scope before a Goal read", async () => {
    for (const field of ["workspace_id", "selected_list_id", "workspace_scope_enabled"]) {
      const value = field === "workspace_scope_enabled" ? false : "999";
      const { client, calls } = fakeClient({
        reply: { ...responses, get_clickup_connection_status: {
          ...responses.get_clickup_connection_status, [field]: value,
        } },
      });
      await expectStage(client, valid(), "connection");
      assert.deepEqual(calls.map((call) => call.name), [
        "service_info", "get_clickup_connection_status",
      ]);
    }
  });

  it("rejects an upstream error without showing its private body or continuing", async () => {
    const { client, calls } = fakeClient({ failName: "clickup_get_workspace_goals" });
    await expectStage(client, valid(), "goals");
    assert.deepEqual(calls.map((call) => call.name).at(-1), "clickup_get_workspace_goals");
  });

  it("rejects foreign Goals and inflated sampled Sprint metadata", async () => {
    const wrongGoals = { ...responses.clickup_get_workspace_goals, workspace_id: "999" };
    const wrongSprint = { ...responses.clickup_get_sprint_task_snapshot, official_sprint_report: true };
    for (const [replacement, stage] of [
      [{ ...responses, clickup_get_workspace_goals: wrongGoals }, "goals"],
      [{ ...responses, clickup_get_sprint_task_snapshot: wrongSprint }, "sprint_snapshot"],
    ]) {
      const { client } = fakeClient({ reply: replacement });
      await expectStage(client, valid(), stage);
    }
  });
});
