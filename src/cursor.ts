import { createHash } from "node:crypto"
import { statSync } from "node:fs"
import { FolioError } from "./errors.js"
import type { Store } from "./store.js"

export type ListAnchor = { time: number; id: string }
export type SearchAnchor = { time: number; sessionID: string; messageID: string; orderKey: number }

export function digestOf(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex")
}

export function dbIdentity(store: Store): Record<string, unknown> {
  let dev = "0"
  let ino = "0"
  try {
    const stat = statSync(store.file)
    dev = String(stat.dev)
    ino = String(stat.ino)
  } catch {
    // the path alone still binds the cursor
  }
  return { path: store.file, dev, ino, layout: store.layout }
}

export function encodeCursor(digest: string, anchor: unknown): string {
  return Buffer.from(JSON.stringify({ v: 1, d: digest, a: anchor })).toString("base64url")
}

export function decodeCursor(token: string, expectedDigest: string, what: string): unknown {
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(token, "base64url").toString("utf8"))
  } catch {
    throw new FolioError("E_CURSOR_INVALID", `${what} cursor is not valid base64url JSON`)
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new FolioError("E_CURSOR_INVALID", `${what} cursor envelope is malformed`)
  }
  const envelope = parsed as Record<string, unknown>
  if (envelope.v !== 1 || typeof envelope.d !== "string" || envelope.a === undefined) {
    throw new FolioError("E_CURSOR_INVALID", `${what} cursor envelope is malformed`)
  }
  if (envelope.d !== expectedDigest) {
    throw new FolioError(
      "E_CURSOR_MISMATCH",
      `${what} cursor does not belong to this database, command, query, filter, view or order`,
    )
  }
  return envelope.a
}

function anchorRecord(decoded: unknown, what: string): Record<string, unknown> {
  if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) {
    throw new FolioError("E_CURSOR_INVALID", `${what} cursor anchor is malformed`)
  }
  return decoded as Record<string, unknown>
}

function anchorTime(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new FolioError("E_CURSOR_INVALID", `${what} cursor anchor time is invalid`)
  }
  return value
}

export function requireListAnchor(decoded: unknown, what: string): ListAnchor {
  const record = anchorRecord(decoded, what)
  return {
    time: anchorTime(record.time, what),
    id: requireAnchorString(record.id, `${what} cursor anchor id`),
  }
}

export function requireSearchAnchor(decoded: unknown, what: string): SearchAnchor {
  const record = anchorRecord(decoded, what)
  const orderKey = record.orderKey
  if (typeof orderKey !== "number" || !Number.isSafeInteger(orderKey) || orderKey < 0) {
    throw new FolioError("E_CURSOR_INVALID", `${what} cursor anchor block position is invalid`)
  }
  return {
    time: anchorTime(record.time, what),
    sessionID: requireAnchorString(record.sessionID, `${what} cursor anchor session id`),
    messageID: requireAnchorString(record.messageID, `${what} cursor anchor message id`),
    orderKey,
  }
}

function requireAnchorString(value: unknown, locator: string): string {
  if (typeof value !== "string" || value === "") throw new FolioError("E_CURSOR_INVALID", `${locator} is invalid`)
  return value
}
