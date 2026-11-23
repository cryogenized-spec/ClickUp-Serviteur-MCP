import { ReadFailure } from "./policy.js";

/**
 * Read a bounded ClickUp image from the signed URL on an independently
 * authorized task. No caller-supplied URLs, redirects, external proxy or OCR.
 * The MCP layer converts the returned base64 bytes to image-content blocks.
 */
const MAX_IMAGE_BYTES = 3 * 1024 * 1024;
const MAX_IMAGE_EDGE = 8_192;
const MAX_IMAGE_PIXELS = 16_777_216;
const DOWNLOAD_TIMEOUT_MS = 5_000;
type ImageMime = "image/png" | "image/jpeg" | "image/webp";

const byte = (value: Uint8Array, offset: number): number => value[offset] ?? 0;
const be16 = (value: Uint8Array, offset: number): number =>
  byte(value, offset) * 256 + byte(value, offset + 1);
const be32 = (value: Uint8Array, offset: number): number =>
  byte(value, offset) * 16_777_216 +
  byte(value, offset + 1) * 65_536 +
  byte(value, offset + 2) * 256 +
  byte(value, offset + 3);

function approvedMime(attachment: Record<string, unknown>): ImageMime {
  const extension = String(attachment["extension"] ?? "").toLowerCase();
  const mime = String(attachment["mimetype"] ?? "").toLowerCase();
  if (extension === "png" && mime === "image/png") return "image/png";
  if ((extension === "jpg" || extension === "jpeg") && mime === "image/jpeg")
    return "image/jpeg";
  if (extension === "webp" && mime === "image/webp") return "image/webp";
  throw new ReadFailure("CLICKUP_IMAGE_UNSUPPORTED_TYPE");
}

function approvedUrl(value: unknown, workspaceId: string): URL {
  if (!/^[1-9]\d{0,19}$/.test(workspaceId))
    throw new ReadFailure("CLICKUP_IMAGE_HOST_NOT_ALLOWED");
  if (typeof value !== "string" || value.length > 2_048)
    throw new ReadFailure("CLICKUP_IMAGE_URL_UNAVAILABLE");
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ReadFailure("CLICKUP_IMAGE_URL_UNAVAILABLE");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.hostname !== "t" + workspaceId + ".p.clickup-attachments.com" ||
    !parsed.pathname.startsWith("/t" + workspaceId + "/") ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.port !== "" ||
    parsed.hash !== ""
  )
    throw new ReadFailure("CLICKUP_IMAGE_HOST_NOT_ALLOWED");
  return parsed;
}

async function downloadImage(source: URL, mime: ImageMime, fetcher: typeof fetch): Promise<Uint8Array> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  try {
    const response = await fetcher(source.toString(), {
      method: "GET",
      redirect: "manual",
      signal: controller.signal,
      // Never forward the personal ClickUp API token to the attachment CDN.
      headers: { Accept: mime },
    });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => undefined);
      throw new ReadFailure("CLICKUP_IMAGE_REDIRECT_BLOCKED");
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new ReadFailure(
        response.status === 401 || response.status === 403
          ? "CLICKUP_IMAGE_URL_UNAVAILABLE"
          : "CLICKUP_IMAGE_SOURCE_UNAVAILABLE",
      );
    }
    const headerLength = response.headers.get("content-length");
    if (
      headerLength !== null &&
      (!/^[0-9]+$/.test(headerLength) ||
        Number(headerLength) < 1 ||
        Number(headerLength) > MAX_IMAGE_BYTES)
    ) {
      await response.body?.cancel().catch(() => undefined);
      throw new ReadFailure("CLICKUP_IMAGE_TOO_LARGE");
    }
    const responseMime = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
    if (
      responseMime &&
      responseMime !== mime &&
      responseMime !== "application/octet-stream" &&
      responseMime !== "binary/octet-stream"
    ) {
      await response.body?.cancel().catch(() => undefined);
      throw new ReadFailure("CLICKUP_IMAGE_UNSUPPORTED_TYPE");
    }
    if (!response.body) throw new ReadFailure("CLICKUP_IMAGE_SOURCE_UNAVAILABLE");
    reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      total += part.value.byteLength;
      if (total > MAX_IMAGE_BYTES) {
        controller.abort();
        await reader.cancel().catch(() => undefined);
        throw new ReadFailure("CLICKUP_IMAGE_TOO_LARGE");
      }
      chunks.push(part.value);
    }
    const data = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      data.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return data;
  } catch (error) {
    if (error instanceof ReadFailure) throw error;
    throw new ReadFailure("CLICKUP_IMAGE_SOURCE_UNAVAILABLE");
  } finally {
    clearTimeout(timeout);
    reader?.releaseLock();
  }
}

