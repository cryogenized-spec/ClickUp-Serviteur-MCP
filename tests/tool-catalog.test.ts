import { OPERATIONAL_CATALOG_NAMES } from "../src/clickup/catalog-runtime.js";
import { describe, expect, it, vi } from "vitest";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createProtocolHandler } from "../src/mcp/handler.js";
import {
  CLICKUP_MODEL_TOOL_CATALOG,
  CLICKUP_TOOL_GROUPS,
  catalogPage,
} from "../src/mcp/tool-catalog.js";

async function clientHarness(schemaPreview: boolean, fetcher: typeof fetch) {
  const handler = createProtocolHandler({
    bindings: { CLICKUP_SCHEMA_PREVIEW: "true" }, // cannot enable preview on its own
    schemaPreview,
    fetcher,
  });
  const client = new Client({ name: "catalog-schema-test", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(new URL("http://local.test/mcp"), {
    fetch: async (input, init) =>
      handler.fetch(new Request(input, init), {
        authInfo: {
          token: "synthetic",
          clientId: "catalog-test",
          scopes: ["mcp:read"],
          extra: { subject: "github:11" },
        },
      }),
  });
  await client.connect(transport);
  return { client, handler };
}

describe("Official ClickUp MCP capability catalogue (model-facing only)", () => {
  it("contains the hosted capabilities and custom Serviteur tools", () => {
    expect(CLICKUP_MODEL_TOOL_CATALOG).toHaveLength(87);
    expect(new Set(CLICKUP_MODEL_TOOL_CATALOG.map((tool) => tool.name)).size).toBe(87);
    expect(new Set(CLICKUP_MODEL_TOOL_CATALOG.map((tool) => tool.group))).toEqual(
      new Set(CLICKUP_TOOL_GROUPS),
    );
    for (const spec of CLICKUP_MODEL_TOOL_CATALOG) {
      expect(spec.name).toMatch(/^clickup_[a-z_]+$/);
      expect(spec.title.trim().length).toBeGreaterThan(2);
      expect(spec.purpose.trim().length).toBeGreaterThan(40);
      expect(spec.example.trim().length).toBeGreaterThan(10);
      expect(spec.status).toBe("schema_only");
      expect(spec.inputSchema.type).toBe("object");
      expect(spec.inputSchema.additionalProperties).toBe(false);
      expect(new Set(spec.inputSchema.required).size).toBe(spec.inputSchema.required.length);
      for (const required of spec.inputSchema.required) {
        expect(Object.keys(spec.inputSchema.properties)).toContain(required);
      }
      for (const field of Object.values(spec.inputSchema.properties)) {
        expect(field.description.trim().length).toBeGreaterThan(10);
        if (field.type === "array") expect(field.maxItems).toBeGreaterThan(0);
        if (field.type === "object") expect(field.additionalProperties).toBe(false);
      }
    }
  });

  it("returns bounded catalogue pages and complete JSON schemas by category", () => {
    const first = catalogPage({ group: "tasks", maxResults: 2, includeSchema: true });
    expect(first.count).toBe(9);
    expect(first.entries).toHaveLength(2);
    expect(first.has_more).toBe(true);
    expect(first.entries[0]).toMatchObject({
      name: "clickup_get_list_custom_fields",
      effect: "read",
      status: "schema_only",
      inputSchema: { type: "object", additionalProperties: false },
    });
    expect(catalogPage({ group: "tasks", page: 2, maxResults: 2 }).entries).toHaveLength(2);
    expect(() => catalogPage({ maxResults: 99 })).toThrow();
    expect(() => catalogPage({ page: -1 })).toThrow();
  });

  it("advertises only actually implemented tools by default even if a malicious env requests preview", async () => {
    const outbound = vi.fn(async () => Response.json({ tasks: [] }));
    const { client, handler } = await clientHarness(false, outbound as typeof fetch);
    try {
      const tools = (await client.listTools()).tools;
      expect(tools.map((tool) => tool.name).sort()).toEqual(
        [
          ...[
            "clickup_tool_catalog",
            "connect_clickup_account",
            "clickup_set_workspace_access",
            "clickup_preview_target",
            "clickup_select_target",
            "clickup_attach_chatgpt_file_to_task",
            "create_scoped_task",
            "disconnect_clickup_account",
            "find_scoped_tasks",
            "get_attention_report",
            "get_clickup_connection_status",
            "get_scoped_list",
            "get_scoped_task",
            "service_info",
          ],
          ...OPERATIONAL_CATALOG_NAMES,
        ].sort(),
      );
      const answer = await client.callTool({
        name: "clickup_tool_catalog",
        arguments: { group: "relationships", include_schema: true },
      });
      expect(answer.isError).not.toBe(true);
      expect(answer.structuredContent).toMatchObject({ status: "mixed", count: 4 });
      expect(JSON.stringify(answer.structuredContent)).toContain('"status":"operational"');
      expect(JSON.stringify(answer.structuredContent)).toContain("clickup_add_task_link");
      expect(outbound).not.toHaveBeenCalled();
    } finally {
      await client.close();
      await handler.close();
    }
  });

  it("registers all 51 exact schemas through official SDK only in isolated explicit preview", async () => {
    const outbound = vi.fn(async () => Response.json({ tasks: [] }));
    const { client, handler } = await clientHarness(true, outbound as typeof fetch);
    try {
      const tools = (await client.listTools()).tools;
      const preview = tools.filter(
        (tool) =>
          tool.name.startsWith("clickup_") &&
          tool.name !== "clickup_tool_catalog" &&
          tool.name !== "clickup_set_workspace_access" &&
          tool.name !== "clickup_preview_target" &&
          tool.name !== "clickup_select_target",
      );
      expect(preview).toHaveLength(87);
      for (const spec of CLICKUP_MODEL_TOOL_CATALOG) {
        const tool = preview.find((value) => value.name === spec.name);
        expect(tool).toBeDefined();
        expect(tool?.description).toContain("SCHEMA-ONLY, NOT OPERATIONAL");
        expect(tool?.description).toContain(spec.purpose);
        expect(tool?.inputSchema).toMatchObject({
          type: "object",
          additionalProperties: false,
          required: spec.inputSchema.required,
        });
        expect(tool?.annotations?.readOnlyHint).toBe(spec.effect === "read");
        expect(tool?.annotations?.destructiveHint).toBe(spec.effect === "destructive");
      }
      const mutation = await client.callTool({
        name: "clickup_create_task",
        arguments: { list_id: "12345", new_task: { name: "synthetic example" } },
      });
      expect(mutation.isError).toBe(true);
      expect(JSON.stringify(mutation.content)).toContain("CLICKUP_SCHEMA_ONLY");
      const deletion = await client.callTool({
        name: "clickup_delete_task",
        arguments: { task_id: "taskABC" },
      });
      expect(deletion.isError).toBe(true);
      expect(JSON.stringify(deletion.content)).toContain("CLICKUP_SCHEMA_ONLY");
      const missing = await client.callTool({
        name: "clickup_create_task",
        arguments: { list_id: "12345" },
      });
      expect(missing.isError).toBe(true);
      expect(outbound).not.toHaveBeenCalled();
    } finally {
      await client.close();
      await handler.close();
    }
  });
});
