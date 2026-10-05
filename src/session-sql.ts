import { FolioError } from "./errors.js"
import { requireText, sqlText, type Store } from "./store.js"

const SESSION_COLUMNS = ["id", "parent_id", "title", "directory", "time_created", "time_updated"] as const

export type SessionRow = {
  id: string
  parentID: string | null
  title: string | null
  directory: string | null
  timeCreated: number
  timeUpdated: number
}

export type ListQuery = {
  project: string | null
  parent: string | null
  from: number | null
  until: number | null
  order: "asc" | "desc"
  limit: number
  anchor: { time: number; id: string } | null
}

export type SearchQuery = {
  sessionID: string | null
  project: string | null
  parent: string | null
  from: number | null
  until: number | null
  order: "asc" | "desc"
  anchor: { time: number; sessionID: string; messageID: string } | null
}

export type SqlParam = string | number

export function requireString(value: unknown, locator: string): string {
  if (typeof value !== "string" && !(value instanceof Uint8Array)) {
    throw new FolioError("E_DATA", `malformed ${locator}: expected a string`)
  }
  return requireText(value, locator)
}

export function requireIdentifier(value: unknown, locator: string): string {
  if (typeof value !== "string" && !(value instanceof Uint8Array)) {
    throw new FolioError("E_DATA", `malformed ${locator}: missing identifier`)
  }
  const text = requireText(value, locator)
  if (text === "") throw new FolioError("E_DATA", `malformed ${locator}: missing identifier`)
  return text
}

export function requireRole(value: unknown, locator: string): "user" | "assistant" {
  if (value !== "user" && value !== "assistant") {
    throw new FolioError("E_DATA", `malformed ${locator}: unknown role`)
  }
  return value
}

export function requireSafeInteger(value: unknown, locator: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new FolioError("E_DATA", `malformed ${locator}: invalid integer`)
  }
  return value
}

export function optionalSafeInteger(value: unknown, locator: string): number | null {
  if (value === null || value === undefined) return null
  return requireSafeInteger(value, locator)
}

export function infoValue(row: Record<string, unknown>, available: ReadonlySet<string>, column: string): unknown {
  const value = available.has(column) ? (row[column] ?? null) : null
  if (value instanceof Uint8Array) return requireText(value, `field ${column}`)
  return value
}

export function parseModel(value: unknown, locator: string): unknown {
  if (typeof value !== "string") return value
  try {
    return JSON.parse(value)
  } catch {
    throw new FolioError("E_DATA", `malformed ${locator}: model is not valid JSON`)
  }
}

function rowToSession(row: Record<string, unknown>, table: string): SessionRow {
  const id = requireIdentifier(row.id, `${table} row id`)
  return {
    id,
    parentID: row.parent_id === null || row.parent_id === undefined ? null : requireString(row.parent_id, `${table} ${id} parent_id`),
    title: row.title === null || row.title === undefined ? null : requireString(row.title, `${table} ${id} title`),
    directory:
      row.directory === null || row.directory === undefined ? null : requireString(row.directory, `${table} ${id} directory`),
    timeCreated: requireSafeInteger(row.time_created, `${table} ${id} time_created`),
    timeUpdated: requireSafeInteger(row.time_updated, `${table} ${id} time_updated`),
  }
}

export function sessionFilters(query: ListQuery, params: SqlParam[]): string[] {
  const where: string[] = []
  if (query.project !== null) {
    where.push("REPLACE(directory, ?, '/') = ?")
    params.push("\\", query.project)
  }
  if (query.parent !== null) {
    where.push("parent_id = ?")
    params.push(query.parent)
  }
  if (query.from !== null) {
    where.push("time_updated >= ?")
    params.push(query.from)
  }
  if (query.until !== null) {
    where.push("time_updated < ?")
    params.push(query.until)
  }
  if (query.anchor) {
    const op = query.order === "asc" ? ">" : "<"
    where.push(`(time_updated ${op} ? OR (time_updated = ? AND id ${op} ?))`)
    params.push(query.anchor.time, query.anchor.time, query.anchor.id)
  }
  return where
}

export function listSessions(store: Store, table: "session" | "session_v2", query: ListQuery): SessionRow[] {
  const params: SqlParam[] = []
  const where = sessionFilters(query, params)
  const direction = query.order === "asc" ? "ASC" : "DESC"
  const sql =
    `SELECT ${SESSION_COLUMNS.map(sqlText).join(", ")} FROM ${table}` +
    (where.length > 0 ? ` WHERE ${where.join(" AND ")}` : "") +
    ` ORDER BY time_updated ${direction}, id ${direction} LIMIT ?`
  params.push(query.limit)
  const rows = store.db.prepare(sql).all(...params) as Array<Record<string, unknown>>
  return rows.map((row) => rowToSession(row, table))
}

export function getSession(store: Store, table: "session" | "session_v2", id: string): SessionRow | null {
  const row = store.db
    .prepare(`SELECT ${SESSION_COLUMNS.map(sqlText).join(", ")} FROM ${table} WHERE id = ?`)
    .get(id) as Record<string, unknown> | undefined
  return row ? rowToSession(row, table) : null
}

export function searchFilters(query: SearchQuery, sessionTable: string, params: SqlParam[]): string[] {
  const where: string[] = []
  if (query.sessionID !== null) {
    where.push("session_id = ?")
    params.push(query.sessionID)
  }
  if (query.project !== null) {
    where.push(`session_id IN (SELECT id FROM ${sessionTable} WHERE REPLACE(directory, ?, '/') = ?)`)
    params.push("\\", query.project)
  }
  if (query.parent !== null) {
    where.push(`session_id IN (SELECT id FROM ${sessionTable} WHERE parent_id = ?)`)
    params.push(query.parent)
  }
  if (query.from !== null) {
    where.push("time_created >= ?")
    params.push(query.from)
  }
  if (query.until !== null) {
    where.push("time_created < ?")
    params.push(query.until)
  }
  if (query.anchor) {
    const op = query.order === "asc" ? ">" : "<"
    const inclusive = query.order === "asc" ? ">=" : "<="
    where.push(
      `(time_created ${op} ? OR (time_created = ? AND session_id ${op} ?) OR (time_created = ? AND session_id = ? AND id ${inclusive} ?))`,
    )
    params.push(
      query.anchor.time,
      query.anchor.time,
      query.anchor.sessionID,
      query.anchor.time,
      query.anchor.sessionID,
      query.anchor.messageID,
    )
  }
  return where
}

export function searchOrder(order: "asc" | "desc"): string {
  const direction = order === "asc" ? "ASC" : "DESC"
  return `time_created ${direction}, session_id ${direction}, id ${direction}`
}

export function readFilters(
  sessionID: string,
  messageIDs: string[],
  from: number | null,
  until: number | null,
  params: SqlParam[],
): string[] {
  const where = ["session_id = ?"]
  params.push(sessionID)
  if (messageIDs.length > 0) {
    where.push(`id IN (${messageIDs.map(() => "?").join(", ")})`)
    params.push(...messageIDs)
  }
  if (from !== null) {
    where.push("time_created >= ?")
    params.push(from)
  }
  if (until !== null) {
    where.push("time_created < ?")
    params.push(until)
  }
  return where
}
