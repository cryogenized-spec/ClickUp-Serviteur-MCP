import { ReadFailure } from "./policy.js";

type Json = Record<string, unknown>;
const obj = (raw: unknown): Json | null =>
  raw !== null && typeof raw === "object" && !Array.isArray(raw) ? (raw as Json) : null;

/** ClickUp's experimental v3 Chat endpoints can return a data envelope.
 * Do not interpret an unrecognized envelope as an empty authorized resource. */
export function chatEntity(response: Json, key: string): Json {
  const inner = obj(response["data"]) ?? response;
  const entity = obj(inner[key]) ?? inner;
  if (!obj(entity["id"]) && (typeof entity["id"] === "string" || typeof entity["id"] === "number"))
    return entity;
  throw new ReadFailure("CLICKUP_BAD_RESPONSE");
}

export function chatCollection(response: Json, key: string, max = 50): Json[] {
  const inner = response["data"];
  const records = Array.isArray(inner)
    ? inner
    : Array.isArray(obj(inner)?.[key])
      ? obj(inner)?.[key]
      : response[key];
  if (
    !Array.isArray(records) ||
    records.length > max ||
    records.some((entry: unknown) => !obj(entry))
  )
    throw new ReadFailure("CLICKUP_BAD_RESPONSE");
  return records as Json[];
}

export function chatCursor(response: Json): string | null {
  const inner = obj(response["data"]);
  const source = obj(response["pagination"]) ?? obj(inner?.["pagination"]) ?? response;
  const cursor = source["next_cursor"] ?? inner?.["next_cursor"] ?? response["next_cursor"];
  if (cursor === null || cursor === undefined) return null;
  if (typeof cursor !== "string" || !/^[a-zA-Z0-9_~+/=:.%-]{1,500}$/.test(cursor))
    throw new ReadFailure("CLICKUP_BAD_RESPONSE");
  return cursor;
}

const numericId = (value: unknown): string | null => {
  if (
    (typeof value === "string" || typeof value === "number") &&
    /^[1-9][0-9]{0,23}$/.test(String(value)) &&
    Number.isSafeInteger(Number(value))
  )
    return String(value);
  return null;
};

/** Never guess identities from display names or the channel creator. */
export function chatMemberId(member: Json): string {
  const candidate = [
    member["user_id"],
    obj(member["user"])?.["id"],
    obj(member["member"])?.["id"],
    member["id"],
  ].filter((value) => value !== undefined && value !== null);
  const ids = candidate.map(numericId);
  if (!ids.length || ids.some((value) => value === null) || new Set(ids).size !== 1)
    throw new ReadFailure("CLICKUP_SCOPE_OR_SCHEMA_REJECTED");
  return ids[0]!;
}

export function chatMemberIds(response: Json): { memberIds: string[]; complete: boolean } {
  const members = chatCollection(response, "members", 50);
  const memberIds = members.map(chatMemberId);
  if (new Set(memberIds).size !== memberIds.length) throw new ReadFailure("CLICKUP_BAD_RESPONSE");
  const next = chatCursor(response);
  return { memberIds, complete: next === null && members.length < 50 };
}

export function chatChannelType(channel: Json): "DM" | "GROUP_DM" | "CHANNEL" | null {
  const type = channel["type"] ?? channel["channel_type"];
  return type === "DM" || type === "GROUP_DM" || type === "CHANNEL" ? type : null;
}

export function validateDirectMessageRecipients(
  channel: Json,
  actual: { memberIds: string[]; complete: boolean },
  actorId: string,
  recipientIds: readonly string[],
): void {
  const type = chatChannelType(channel);
  if (
    !actual.complete ||
    (type !== "DM" && type !== "GROUP_DM") ||
    !actual.memberIds.includes(actorId)
  )
    throw new ReadFailure("CLICKUP_SCOPE_OR_SCHEMA_REJECTED");
  const expected = new Set([actorId, ...recipientIds]);
  if (
    actual.memberIds.length !== expected.size ||
    actual.memberIds.some((member) => !expected.has(member)) ||
    (expected.size <= 2 && type !== "DM") ||
    (expected.size > 2 && type !== "GROUP_DM")
  )
    throw new ReadFailure("CLICKUP_SCOPE_OR_SCHEMA_REJECTED");
}

export function validateRequestedRecipients(value: unknown, selfDm: unknown): string[] {
  if (selfDm !== undefined && typeof selfDm !== "boolean")
    throw new ReadFailure("CLICKUP_INVALID_ARGUMENT");
  if (selfDm === true && value !== undefined && (!Array.isArray(value) || value.length !== 0))
    throw new ReadFailure("CLICKUP_INVALID_ARGUMENT");
  if (value === undefined) {
    if (selfDm === true) return [];
    throw new ReadFailure("CLICKUP_INVALID_ARGUMENT");
  }
  if (
    !Array.isArray(value) ||
    value.length > 15 ||
    (value.length === 0 && selfDm !== true) ||
    value.some((id: unknown) => numericId(id) === null || typeof id !== "string")
  )
    throw new ReadFailure("CLICKUP_INVALID_ARGUMENT");
  const ids = value as string[];
  if (new Set(ids).size !== ids.length) throw new ReadFailure("CLICKUP_INVALID_ARGUMENT");
  return ids;
}
