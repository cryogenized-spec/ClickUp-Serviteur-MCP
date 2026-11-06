import { describe, expect, it, vi } from "vitest";
import { runCatalogOperation } from "../src/clickup/catalog-runtime.js";
import { extractVerifiedTaskPdf } from "../src/clickup/pdf-reader.js";
import type { ReadGrant } from "../src/clickup/policy.js";

const fileBase64 =
  "JVBERi0xLjMKJZOMi54gUmVwb3J0TGFiIEdlbmVyYXRlZCBQREYgZG9jdW1lbnQgKG9wZW5zb3VyY2UpCjEgMCBvYmoKPDwKL0YxIDIgMCBSCj4+CmVuZG9iagoyIDAgb2JqCjw8Ci9CYXNlRm9udCAvSGVsdmV0aWNhIC9FbmNvZGluZyAvV2luQW5zaUVuY29kaW5nIC9OYW1lIC9GMSAvU3VidHlwZSAvVHlwZTEgL1R5cGUgL0ZvbnQKPj4KZW5kb2JqCjMgMCBvYmoKPDwKL0NvbnRlbnRzIDcgMCBSIC9NZWRpYUJveCBbIDAgMCAyODAgMjgwIF0gL1BhcmVudCA2IDAgUiAvUmVzb3VyY2VzIDw8Ci9Gb250IDEgMCBSIC9Qcm9jU2V0IFsgL1BERiAvVGV4dCAvSW1hZ2VCIC9JbWFnZUMgL0ltYWdlSSBdCj4+IC9Sb3RhdGUgMCAvVHJhbnMgPDwKCj4+IAogIC9UeXBlIC9QYWdlCj4+CmVuZG9iago0IDAgb2JqCjw8Ci9QYWdlTW9kZSAvVXNlTm9uZSAvUGFnZXMgNiAwIFIgL1R5cGUgL0NhdGFsb2cKPj4KZW5kb2JqCjUgMCBvYmoKPDwKL0F1dGhvciAoYW5vbnltb3VzKSAvQ3JlYXRpb25EYXRlIChEOjIwMjYxMTA2MTc0MzI3KzAwJzAwJykgL0NyZWF0b3IgKGFub255bW91cykgL0tleXdvcmRzICgpIC9Nb2REYXRlIChEOjIwMjYxMTA2MTc0MzI3KzAwJzAwJykgL1Byb2R1Y2VyIChSZXBvcnRMYWIgUERGIExpYnJhcnkgLSBcKG9wZW5zb3VyY2VcKSkgCiAgL1N1YmplY3QgKHVuc3BlY2lmaWVkKSAvVGl0bGUgKHVudGl0bGVkKSAvVHJhcHBlZCAvRmFsc2UKPj4KZW5kb2JqCjYgMCBvYmoKPDwKL0NvdW50IDEgL0tpZHMgWyAzIDAgUiBdIC9UeXBlIC9QYWdlcwo+PgplbmRvYmoKNyAwIG9iago8PAovTGVuZ3RoIDEyNQo+PgpzdHJlYW0KMSAwIDAgMSAwIDAgY20gIEJUIC9GMSAxMiBUZiAxNC40IFRMIEVUCkJUIC9GMSAxMSBUZiAxMy4yIFRMIEVUCkJUIDEgMCAwIDEgMjAgMTgwIFRtIChRQSBTUjEyNTAgY2Ftb3VmbGFnZSBzdG9jaykgVGogVCogRVQKIAplbmRzdHJlYW0KZW5kb2JqCnhyZWYKMCA4CjAwMDAwMDAwMDAgNjU1MzUgZiAKMDAwMDAwMDA2MSAwMDAwMCBuIAowMDAwMDAwMDkyIDAwMDAwIG4gCjAwMDAwMDAxOTkgMDAwMDAgbiAKMDAwMDAwMDM5MiAwMDAwMCBuIAowMDAwMDA0NjAgMDAwMDAgbiAKMDAwMDAwNzIxIDAwMDAwIG4gCjAwMDAwMDA3ODAgMDAwMDAgbiAKdHJhaWxlcgo8PAovSUQgCls8OTAxM2VlNWU3MDIwYjhhZWU1NTk5ZjYyYTY1MGUxMGU+PDkwMTNlZTVlNzAyMGI4YWVlNTU5OWY2MmE2NTBlMTBlPl0KJSBSZXBvcnRMYWIgZ2VuZXJhdGVkIFBERiBkb2N1bWVudCAtLSBkaWdlc3QgKG9wZW5zb3VyY2UpCgovSW5mbyA1IDAgUgovUm9vdCA0IDAgUgovU2l6ZSA4Cj4+CnN0YXJ0eHJlZgo5NTUKJSVFT0YK";
const pdfBytes = Uint8Array.from(atob(fileBase64), (c) => c.charCodeAt(0));
const url = "https://t555.p.clickup-attachments.com/example.pdf?signature=synthetic-only";
const attachment = () => ({
  id: "attachment_qa1",
  title: "QA generated test.pdf",
  extension: "pdf",
  mimetype: "application/pdf",
  size: pdfBytes.byteLength,
  url,
});
const grant = (list = "12345"): ReadGrant => ({
  subject: "github:qa",
  clickupUserId: "707",
  workspaceId: "555",
  listId: list,
  resourceScope: "list",
  companyListTaskAccess: true,
  apiToken: "synthetic-only",
  quota: {
    idFromName: (name: string) => name,
    get: () => ({ fetch: async () => Response.json({ allowed: true }) }),
  },
});

