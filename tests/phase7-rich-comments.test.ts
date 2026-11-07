import { describe, expect, it, vi } from "vitest";
import {
  compileClickUpRichSegments,
  compareRichCommentReadback,
} from "../src/clickup/comment-rich.js";
import { runCatalogOperation } from "../src/clickup/catalog-runtime.js";
import type { ReadGrant } from "../src/clickup/policy.js";
import { CLICKUP_MODEL_TOOL_CATALOG } from "../src/mcp/tool-catalog.js";

const eligible = new Set(["707", "808"]);
const grant: ReadGrant = {
  subject: "github:rich-qa",
  clickupUserId: "707",
  workspaceId: "555",
  listId: "12345",
  resourceScope: "workspace",
  apiToken: "synthetic-test-only",
  quota: {
    idFromName: (name: string) => name,
    get: () => ({ fetch: async () => Response.json({ allowed: true }) }),
  },
};

function mockApi(withoutTagId = false, readbackOverride?: Record<string, unknown>[]) {
  let posted: Record<string, unknown> | null = null;
  const calls: Array<{ method: string; path: string; body: Record<string, unknown> | null }> = [];
  const fetcher = vi.fn(async (req: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(req)).pathname;
    const method = init?.method ?? "GET";
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    calls.push({ method, path, body });
    if (path === "/api/v2/task/abc123" && method === "GET")
      return Response.json({ id: "abc123", list: { id: "12345" } });
    if (path === "/api/v2/list/12345") return Response.json({ id: "12345", space: { id: "777" } });
    if (path === "/api/v2/team/555/space") return Response.json({ spaces: [{ id: "777" }] });
    if (path === "/api/v2/team")
      return Response.json({
        teams: [
          {
            id: "555",
            members: [{ user: { id: 707 } }, { user: { id: 808 } }],
          },
        ],
      });
    if (path === "/api/v2/task/abc123/comment" && method === "POST") {
      posted = body;
      return Response.json({ id: "123456" });
    }
    if (path === "/api/v2/task/abc123/comment" && method === "GET") {
      const sent = (readbackOverride ?? posted?.["comment"] ?? []) as Record<string, unknown>[];
      return Response.json({
        comments: [
          {
            id: "123456",
            user: { id: 707 },
            comment: sent.map((segment) => {
              if (withoutTagId && segment["type"] === "tag") return { type: "tag" };
              return segment;
            }),
          },
        ],
      });
    }
    throw new Error("Unexpected synthetic route: " + method + " " + path);
  });
  return { fetcher, calls };
}

