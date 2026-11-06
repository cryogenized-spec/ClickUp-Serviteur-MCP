import { describe, expect, it, vi } from "vitest";
import { runCatalogOperation } from "../src/clickup/catalog-runtime.js";
import { CLICKUP_MODEL_TOOL_CATALOG } from "../src/mcp/tool-catalog.js";
import type { ReadGrant } from "../src/clickup/policy.js";

const grant = (): ReadGrant => ({
  subject: "github:qa",
  clickupUserId: "707",
  workspaceId: "555",
  listId: "12345",
  resourceScope: "workspace",
  apiToken: "synthetic-only",
  quota: {
    idFromName: (name: string) => name,
    get: () => ({ fetch: async () => Response.json({ allowed: true }) }),
  },
});
const segments = [
  { text: "Hi 👋\nPlease check https://example.invalid/qa with " },
  { mention_user_id: "801" },
  { text: ", then send to " },
  { mention_user_id: "802" },
  { text: ". Thank you!\n" },
];
const expected = [
  { text: "Hi 👋\nPlease check https://example.invalid/qa with " },
  { type: "tag", user: { id: 801 } },
  { text: ", then send to " },
  { type: "tag", user: { id: 802 } },
  { text: ". Thank you!\n" },
];

function mockApi(options: { author?: number; dropTag?: boolean; postStatus?: number } = {}) {
  let created = false;
  let postCount = 0;
  const fetcher = vi.fn(async (request: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(request)).pathname;
    if (path === "/api/v2/task/abc123") return Response.json({ id: "abc123", list: { id: "12345" } });
    if (path === "/api/v2/list/12345") return Response.json({ id: "12345", space: { id: "777" } });
    if (path === "/api/v2/team/555/space") return Response.json({ spaces: [{ id: "777" }] });
    if (path === "/api/v2/team")
      return Response.json({
        teams: [
          {
            id: "555",
            members: [
              { user: { id: 707, username: "QA Owner" } },
              { user: { id: 801, username: "QA Member A" } },
              { user: { id: 802, username: "QA Member B" } },
            ],
          },
        ],
      });
    if (path === "/api/v2/task/abc123/comment") {
      if (init?.method === "POST") {
        postCount++;
        const body = JSON.parse(String(init.body));
        if (body.notify_all !== false) throw Error("notify_all must never be enabled implicitly");
        if (body.comment && !created) {
          expect(body.comment).toEqual(expected);
          expect(body.comment_text).toBeUndefined();
        }
        if (options.postStatus) return Response.json({ err: "failure" }, { status: options.postStatus });
        created = true;
        return Response.json({ id: "456" });
      }
      return Response.json({
        comments: created
          ? [
              {
                id: "456",
                user: { id: options.author ?? 707 },
                assignee: null,
                comment: options.dropTag ? expected.slice(0, 3) : expected,
              },
            ]
          : [],
      });
    }
    throw Error("Unexpected request " + path);
  });
  return {
    fetcher,
    get postCount() {
      return postCount;
    },
  };
}

describe("genuine ClickUp task comment @mentions (#88)", () => {
  it("advertises a bounded model-facing ordered segment schema", () => {
    const tool = CLICKUP_MODEL_TOOL_CATALOG.find(
      (entry) => entry.name === "clickup_create_task_comment",
    );
    expect(tool?.inputSchema.properties["mention_segments"]).toMatchObject({
      type: "array",
      maxItems: 20,
    });
    expect(tool?.inputSchema.required).toEqual(["task_id"]);
    expect(tool?.inputSchema.properties["text"]?.type).toBe("string");
    expect(
      CLICKUP_MODEL_TOOL_CATALOG.find(
        (entry) => entry.name === "clickup_edit_task_comment",
      )?.inputSchema.properties["mention_segments"],
    ).toBeUndefined();
  });

  it("posts two real tag segments and verifies every tag/text segment by readback", async () => {
    const api = mockApi();
    const result = await runCatalogOperation(
      "clickup_create_task_comment",
      { task_id: "abc123", mention_segments: segments },
      grant(),
      api.fetcher as typeof fetch,
    );
    expect(result).toMatchObject({
      id: "456",
      genuine_mentions: ["801", "802"],
      verified_by_readback: true,
      notification_delivery_unverified: true,
    });
    expect(api.postCount).toBe(1);
  });

  it("preserves legacy plain-text behavior without rich body", async () => {
    const api = mockApi();
    const result = await runCatalogOperation(
      "clickup_create_task_comment",
      { task_id: "abc123", text: "Original plain text" },
      grant(),
      api.fetcher as typeof fetch,
    );
    expect(result).toMatchObject({ id: "456" });
    const post = api.fetcher.mock.calls.find(([, init]) => init?.method === "POST");
    const body = JSON.parse(String(post?.[1]?.body));
    expect(body).toEqual({ comment_text: "Original plain text", notify_all: false });
  });

  it.each([
    [{ task_id: "abc123", mention_segments: segments, text: "duplicated" }],
    [{ task_id: "abc123", mention_segments: segments, parent_comment_id: "parent" }],
    [{ task_id: "abc123", mention_segments: [{ text: "No real tag" }] }],
    [{ task_id: "abc123", mention_segments: [{ text: "" }, { mention_user_id: "801" }] }],
    [{ task_id: "abc123", mention_segments: [{ mention_user_id: "801", text: "spoof" }] }],
    [{ task_id: "abc123", mention_segments: [{ mention_user_id: "801", extra: true }] }],
    [{ task_id: "abc123", mention_segments: [{ mention_user_id: "bogus" }] }],
    [{ task_id: "abc123", mention_segments: [{ mention_user_id: "803" }] }],
    [{ task_id: "abc123", mention_segments: Array(21).fill({ mention_user_id: "801" }) }],
    [
      {
        task_id: "abc123",
        mention_segments: [{ mention_user_id: "801" }, { text: "x".repeat(6001) }],
      },
    ],
  ])("rejects invalid/unverified rich requests without posting", async (args) => {
    const api = mockApi();
    await expect(
      runCatalogOperation(
        "clickup_create_task_comment",
        args,
        grant(),
        api.fetcher as typeof fetch,
      ),
    ).rejects.toThrow(/CLICKUP_(INVALID_ARGUMENT|SCOPE_OR_SCHEMA_REJECTED)/);
    expect(api.postCount).toBe(0);
  });

  it.each([{ author: 808 }, { dropTag: true }])(
    "does not certify a missing/foreign-owned tag in readback and never retries",
    async (options) => {
      const api = mockApi(options);
      await expect(
        runCatalogOperation(
          "clickup_create_task_comment",
          { task_id: "abc123", mention_segments: segments },
          grant(),
          api.fetcher as typeof fetch,
        ),
      ).rejects.toThrow("CLICKUP_WRITE_OUTCOME_UNKNOWN");
      expect(api.postCount).toBe(1);
    },
  );

  it("does not repost a rejected rich comment", async () => {
    const api = mockApi({ postStatus: 400 });
    await expect(
      runCatalogOperation(
        "clickup_create_task_comment",
        { task_id: "abc123", mention_segments: segments },
        grant(),
        api.fetcher as typeof fetch,
      ),
    ).rejects.toThrow("CLICKUP_UPSTREAM_UNAVAILABLE");
    expect(api.postCount).toBe(1);
  });
});
