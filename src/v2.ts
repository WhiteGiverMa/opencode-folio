import type { NativeMessage } from "./content.js"
import { sqlText, type Store } from "./store.js"
import { decodeMessage } from "./v2-decode.js"
import {
  getSession as getSessionRow,
  infoValue,
  listSessions as listSessionRows,
  optionalSafeInteger,
  parseModel,
  readFilters,
  requireSafeInteger,
  requireString,
  searchFilters,
  searchOrder,
  type ListQuery,
  type SearchQuery,
  type SessionRow,
  type SqlParam,
} from "./session-sql.js"

export type { ListQuery, SearchQuery, SessionRow } from "./session-sql.js"

const MESSAGE_COLUMNS = ["id", "session_id", "type", "seq", "time_created", "time_updated", "data"].map(sqlText).join(", ")

export function listSessions(store: Store, query: ListQuery): SessionRow[] {
  return listSessionRows(store, "session_v2", query)
}

export function getSession(store: Store, id: string): SessionRow | null {
  return getSessionRow(store, "session_v2", id)
}

const INFO_COLUMNS = [
  "id",
  "parent_id",
  "fork_session_id",
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
  "time_idle",
  "idle_outcome",
]

export function sessionInfo(store: Store, id: string): Record<string, unknown> | null {
  const available = store.columns("session_v2")
  const columns = INFO_COLUMNS.filter((column) => available.has(column))
  const row = store.db
    .prepare(`SELECT ${columns.map(sqlText).join(", ")} FROM session_v2 WHERE id = ?`)
    .get(id) as Record<string, unknown> | undefined
  if (!row) return null
  const locator = `session ${id}`
  const value = (column: string) => infoValue(row, available, column)
  return {
    id: value("id"),
    parentID: value("parent_id"),
    forkSessionID: value("fork_session_id"),
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
    timeIdle: optionalSafeInteger(value("time_idle"), `${locator} time_idle`),
    idleOutcome: value("idle_outcome"),
  }
}

export function sessionCounts(store: Store, id: string): Record<string, unknown> {
  const messageRow = store.db.prepare("SELECT COUNT(*) AS count FROM session_message WHERE session_id = ?").get(id) as {
    count: number
  }
  const byType: Record<string, number> = {}
  for (const row of store.db
    .prepare(`SELECT ${sqlText("type")}, COUNT(*) AS count FROM session_message WHERE session_id = ? GROUP BY type ORDER BY type`)
    .iterate(id)) {
    const record = row as { type: unknown; count: unknown }
    byType[requireString(record.type, `message type in session ${id}`)] = requireSafeInteger(
      record.count,
      `message count in session ${id}`,
    )
  }
  return { messages: messageRow.count, byType }
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
  const sql = `SELECT ${MESSAGE_COLUMNS} FROM session_message WHERE ${where.join(" AND ")} ORDER BY seq ASC`
  const rows = store.db.prepare(sql).iterate(...params)
  return {
    *[Symbol.iterator]() {
      for (const row of rows) yield decodeMessage(row as Record<string, unknown>)
    },
  }
}

export function searchMessages(store: Store, query: SearchQuery): Iterable<NativeMessage> {
  const params: SqlParam[] = []
  const where = searchFilters(query, "session_v2", params)
  const sql =
    `SELECT ${MESSAGE_COLUMNS} FROM session_message` +
    (where.length > 0 ? ` WHERE ${where.join(" AND ")}` : "") +
    ` ORDER BY ${searchOrder(query.order)}`
  const rows = store.db.prepare(sql).iterate(...params)
  return {
    *[Symbol.iterator]() {
      for (const row of rows) yield decodeMessage(row as Record<string, unknown>)
    },
  }
}