describe("complete documented ClickUp comment rich text", () => {
  it("compiles all documented inline, list, code, emoji and mention shapes", () => {
    const result = compileClickUpRichSegments(
      [
        { text: "Important", bold: true, italic: true, link: "https://clickup.com/" },
        { text: " `code`", code: true },
        { text: "\n", list_type: "bullet" },
        { text: "\n", list_type: "ordered", indent: 1 },
        { text: "\n", list_type: "checked" },
        { text: "\n", list_type: "unchecked" },
        { text: "\n", list_type: "toggled" },
        { text: "\n", list_type: "none", indent: 1 },
        { text: "const a = 1;" },
        { text: "\n", code_block_language: "javascript" },
        { emoji_code: "1f60a" },
        { mention_user_id: "808" },
        { divider: true },
      ],
      eligible,
    );
    expect(result.segments).toContainEqual({
      text: "Important",
      attributes: { bold: true, italic: true, link: "https://clickup.com/" },
    });
    expect(result.segments).toContainEqual({
      text: "\n",
      attributes: { list: { list: "checked" } },
    });
    expect(result.segments).toContainEqual({
      text: "\n",
      attributes: { "code-block": { "code-block": "javascript" } },
    });
    expect(result.segments).toContainEqual({
      text: "U0001F60A",
      type: "emoticon",
      emoticon: { code: "1f60a" },
    });
    expect(result.segments).toContainEqual({ type: "tag", user: { id: 808 } });
    expect(result.mentions).toEqual(["808"]);
    expect(result.dividerFallback).toBe(true);
    expect(result.segments.at(-1)).toEqual({
      text: "\n────────────────────────\n",
    });
    expect(compareRichCommentReadback(result.segments, result.segments)).toEqual({
      match: true,
      mentionIdentityVerified: true,
    });
  });

  it("rejects unknown attributes, scripts, foreign people, invalid lists and ambiguous variants", () => {
    for (const part of [
      { text: "a", unsupported: true },
      { text: "a", link: "javascript:alert(1)" },
      { text: "a", list_type: "bullet" },
      { text: "\n", list_type: "imaginary" },
      { text: "\n", bold: true, list_type: "bullet" },
      { text: "\n", code_block_language: "../../path" },
      { text: "ok", mention_user_id: "808" },
      { divider: false },
      { emoji_code: "110000" },
      { mention_user_id: "909" },
      { text: "" },
    ]) {
      expect(() => compileClickUpRichSegments([part], eligible)).toThrow(
        /CLICKUP_(INVALID_ARGUMENT|SCOPE_OR_SCHEMA_REJECTED)/,
      );
    }
  });

  it("does not claim to verify mention identity if ClickUp omits it on readback", () => {
    const expected = [{ text: "Hello " }, { type: "tag", user: { id: 808 } }];
    expect(compareRichCommentReadback(expected, [{ text: "Hello " }, { type: "tag" }])).toEqual({
      match: true,
      mentionIdentityVerified: false,
    });
    expect(
      compareRichCommentReadback(expected, [
        { text: "Hello " },
        { type: "tag", user: { id: 999 } },
      ]),
    ).toMatchObject({
      match: false,
    });
  });

  it("posts formatted segments without any mandatory mention and verifies native readback", async () => {
    const api = mockApi();
    const output = await runCatalogOperation(
      "clickup_create_task_comment",
      {
        task_id: "abc123",
        rich_segments: [
          { text: "Priority", bold: true },
          { text: "\n", list_type: "bullet" },
          { text: "Review" },
          { divider: true },
        ],
      },
      grant,
      api.fetcher as typeof fetch,
    );
    const writes = api.calls.filter((call) => call.method === "POST");
    expect(writes).toHaveLength(1);
    expect(writes[0]?.body).toMatchObject({
      notify_all: false,
      comment: [
        { text: "Priority", attributes: { bold: true } },
        { text: "\n", attributes: { list: { list: "bullet" } } },
        { text: "Review" },
        { text: "\n────────────────────────\n" },
      ],
    });
    expect(output).toMatchObject({
      native_rich_structure_verified_by_readback: true,
      verified_by_readback: true,
      divider_fallback: "unicode_text",
      native_divider: false,
    });
    expect(api.calls.some((call) => call.path === "/api/v2/team")).toBe(false);
  });

  it("verifies genuine member identity separately, with no blind retry or fake mention", async () => {
    const api = mockApi(true);
    const output = await runCatalogOperation(
      "clickup_create_task_comment",
      {
        task_id: "abc123",
        rich_segments: [
          { text: "**Styled without Markdown**", bold: true },
          { mention_user_id: "808" },
          { emoji_code: "1f60a" },
        ],
      },
      grant,
      api.fetcher as typeof fetch,
    );
    expect(api.calls.filter((call) => call.method === "POST")).toHaveLength(1);
    expect(api.calls.some((call) => call.path === "/api/v2/team")).toBe(true);
    expect(output).toMatchObject({
      requested_mention_user_ids: ["808"],
      verified_tag_structure_by_readback: true,
      mention_identity_verified_by_readback: false,
      verified_by_readback: false,
      readback_status: "structure_only",
    });
    const posts = api.calls.filter((call) => call.method === "POST");
    expect(posts[0]?.body?.["comment"]).toContainEqual({
      type: "tag",
      user: { id: 808 },
    });
  });

  it("preserves 60 native formatted spans on readback, and discloses overflow after 100", async () => {
    const spans = Array.from({ length: 60 }, (_, i) => ({
      text: "Formatted span " + i,
      bold: i % 2 === 0,
    }));
    const api = mockApi();
    await runCatalogOperation(
      "clickup_create_task_comment",
      { task_id: "abc123", rich_segments: spans },
      grant,
      api.fetcher as typeof fetch,
    );
    const stored = await runCatalogOperation(
      "clickup_get_task_comments",
      { task_id: "abc123", max_results: 5 },
      grant,
      api.fetcher as typeof fetch,
    );
    const comments = stored["comments"] as Array<Record<string, unknown>>;
    expect((comments[0]?.["comment"] as unknown[]).length).toBe(60);
    expect(stored["incomplete"]).toBe(false);

    const upstream = mockApi(
      false,
      Array.from({ length: 101 }, (_, i) => ({ text: "Part " + i })),
    );
    const limited = await runCatalogOperation(
      "clickup_get_task_comments",
      { task_id: "abc123", max_results: 5 },
      grant,
      upstream.fetcher as typeof fetch,
    );
    const first = (limited["comments"] as Array<Record<string, unknown>>)[0]!;
    expect((first["comment"] as unknown[]).length).toBe(100);
    expect(limited["incomplete"]).toBe(true);
  });

  it("rejects mixing modes before posting and advertises the native schema", async () => {
    const input = CLICKUP_MODEL_TOOL_CATALOG.find(
      (tool) => tool.name === "clickup_create_task_comment",
    )?.inputSchema;
    expect(input?.properties["rich_segments"]?.items?.properties?.["list_type"]?.enum).toContain(
      "checked",
    );
    const api = mockApi();
    await expect(
      runCatalogOperation(
        "clickup_create_task_comment",
        {
          task_id: "abc123",
          text: "Legacy",
          rich_segments: [{ text: "Native" }],
        },
        grant,
        api.fetcher as typeof fetch,
      ),
    ).rejects.toThrow("CLICKUP_INVALID_ARGUMENT");
    expect(api.calls.filter((call) => call.method === "POST")).toHaveLength(0);
  });
});