function mockFetch(options: { foreign?: boolean; redirect?: boolean; tooLarge?: boolean } = {}) {
  let cdnGets = 0;
  let cancelled = false;
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const target = new URL(String(input));
    const path = target.pathname;
    if (target.hostname.endsWith(".p.clickup-attachments.com")) {
      cdnGets++;
      expect(init?.method).toBe("GET");
      expect(init?.redirect).toBe("manual");
      expect(JSON.stringify(init?.headers)).not.toContain("synthetic-only");
      if (options.redirect)
        return new Response(null, { status: 302, headers: { Location: "http://localhost/" } });
      if (options.tooLarge) {
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array(3 * 1024 * 1024 + 1));
            },
            cancel() {
              cancelled = true;
            },
          }),
          { status: 200, headers: { "content-type": "application/pdf" } },
        );
      }
      const bytes = new Uint8Array(pdfBytes.byteLength);
      bytes.set(pdfBytes);
      return new Response(bytes, { status: 200, headers: { "content-type": "application/pdf" } });
    }
    if (path === "/api/v2/task/abc123")
      return Response.json({
        id: "abc123",
        list: { id: options.foreign ? "12346" : "12345" },
        attachments: [attachment()],
      });
    if (path === "/api/v2/list/12345")
      return Response.json({ id: "12345", space: { id: "777" } });
    if (path === "/api/v2/team/555/space")
      return Response.json({ spaces: [{ id: "777" }] });
    throw Error("Unexpected API route " + path);
  });
  return { fetcher, get cdnGets() { return cdnGets; }, get cancelled() { return cancelled; } };
}

describe("read-only ClickUp PDF repair-card extraction (#85)", () => {
  it("extracts text from a synthetic PDF on a verified task and omits signed links", async () => {
    const api = mockFetch();
    const output = await runCatalogOperation(
      "clickup_read_task_pdf",
      { task_id: "abc123", attachment_id: "attachment_qa1" },
      grant(),
      api.fetcher as typeof fetch,
    );
    expect(output).toMatchObject({
      attachment_id: "attachment_qa1",
      total_pages: 1,
      text_layer_only: true,
    });
    expect(JSON.stringify(output)).toContain("SR1250");
    expect(JSON.stringify(output)).not.toContain("signature=synthetic-only");
    expect(api.cdnGets).toBe(1);
  });

  it("rejects a foreign List before any CDN request", async () => {
    const api = mockFetch({ foreign: true });
    await expect(
      runCatalogOperation(
        "clickup_read_task_pdf",
        { task_id: "abc123", attachment_id: "attachment_qa1" },
        grant(),
        api.fetcher as typeof fetch,
      ),
    ).rejects.toThrow("CLICKUP_SCOPE_OR_SCHEMA_REJECTED");
    expect(api.cdnGets).toBe(0);
  });

  it("rejects an attachment not on the task before CDN request", async () => {
    const api = mockFetch();
    await expect(
      runCatalogOperation(
        "clickup_read_task_pdf",
        { task_id: "abc123", attachment_id: "other-attachment" },
        grant(),
        api.fetcher as typeof fetch,
      ),
    ).rejects.toThrow("CLICKUP_SCOPE_OR_SCHEMA_REJECTED");
    expect(api.cdnGets).toBe(0);
  });

  it("rejects foreign-host and lookalike signed URLs", async () => {
    for (const source of ["https://127.0.0.1/", "https://t555.p.clickup-attachments.com.evil.test/f"]) {
      const api = mockFetch();
      await expect(
        extractVerifiedTaskPdf({ ...attachment(), url: source }, api.fetcher as typeof fetch),
      ).rejects.toThrow("CLICKUP_PDF_HOST_NOT_ALLOWED");
      expect(api.cdnGets).toBe(0);
    }
  });

  it("refuses redirects to local networks and oversized chunked PDF data", async () => {
    const redirect = mockFetch({ redirect: true });
    await expect(
      extractVerifiedTaskPdf(attachment(), redirect.fetcher as typeof fetch),
    ).rejects.toThrow("CLICKUP_PDF_REDIRECT_BLOCKED");
    expect(redirect.cdnGets).toBe(1);
    const large = mockFetch({ tooLarge: true });
    await expect(
      extractVerifiedTaskPdf(attachment(), large.fetcher as typeof fetch),
    ).rejects.toThrow("CLICKUP_PDF_TOO_LARGE");
    expect(large.cancelled).toBe(true);
  });

  it("rejects oversized task attachment metadata without fetching", async () => {
    const api = mockFetch();
    await expect(
      extractVerifiedTaskPdf(
        { ...attachment(), size: 3 * 1024 * 1024 + 1 },
        api.fetcher as typeof fetch,
      ),
    ).rejects.toThrow("CLICKUP_PDF_TOO_LARGE");
    expect(api.cdnGets).toBe(0);
  });
});