/** Inspect genuine file-header dimensions, not only untrusted metadata. */
function imageDimensions(bytes: Uint8Array, mime: ImageMime): { width: number; height: number } {
  if (mime === "image/png") {
    if (
      bytes.length < 24 ||
      [137, 80, 78, 71, 13, 10, 26, 10].some((v, i) => byte(bytes, i) !== v) ||
      be32(bytes, 8) !== 13 ||
      String.fromCharCode(...bytes.subarray(12, 16)) !== "IHDR"
    )
      throw new ReadFailure("CLICKUP_IMAGE_INVALID_CONTENT");
    return { width: be32(bytes, 16), height: be32(bytes, 20) };
  }
  if (mime === "image/jpeg") {
    if (bytes.length < 12 || byte(bytes, 0) !== 0xff || byte(bytes, 1) !== 0xd8)
      throw new ReadFailure("CLICKUP_IMAGE_INVALID_CONTENT");
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (byte(bytes, offset++) !== 0xff) continue;
      while (byte(bytes, offset) === 0xff) offset++;
      const marker = byte(bytes, offset++);
      if (marker === 0xd9 || marker === 0xda) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (offset + 2 > bytes.length) break;
      const length = be16(bytes, offset);
      if (length < 2 || offset + length > bytes.length) break;
      if (
        ((marker >= 0xc0 && marker <= 0xc3) ||
          (marker >= 0xc5 && marker <= 0xc7) ||
          (marker >= 0xc9 && marker <= 0xcb) ||
          (marker >= 0xcd && marker <= 0xcf)) &&
        length >= 7
      )
        return { width: be16(bytes, offset + 5), height: be16(bytes, offset + 3) };
      offset += length;
    }
    throw new ReadFailure("CLICKUP_IMAGE_INVALID_CONTENT");
  }
  if (
    bytes.length < 30 ||
    String.fromCharCode(...bytes.subarray(0, 4)) !== "RIFF" ||
    String.fromCharCode(...bytes.subarray(8, 12)) !== "WEBP"
  )
    throw new ReadFailure("CLICKUP_IMAGE_INVALID_CONTENT");
  const kind = String.fromCharCode(...bytes.subarray(12, 16));
  if (kind === "VP8X") {
    return {
      width: 1 + byte(bytes, 24) + byte(bytes, 25) * 256 + byte(bytes, 26) * 65_536,
      height: 1 + byte(bytes, 27) + byte(bytes, 28) * 256 + byte(bytes, 29) * 65_536,
    };
  }
  if (kind === "VP8L" && byte(bytes, 20) === 0x2f) {
    return {
      width: 1 + byte(bytes, 21) + (byte(bytes, 22) & 0x3f) * 256,
      height:
        1 +
        (byte(bytes, 22) >> 6) +
        byte(bytes, 23) * 4 +
        (byte(bytes, 24) & 0x0f) * 1024,
    };
  }
  if (
    kind === "VP8 " &&
    byte(bytes, 23) === 0x9d &&
    byte(bytes, 24) === 0x01 &&
    byte(bytes, 25) === 0x2a
  )
    return {
      width: be16(new Uint8Array([byte(bytes, 27), byte(bytes, 26)]), 0) & 0x3fff,
      height: be16(new Uint8Array([byte(bytes, 29), byte(bytes, 28)]), 0) & 0x3fff,
    };
  throw new ReadFailure("CLICKUP_IMAGE_INVALID_CONTENT");
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 8_192)
    binary += String.fromCharCode(...bytes.subarray(i, i + 8_192));
  return btoa(binary);
}

export async function readVerifiedTaskImage(
  attachment: Record<string, unknown>,
  fetcher: typeof fetch,
  workspaceId: string,
): Promise<Record<string, unknown>> {
  const attachmentId = attachment["id"];
  const attachmentKey = String(attachmentId);
  if (
    (typeof attachmentId !== "number" && typeof attachmentId !== "string") ||
    attachmentKey.length > 100 ||
    !/^[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)*$/.test(attachmentKey)
  )
    throw new ReadFailure("CLICKUP_IMAGE_ATTACHMENT_INVALID");
  const mime = approvedMime(attachment);
  const size = Number(attachment["size"]);
  if (!Number.isSafeInteger(size) || size < 1 || size > MAX_IMAGE_BYTES)
    throw new ReadFailure("CLICKUP_IMAGE_TOO_LARGE");
  const source = approvedUrl(attachment["url"], workspaceId);
  const bytes = await downloadImage(source, mime, fetcher);
  const { width, height } = imageDimensions(bytes, mime);
  if (
    width < 1 ||
    height < 1 ||
    width > MAX_IMAGE_EDGE ||
    height > MAX_IMAGE_EDGE ||
    width * height > MAX_IMAGE_PIXELS
  )
    throw new ReadFailure("CLICKUP_IMAGE_DIMENSIONS_REJECTED");
  return {
    source: "clickup-attachment-image",
    attachment_id: attachmentKey,
    file_name: String(attachment["title"] ?? "").slice(0, 120),
    mime_type: mime,
    size_bytes: bytes.byteLength,
    width,
    height,
    image_data_base64: encodeBase64(bytes),
  };
}
