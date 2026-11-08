import { ReadFailure } from "./policy.js";

type Json = Record<string, unknown>;
const object = (value: unknown): Json | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Json) : null;

const ALLOWED_LISTS = new Set(["bullet", "ordered", "checked", "unchecked", "toggled", "none"]);
const ALLOWED_TEXT_KEYS = new Set([
  "text",
  "bold",
  "italic",
  "code",
  "link",
  "list_type",
  "code_block_language",
  "indent",
]);
const DIVIDER_FALLBACK = "\n────────────────────────\n";

/**
 * Compile the complete documented ClickUp v2 comment-formatting vocabulary.
 * The native comment endpoint accepts structured JSON, NOT Markdown source.
 * Never forward raw caller-provided attributes or arbitrary member objects.
 */
export function compileClickUpRichSegments(
  input: unknown,
  memberIds: ReadonlySet<string>,
): { segments: Json[]; mentions: string[]; dividerFallback: boolean } {
  if (!Array.isArray(input) || input.length < 1 || input.length > 100)
    throw new ReadFailure("CLICKUP_INVALID_ARGUMENT");

  const segments: Json[] = [];
  const mentions: string[] = [];
  let textChars = 0;
  let dividerFallback = false;
  let meaningful = false;

  for (const raw of input) {
    const part = object(raw);
    if (!part) throw new ReadFailure("CLICKUP_INVALID_ARGUMENT");
    const keys = Object.keys(part);
    const variants = ["text", "mention_user_id", "emoji_code", "divider"].filter(
      (key) => part[key] !== undefined,
    );
    if (variants.length !== 1) throw new ReadFailure("CLICKUP_INVALID_ARGUMENT");

    if (variants[0] === "mention_user_id") {
      if (keys.length !== 1) throw new ReadFailure("CLICKUP_INVALID_ARGUMENT");
      const value = part["mention_user_id"];
      if (
        typeof value !== "string" ||
        !/^[1-9][0-9]{0,15}$/.test(value) ||
        !Number.isSafeInteger(Number(value)) ||
        !memberIds.has(value) ||
        mentions.length >= 24
      )
        throw new ReadFailure("CLICKUP_SCOPE_OR_SCHEMA_REJECTED");
      mentions.push(value);
      segments.push({ type: "tag", user: { id: Number(value) } });
      meaningful = true;
      continue;
    }

    if (variants[0] === "emoji_code") {
      if (keys.length !== 1) throw new ReadFailure("CLICKUP_INVALID_ARGUMENT");
      const code = part["emoji_code"];
      if (typeof code !== "string" || !/^[0-9a-fA-F]{4,8}$/.test(code))
        throw new ReadFailure("CLICKUP_INVALID_ARGUMENT");
      const unicode = Number.parseInt(code, 16);
      if (unicode > 0x10ffff || (unicode >= 0xd800 && unicode <= 0xdfff))
        throw new ReadFailure("CLICKUP_INVALID_ARGUMENT");
      const canonical = code.toLowerCase().replace(/^0+(?=[0-9a-f])/, "");
      segments.push({
        text: "U" + canonical.toUpperCase().padStart(8, "0"),
        type: "emoticon",
        emoticon: { code: canonical },
      });
      meaningful = true;
      continue;
    }

    if (variants[0] === "divider") {
      if (keys.length !== 1 || part["divider"] !== true)
        throw new ReadFailure("CLICKUP_INVALID_ARGUMENT");
      segments.push({ text: DIVIDER_FALLBACK });
      dividerFallback = true;
      meaningful = true;
      textChars += DIVIDER_FALLBACK.length;
      continue;
    }

    if (keys.some((key) => !ALLOWED_TEXT_KEYS.has(key)))
      throw new ReadFailure("CLICKUP_INVALID_ARGUMENT");
    const text = part["text"];
    if (typeof text !== "string" || text.length === 0 || text.length > 40_000)
      throw new ReadFailure("CLICKUP_INVALID_ARGUMENT");
    textChars += text.length;
    if (textChars > 40_000) throw new ReadFailure("CLICKUP_INVALID_ARGUMENT");
    if (text.trim()) meaningful = true;

    const attributes: Json = {};
    for (const flag of ["bold", "italic", "code"] as const) {
      if (part[flag] === undefined) continue;
      if (typeof part[flag] !== "boolean") throw new ReadFailure("CLICKUP_INVALID_ARGUMENT");
      attributes[flag] = part[flag];
    }

    const url = part["link"];
    if (url !== undefined) {
      if (typeof url !== "string" || url.length > 2_048)
        throw new ReadFailure("CLICKUP_INVALID_ARGUMENT");
      try {
        const parsed = new URL(url);
        if (!["https:", "http:", "mailto:"].includes(parsed.protocol))
          throw new Error("Disallowed link scheme");
      } catch {
        throw new ReadFailure("CLICKUP_INVALID_ARGUMENT");
      }
      attributes["link"] = url;
    }

    const list = part["list_type"];
    const language = part["code_block_language"];
    const indent = part["indent"];
    const block = list !== undefined || language !== undefined || indent !== undefined;
    if (block) {
      if (
        text !== "\n" ||
        Object.keys(attributes).length > 0 ||
        (list !== undefined && language !== undefined)
      )
        throw new ReadFailure("CLICKUP_INVALID_ARGUMENT");
      if (list !== undefined) {
        if (typeof list !== "string" || !ALLOWED_LISTS.has(list))
          throw new ReadFailure("CLICKUP_INVALID_ARGUMENT");
        attributes["list"] = { list };
      }
      if (language !== undefined) {
        if (typeof language !== "string" || !/^[a-zA-Z0-9.+_-]{1,32}$/.test(language))
          throw new ReadFailure("CLICKUP_INVALID_ARGUMENT");
        attributes["code-block"] = { "code-block": language };
      }
      if (indent !== undefined) {
        if (!Number.isInteger(indent) || Number(indent) < 0 || Number(indent) > 8)
          throw new ReadFailure("CLICKUP_INVALID_ARGUMENT");
        attributes["indent"] = indent;
      }
    }

    segments.push(Object.keys(attributes).length === 0 ? { text } : { text, attributes });
  }

  if (!meaningful || textChars > 40_000) throw new ReadFailure("CLICKUP_INVALID_ARGUMENT");
  return { segments, mentions, dividerFallback };
}

