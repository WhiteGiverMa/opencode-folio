import type { NativeMessage } from "./content.js"
import { decodeJsonRow, sqlText, type Store } from "./store.js"
import { decodeMessage } from "./v1-decode.js"
import {
  getSession as getSessionRow,
  infoValue,
  listSessions as listSessionRows,
  optionalSafeInteger,
  parseModel,
  readFilters,
  requireIdentifier,
  requireRole,
  searchFilters,
  searchOrder,
  type ListQuery,
  type SearchQuery,
  type SessionRow,
  type SqlParam,
} from "./session-sql.js"

export type { ListQuery, SearchQuery, SessionRow } from "./session-sql.js"

const MESSAGE_COLUMNS = ["id", "session_id", "time_created", "time_updated", "data"].map(sqlText).join(", ")
const PART_COLUMNS = ["id", "message_id", "session_id", "time_created", "time_updated", "data"].map(sqlText).join(", ")

export function listSessions(store: Store, query: ListQuery): SessionRow[] {
  return listSessionRows(store, "session", query)
}

export function getSession(store: Store, id: string): SessionRow | null {
  return getSessionRow(store, "session", id)
}

const INFO_COLUMNS = [
  "id",
  "parent_id",
  "title",
  "directory",
  "version",
  "agent",
  "model",
  "cost",
  "tokens_input",
  "tokens_output",
  "tokens_reasoning",
  "tokens_cache_read",
  "tokens_cache_write",
  "time_created",
  "time_updated",
  "time_compacting",
  "time_archived",
]

export function sessionInfo(store: Store, id: string): Record<string, unknown> | null {
  const available = store.columns("session")
  const columns = INFO_COLUMNS.filter((column) => available.has(column))
  const row = store.db.prepare(`SELECT ${columns.map(sqlText).join(", ")} FROM session WHERE id = ?`).get(id) as
    | Record<string, unknown>
    | undefined
  if (!row) return null
  const locator = `session ${id}`
  const value = (column: string) => infoValue(row, available, column)
  return {
    id: value("id"),
    parentID: value("parent_id"),
    title: value("title"),
    directory: value("directory"),
    version: value("version"),
    agent: value("agent"),
    model: parseModel(value("model"), `${locator} model`),
    cost: value("cost"),
    tokens: {
      input: value("tokens_input"),
      output: value("tokens_output"),
      reasoning: value("tokens_reasoning"),
      cacheRead: value("tokens_cache_read"),
      cacheWrite: value("tokens_cache_write"),
    },
    timeCreated: optionalSafeInteger(value("time_created"), `${locator} time_created`),
    timeUpdated: optionalSafeInteger(value("time_updated"), `${locator} time_updated`),
    timeCompacting: optionalSafeInteger(value("time_compacting"), `${locator} time_compacting`),
    timeArchived: optionalSafeInteger(value("time_archived"), `${locator} time_archived`),
  }
}

export function sessionCounts(store: Store, id: string): Record<string, unknown> {
  const messageRow = store.db.prepare("SELECT COUNT(*) AS count FROM message WHERE session_id = ?").get(id) as {
    count: number
  }
  const blockRow = store.db.prepare("SELECT COUNT(*) AS count FROM part WHERE session_id = ?").get(id) as {
    count: number
  }
  const byRole: Record<string, number> = {}
  for (const row of store.db.prepare(`SELECT ${sqlText("id")}, ${sqlText("data")} FROM message WHERE session_id = ?`).iterate(id)) {
    const record = row as { id: unknown; data: unknown }
    const messageID = requireIdentifier(record.id, `message row in session ${id}`)
    const data = decodeJsonRow(record.data, `message ${messageID}`)
    const role = requireRole(data.role, `message ${messageID} role`)
    byRole[role] = (byRole[role] ?? 0) + 1
  }
  return { messages: messageRow.count, blocks: blockRow.count, byRole }
}

export function readMessages(
  store: Store,
  sessionID: string,
  messageIDs: string[],
  from: number | null,
  until: number | null,
): Iterable<NativeMessage> {
  const params: SqlParam[] = []
  const where = readFilters(sessionID, messageIDs, from, until, params)
  const sql = `SELECT ${MESSAGE_COLUMNS} FROM message WHERE ${where.join(" AND ")} ORDER BY time_created ASC, id ASC`
  const partStmt = store.db.prepare(`SELECT ${PART_COLUMNS} FROM part WHERE message_id = ? ORDER BY id ASC`)
  const rows = store.db.prepare(sql).iterate(...params)
  return {
    *[Symbol.iterator]() {
      for (const row of rows) {
        const record = row as Record<string, unknown>
        const messageID = requireIdentifier(record.id, "message row id")
        const parts = partStmt.all(messageID) as Array<Record<string, unknown>>
        yield decodeMessage(record, parts)
      }
    },
  }
}

export function searchMessages(store: Store, query: SearchQuery): Iterable<NativeMessage> {
  const params: SqlParam[] = []
  const where = searchFilters(query, "session", params)
  const sql =
    `SELECT ${MESSAGE_COLUMNS} FROM message` +
    (where.length > 0 ? ` WHERE ${where.join(" AND ")}` : "") +
    ` ORDER BY ${searchOrder(query.order)}`
  const partStmt = store.db.prepare(`SELECT ${PART_COLUMNS} FROM part WHERE message_id = ? ORDER BY id ASC`)
  const rows = store.db.prepare(sql).iterate(...params)
  return {
    *[Symbol.iterator]() {
      for (const row of rows) {
        const record = row as Record<string, unknown>
        const messageID = requireIdentifier(record.id, "message row id")
        const parts = partStmt.all(messageID) as Array<Record<string, unknown>>
        yield decodeMessage(record, parts)
      }
    },
  }
}
