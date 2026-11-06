import { extractText, getResolvedPDFJS } from "./unpdf-runtime.mjs";
import type { UnpdfLoadingTask } from "./unpdf-runtime.mjs";
import { ReadFailure } from "./policy.js";

const MAX_PDF_BYTES = 3 * 1024 * 1024;
const MAX_PDF_PAGES = 12;
const MAX_TEXT_PER_PAGE = 2_000;
const MAX_PARSER_TIME_MS = 6_000;

function verifiedUrl(value: unknown, workspaceId: string): URL {
  if (!/^[1-9][0-9]{0,19}$/.test(workspaceId))
    throw new ReadFailure("CLICKUP_PDF_HOST_NOT_ALLOWED");
  if (typeof value !== "string" || value.length > 2_048)
    throw new ReadFailure("CLICKUP_PDF_SOURCE_UNAVAILABLE");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ReadFailure("CLICKUP_PDF_SOURCE_UNAVAILABLE");
  }
  // This URL comes only from independently verified ClickUp task metadata.
  // Do not admit AWS buckets, other user-supplied URLs, arbitrary ports or
  // redirects that could perform SSRF or leak signed attachment credentials.
  if (
    url.protocol !== "https:" ||
    url.hostname !== "t" + workspaceId + ".p.clickup-attachments.com" ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== "" ||
    url.hash !== ""
  )
    throw new ReadFailure("CLICKUP_PDF_HOST_NOT_ALLOWED");
  return url;
}

async function boundedDownload(source: URL, fetcher: typeof fetch): Promise<Uint8Array> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 5_000);
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  try {
    const response = await fetcher(source.toString(), {
      method: "GET",
      redirect: "manual",
      signal: abort.signal,
      headers: { Accept: "application/pdf" },
    });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => undefined);
      throw new ReadFailure("CLICKUP_PDF_REDIRECT_BLOCKED");
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new ReadFailure(
        response.status === 401 || response.status === 403
          ? "CLICKUP_PDF_URL_UNAVAILABLE"
          : "CLICKUP_PDF_SOURCE_UNAVAILABLE",
      );
    }
    const length = response.headers.get("content-length");
    if (length !== null && (!/^[0-9]+$/.test(length) || Number(length) > MAX_PDF_BYTES)) {
      await response.body?.cancel().catch(() => undefined);
      throw new ReadFailure("CLICKUP_PDF_TOO_LARGE");
    }
    const mime = response.headers.get("content-type")?.split(";")[0]?.toLowerCase().trim();
    if (
      mime &&
      mime !== "application/pdf" &&
      mime !== "application/octet-stream" &&
      mime !== "binary/octet-stream"
    ) {
      await response.body?.cancel().catch(() => undefined);
      throw new ReadFailure("CLICKUP_PDF_NOT_PDF");
    }
    if (!response.body) throw new ReadFailure("CLICKUP_PDF_SOURCE_UNAVAILABLE");
    reader = response.body.getReader();
    let total = 0;
    const chunks: Uint8Array[] = [];
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > MAX_PDF_BYTES) {
        abort.abort();
        await reader.cancel().catch(() => undefined);
        throw new ReadFailure("CLICKUP_PDF_TOO_LARGE");
      }
      chunks.push(next.value);
    }
    const bytes = new Uint8Array(total);
    let pos = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, pos);
      pos += chunk.length;
    }
    if (bytes.length < 8 || new TextDecoder().decode(bytes.subarray(0, 5)) !== "%PDF-")
      throw new ReadFailure("CLICKUP_PDF_NOT_PDF");
    return bytes;
  } catch (error) {
    if (error instanceof ReadFailure) throw error;
    throw new ReadFailure("CLICKUP_PDF_SOURCE_UNAVAILABLE");
  } finally {
    clearTimeout(timer);
    reader?.releaseLock();
  }
}

