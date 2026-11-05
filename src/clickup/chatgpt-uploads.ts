import { runCatalogOperation, uploadAttachmentBytes } from "./catalog-runtime.js";
import { ReadFailure, type ReadGrant } from "./policy.js";

/** ChatGPT's documented MCP `openai/fileParams` file descriptor. */
export interface ChatGPTProvidedFile {
  download_url: string;
  file_id: string;
  mime_type?: string;
  file_name?: string;
}

const MAX_FILE_BYTES = 8 * 1024 * 1024;
const ALLOWED_HOSTS = new Set(["files.oaiusercontent.com", "chatgpt.com"]);

function validatedSource(file: ChatGPTProvidedFile): URL {
  if (
    !file ||
    typeof file !== "object" ||
    typeof file.file_id !== "string" ||
    !/^file[-_][a-zA-Z0-9_-]{5,100}$/.test(file.file_id) ||
    typeof file.download_url !== "string"
  )
    throw new ReadFailure("CLICKUP_FILE_SOURCE_UNAVAILABLE");
  let url: URL;
  try {
    url = new URL(file.download_url);
  } catch {
    throw new ReadFailure("CLICKUP_FILE_SOURCE_UNAVAILABLE");
  }
  // No arbitrary model-provided URLs, local paths, redirects or credentials.
  if (
    url.protocol !== "https:" ||
    !ALLOWED_HOSTS.has(url.hostname.toLowerCase()) ||
    url.port !== "" ||
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== ""
  )
    throw new ReadFailure("CLICKUP_FILE_SOURCE_UNAVAILABLE");
  return url;
}

