import { ReadFailure } from "./policy.js";

type Json = Record<string, unknown>;
const obj = (raw: unknown): Json | null =>
  raw !== null && typeof raw === "object" && !Array.isArray(raw) ? (raw as Json) : null;

export function chatMessageAuthorId(message: Json): string {
  const candidates = [
    message["user_id"],
    message["author_id"],
    obj(message["user"])?.["id"],
    obj(message["author"])?.["id"],
    obj(message["sender"])?.["id"],
  ].filter((value) => value !== undefined && value !== null);
  if (
    candidates.length === 0 ||
    candidates.some(
      (value) =>
        (typeof value !== "string" && typeof value !== "number") ||
        !/^[1-9][0-9]{0,23}$/.test(String(value)) ||
        !Number.isSafeInteger(Number(value)),
    ) ||
    new Set(candidates.map(String)).size !== 1
  )
    throw new ReadFailure("CLICKUP_CHAT_AUTHOR_UNVERIFIED");
  return String(candidates[0]);
}

export function chatReactionName(raw: unknown): string {
  if (typeof raw !== "string" || !/^[a-z0-9_+-]{1,64}$/.test(raw))
    throw new ReadFailure("CLICKUP_INVALID_ARGUMENT");
  return raw;
}

export function chatReactionOwned(entry: Json, authorId: string, emoji: string): boolean {
  const reaction = entry["reaction"] ?? entry["name"];
  if (reaction !== emoji) return false;
  const user = obj(entry["user"]);
  const rawId = user?.["id"] ?? entry["user_id"];
  return String(rawId) === authorId && rawId !== null && rawId !== undefined;
}

export function requireOwnChatMessage(message: Json, userId: string, expectedText?: unknown): void {
  if (chatMessageAuthorId(message) !== userId)
    throw new ReadFailure("CLICKUP_CHAT_AUTHOR_MISMATCH");
  if (expectedText !== undefined && message["content"] !== expectedText)
    throw new ReadFailure("CLICKUP_CHAT_CONTENT_MISMATCH");
}

export function requiredChatText(raw: unknown): string {
  if (typeof raw !== "string" || !raw.trim() || raw.length > 40_000)
    throw new ReadFailure("CLICKUP_INVALID_ARGUMENT");
  return raw;
}