export async function extractVerifiedTaskPdf(
  attachment: Record<string, unknown>,
  fetcher: typeof fetch,
  workspaceId: string,
): Promise<Record<string, unknown>> {
  const attachmentId = attachment["id"];
  if (
    (typeof attachmentId !== "string" && typeof attachmentId !== "number") ||
    !/^[a-zA-Z0-9_-]{1,100}$/.test(String(attachmentId))
  )
    throw new ReadFailure("CLICKUP_PDF_ATTACHMENT_INVALID");
  if (
    String(attachment["extension"] ?? "").toLowerCase() !== "pdf" ||
    String(attachment["mimetype"] ?? "").toLowerCase() !== "application/pdf"
  )
    throw new ReadFailure("CLICKUP_PDF_NOT_PDF");
  const size = Number(attachment["size"]);
  if (!Number.isSafeInteger(size) || size < 1 || size > MAX_PDF_BYTES)
    throw new ReadFailure("CLICKUP_PDF_TOO_LARGE");
  const source = verifiedUrl(attachment["url"], workspaceId);
  const bytes = await boundedDownload(source, fetcher);

  let timer: ReturnType<typeof setTimeout> | undefined;
  let loadingTask: UnpdfLoadingTask | undefined;
  let expired = false;
  try {
    const extraction = (async () => {
      // Resolve the library BEFORE invoking getDocument; if that import is
      // delayed past our deadline, do not start parsing after the request ends.
      const pdfjs = await getResolvedPDFJS();
      if (expired) throw new ReadFailure("CLICKUP_PDF_TIMEOUT");
      loadingTask = pdfjs.getDocument({
        data: bytes,
        maxImageSize: 4_194_304,
        stopAtErrors: true,
        isEvalSupported: false,
        useSystemFonts: true,
      });
      const pdf = await loadingTask.promise;
      if (expired) throw new ReadFailure("CLICKUP_PDF_TIMEOUT");
      if (pdf.numPages < 1 || pdf.numPages > MAX_PDF_PAGES)
        throw new ReadFailure("CLICKUP_PDF_PAGE_LIMIT");
      const data = await extractText(pdf);
      if (expired) throw new ReadFailure("CLICKUP_PDF_TIMEOUT");
      return data;
    })();
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        expired = true;
        // Reject promptly and stop the underlying PDF.js loading task; the
        // finally block also ensures cleanup if normal parsing completes.
        if (loadingTask) void loadingTask.destroy().catch(() => undefined);
        reject(new ReadFailure("CLICKUP_PDF_TIMEOUT"));
      }, MAX_PARSER_TIME_MS);
    });
    const result = await Promise.race([extraction, timeout]);
    const texts = Array.isArray(result.text) ? result.text : [result.text];
    const hasText = texts.some((text) => text.trim().length > 0);
    if (!hasText) throw new ReadFailure("CLICKUP_PDF_NO_TEXT_LAYER");
    const pages = texts.slice(0, MAX_PDF_PAGES).map((text, index) => ({
      page: index + 1,
      text: text.slice(0, MAX_TEXT_PER_PAGE),
      truncated: text.length > MAX_TEXT_PER_PAGE,
    }));
    return {
      source: "clickup-attachment-pdf",
      attachment_id: String(attachmentId),
      file_name: String(attachment["title"] ?? "").slice(0, 120),
      total_pages: result.totalPages,
      pages,
      incomplete: pages.some((page) => page.truncated),
      text_layer_only: true,
    };
  } catch (error) {
    if (error instanceof ReadFailure) throw error;
    if (
      error !== null &&
      typeof error === "object" &&
      "name" in error &&
      String(error.name) === "PasswordException"
    )
      throw new ReadFailure("CLICKUP_PDF_ENCRYPTED");
    throw new ReadFailure("CLICKUP_PDF_PARSE_FAILED");
  } finally {
    expired = true;
    if (timer !== undefined) clearTimeout(timer);
    if (loadingTask) await loadingTask.destroy().catch(() => undefined);
  }
}