function detectType(bytes: Uint8Array): { mime: string; ext: string } {
  const is = (...signature: number[]) => signature.every((value, i) => bytes[i] === value);
  if (is(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return { mime: "image/png", ext: "png" };
  if (is(0xff, 0xd8, 0xff)) return { mime: "image/jpeg", ext: "jpg" };
  if (bytes.length >= 6) {
    const head = new TextDecoder().decode(bytes.subarray(0, 6));
    if (head === "GIF87a" || head === "GIF89a") return { mime: "image/gif", ext: "gif" };
  }
  if (
    is(0x52, 0x49, 0x46, 0x46) &&
    bytes.length >= 12 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  )
    return { mime: "image/webp", ext: "webp" };
  if (is(0x25, 0x50, 0x44, 0x46, 0x2d)) return { mime: "application/pdf", ext: "pdf" };
  if (bytes.length > 0 && !bytes.includes(0)) {
    try {
      const decoded = new TextDecoder().decode(bytes);
      if (decoded.includes("\uFFFD")) throw new ReadFailure("CLICKUP_UNSUPPORTED_FILE_TYPE");
      return { mime: "text/plain", ext: "txt" };
    } catch {
      // Only recognised safe file types are accepted.
    }
  }
  throw new ReadFailure("CLICKUP_UNSUPPORTED_FILE_TYPE");
}

function safeFilename(file: ChatGPTProvidedFile, ext: string): string {
  const requested = file.file_name;
  if (requested !== undefined && (typeof requested !== "string" || requested.length > 240))
    throw new ReadFailure("CLICKUP_INVALID_ARGUMENT");
  const cleaned = (requested ?? "")
    .replace(/[^a-zA-Z0-9._ ()-]/g, "_")
    .replace(/^\.+/, "")
    .slice(0, 120);
  const name = cleaned || "chatgpt-attachment." + ext;
  const extension = name.split(".").pop()?.toLowerCase();
  const compatible = extension === ext || (ext === "jpg" && extension === "jpeg");
  if (!compatible || !/^[a-zA-Z0-9._ ()-]{1,120}$/.test(name))
    throw new ReadFailure("CLICKUP_UNSUPPORTED_FILE_TYPE");
  return name;
}

async function loadHostFile(file: ChatGPTProvidedFile, fetcher: typeof fetch) {
  const url = validatedSource(file);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  try {
    // Do not send the ClickUp OAuth token or any cookies to a file host.
    const response = await fetcher(url.href, {
      method: "GET",
      redirect: "manual",
      signal: controller.signal,
      headers: { Accept: "application/octet-stream, image/*, application/pdf, text/plain" },
    });
    if (!response.ok || response.status >= 300 || !response.body)
      throw new ReadFailure("CLICKUP_FILE_SOURCE_UNAVAILABLE");
    const length = response.headers.get("content-length");
    if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_FILE_BYTES)) {
      controller.abort();
      await response.body.cancel().catch(() => undefined);
      throw new ReadFailure("CLICKUP_FILE_TOO_LARGE");
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        total += part.value.byteLength;
        if (total > MAX_FILE_BYTES) {
          controller.abort();
          await reader.cancel().catch(() => undefined);
          throw new ReadFailure("CLICKUP_FILE_TOO_LARGE");
        }
        chunks.push(part.value);
      }
    } finally {
      reader.releaseLock();
    }
    if (!total) throw new ReadFailure("CLICKUP_FILE_SOURCE_UNAVAILABLE");
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const type = detectType(bytes);
    const suppliedMime = file.mime_type;
    if (
      suppliedMime !== undefined &&
      suppliedMime !== "application/octet-stream" &&
      suppliedMime !== type.mime &&
      !(type.mime === "image/jpeg" && suppliedMime === "image/jpg")
    )
      throw new ReadFailure("CLICKUP_UNSUPPORTED_FILE_TYPE");
    return { bytes, mime: type.mime, filename: safeFilename(file, type.ext) };
  } catch (error) {
    controller.abort();
    if (error instanceof ReadFailure) throw error;
    throw new ReadFailure("CLICKUP_FILE_SOURCE_UNAVAILABLE");
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * File-aware MCP route. Authorization and task home-List verification precede
 * download; the shared multipart uploader verifies the task again before POST.
 * Never retry an ambiguous upload: the existing uploader preserves that rule.
 */
export async function attachChatGPTFileToTask(
  grant: ReadGrant,
  fetcher: typeof fetch,
  taskId: string,
  file: ChatGPTProvidedFile,
): Promise<Record<string, unknown>> {
  if (typeof taskId !== "string" || !/^[a-zA-Z0-9_-]{2,40}$/.test(taskId))
    throw new ReadFailure("CLICKUP_INVALID_ARGUMENT");
  if (grant.resourceScope !== "workspace" && grant.companyListTaskAccess !== true)
    throw new ReadFailure("CLICKUP_WORKSPACE_SCOPE_REQUIRED");
  validatedSource(file);
  await runCatalogOperation("clickup_get_task", { task_id: taskId }, grant, fetcher);
  const loaded = await loadHostFile(file, fetcher);
  const uploaded = await uploadAttachmentBytes(
    grant,
    fetcher,
    taskId,
    loaded.filename,
    loaded.bytes,
    loaded.mime,
  );
  // The POST's authoritative attachment ID proves acceptance. A subsequent
  // task read can prove visibility, but a failed/omitted read is not permission
  // to retry the already-completed upload.
  let verifiedByReadback = false;
  try {
    const task = await runCatalogOperation("clickup_get_task", { task_id: taskId }, grant, fetcher);
    verifiedByReadback =
      Array.isArray(task["attachments"]) &&
      task["attachments"].some(
        (entry) =>
          entry !== null &&
          typeof entry === "object" &&
          (entry as Record<string, unknown>)["id"] === uploaded["id"],
      );
  } catch {
    // Surface unverified visibility without manufacturing a failed upload.
  }
  return {
    source: "clickup-api-v2",
    attachment_id: uploaded["id"],
    attachment_name: uploaded["title"] ?? uploaded["name"] ?? loaded.filename,
    attachment_url: uploaded["url"] ?? null,
    verified_by_readback: verifiedByReadback,
    byte_size: loaded.bytes.byteLength,
    media_type: loaded.mime,
  };
}
