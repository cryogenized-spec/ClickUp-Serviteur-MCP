import { describe, expect, it } from "vitest";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { createServer } from "../src/mcp/create-server.js";

describe("ChatGPT file-aware MCP tool discovery", () => {
  it("advertises a native file slot and hides destructive company operations", async () => {
    const handler = createMcpHandler(() =>
      createServer({
        bindings: {
          CLICKUP_COMPANY_PROFILE: "true",
          CLICKUP_COMPANY_WRITE_MODE: "non_destructive",
          CLICKUP_RESOURCE_SCOPE: "workspace",
        },
      }),
    );
    const client = new Client({ name: "file-slot-qa", version: "0.1.0" });
    const transport = new StreamableHTTPClientTransport(new URL("http://local.test/mcp"), {
      fetch: async (input, init) => handler.fetch(new Request(input, init)),
    });
    try {
      await client.connect(transport);
      const { tools } = await client.listTools();
      const upload = tools.find((tool) => tool.name === "clickup_attach_chatgpt_file_to_task");
      expect(upload).toBeDefined();
      expect(upload?._meta?.["openai/fileParams"]).toEqual(["file"]);
      expect(upload?.inputSchema.required).toEqual(["task_id", "file"]);
      const file = upload?.inputSchema.properties?.["file"] as
        | { properties?: Record<string, unknown>; required?: string[] }
        | undefined;
      expect(Object.keys(file?.properties ?? {})).toEqual([
        "download_url",
        "file_id",
        "mime_type",
        "file_name",
      ]);
      expect(file?.required).toEqual(["download_url", "file_id"]);
      expect(tools.some((tool) => tool.name === "clickup_delete_task")).toBe(false);
      expect(tools.some((tool) => tool.name === "clickup_attach_file_to_task")).toBe(true);
    } finally {
      await client.close();
      await handler.close();
    }
  });
});