/** Verify requested native structure survived ClickUp's readback. */
export function compareRichCommentReadback(
  expected: Json[],
  actual: unknown,
): { match: boolean; mentionIdentityVerified: boolean } {
  if (!Array.isArray(actual) || actual.length !== expected.length)
    return { match: false, mentionIdentityVerified: false };
  let mentionIdentityVerified = true;
  for (let i = 0; i < expected.length; i++) {
    const sent = expected[i]!;
    const received = object(actual[i]);
    if (!received) return { match: false, mentionIdentityVerified: false };
    if (sent["type"] === "tag") {
      if (received["type"] !== "tag" || received["text"] !== undefined)
        return { match: false, mentionIdentityVerified: false };
      if (received["user"] === undefined) {
        mentionIdentityVerified = false;
      } else if (
        String(object(received["user"])?.["id"]) !== String(object(sent["user"])?.["id"])
      ) {
        return { match: false, mentionIdentityVerified: false };
      }
    } else if (sent["type"] === "emoticon") {
      if (
        received["type"] !== "emoticon" ||
        object(received["emoticon"])?.["code"] !== object(sent["emoticon"])?.["code"]
      )
        return { match: false, mentionIdentityVerified: false };
    } else {
      if (received["type"] === "tag" || received["text"] !== sent["text"])
        return { match: false, mentionIdentityVerified: false };
      const sentAttributes = object(sent["attributes"]) ?? {};
      const storedAttributes = object(received["attributes"]) ?? {};
      for (const [key, value] of Object.entries(sentAttributes)) {
        if (key === "list" || key === "code-block") {
          if (object(storedAttributes[key])?.[key] !== object(value)?.[key])
            return { match: false, mentionIdentityVerified: false };
        } else if (storedAttributes[key] !== value) {
          return { match: false, mentionIdentityVerified: false };
        }
      }
    }
  }
  return { match: true, mentionIdentityVerified };
}
