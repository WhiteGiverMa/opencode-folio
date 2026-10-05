import { existsSync } from "node:fs"
import { DatabaseSync } from "node:sqlite"
import { boundedMessage, FolioError, isSqliteBusy } from "./errors.js"

export type Layout = "v1" | "v2"

// ignoreBOM:true keeps a leading U+FEFF as the real first character instead of
// stripping it, so stored TEXT bytes survive exactly and JSON.parse still
// rejects BOM-prefixed values the way native JSON does.
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })

// Node's SQLite TEXT conversion truncates at an embedded NUL. Every text
// column that reaches Folio is therefore selected through sqlText() as BLOB
// bytes and decoded here with a strict UTF-8 decoder, so the stored bytes are
// either preserved exactly or rejected as E_DATA.
export function sqlText(column: string): string {
  return `CASE WHEN typeof("${column}") IN ('text','blob') THEN CAST("${column}" AS BLOB) ELSE "${column}" END AS "${column}"`
}

export function decodeTextBytes(value: Uint8Array, locator: string): string {
  try {
    return UTF8_DECODER.decode(value)
  } catch {
    throw new FolioError("E_DATA", `malformed ${locator}: text is not valid UTF-8`)
  }
}

export function requireText(value: unknown, locator: string): string {
  if (typeof value === "string") return value
  if (value instanceof Uint8Array) return decodeTextBytes(value, locator)
  throw new FolioError("E_DATA", `malformed ${locator}: expected text`)
}

export type Store = {
  readonly db: DatabaseSync
  readonly file: string
  readonly layout: Layout
  readonly authority: string
  columns(table: string): ReadonlySet<string>
  close(): void
}

const V1_REQUIRED: Record<string, string[]> = {
  session: ["id", "parent_id", "directory", "title", "time_created", "time_updated"],
  message: ["id", "session_id", "time_created", "time_updated", "data"],
  part: ["id", "message_id", "session_id", "time_created", "time_updated", "data"],
}

const V2_REQUIRED: Record<string, string[]> = {
  session_v2: ["id", "parent_id", "directory", "title", "time_created", "time_updated"],
  session_message: ["id", "session_id", "type", "seq", "time_created", "time_updated", "data"],
}

function openError(error: unknown, context: string): FolioError {
  if (isSqliteBusy(error)) return new FolioError("E_DB_BUSY", `database is locked while ${context}`)
  return new FolioError("E_DB_OPEN", `cannot open database while ${context}: ${boundedMessage(error)}`)
}

export function openStore(file: string): Store {
  if (!existsSync(file)) throw new FolioError("E_DB_NOT_FOUND", `database not found: ${file}`)

  let db: DatabaseSync
  try {
    db = new DatabaseSync(file, { readOnly: true, allowExtension: false })
  } catch (error) {
    throw openError(error, "opening read-only")
  }

  let closed = false
  const closeQuietly = () => {
    if (closed) return
    closed = true
    try {
      db.close()
    } catch {
      // best effort during construction failure
    }
  }

  try {
    db.exec("PRAGMA busy_timeout = 5000")
    // The deferred transaction begins before any schema, metadata or row read.
    // The snapshot is taken at the first actual read below.
    db.exec("BEGIN")
  } catch (error) {
    closeQuietly()
    throw openError(error, "initializing the read transaction")
  }

  const columnCache = new Map<string, ReadonlySet<string>>()
  const tableNames = () => {
    const rows = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>
    return rows.map((row) => row.name)
  }

  try {
    const tables = new Set(tableNames())
    const has = (name: string) => tables.has(name)

    const columnsOf = (table: string): ReadonlySet<string> => {
      const cached = columnCache.get(table)
      if (cached) return cached
      const rows = db.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>
      const set = new Set(rows.map((row) => row.name))
      columnCache.set(table, set)
      return set
    }

    const requireColumns = (table: string, required: string[]) => {
      const present = columnsOf(table)
      for (const column of required) {
        if (!present.has(column)) {
          throw new FolioError("E_UNSUPPORTED_LAYOUT", `unsupported layout: table ${table} is missing column ${column}`)
        }
      }
    }

    let layout: Layout
    let authority: string

    if (has("session_v2")) {
      if (!has("session_message")) {
        throw new FolioError(
          "E_UNSUPPORTED_LAYOUT",
          "unsupported layout: session_v2 without session_message is a partial or intermediate store",
        )
      }
      requireColumns("session_v2", V2_REQUIRED.session_v2 ?? [])
      requireColumns("session_message", V2_REQUIRED.session_message ?? [])
      if (has("session")) {
        // Only a real session/session_v2 overlap needs proven migration state.
        // Leftover message/part tables without a legacy session are ignored.
        if (!has("kv")) {
          throw new FolioError(
            "E_AMBIGUOUS_LAYOUT",
            "overlapping session/session_v2 tables without a native migration marker; refusing to guess the authoritative source",
          )
        }
        requireColumns("kv", ["key", "value"])
        const row = db.prepare(`SELECT ${sqlText("value")} FROM kv WHERE key = ?`).get("migration.v1-v2") as
          | { value: unknown }
          | undefined
        if (!row) {
          throw new FolioError(
            "E_AMBIGUOUS_LAYOUT",
            "overlapping session/session_v2 tables without migration.v1-v2 state; refusing to guess the authoritative source",
          )
        }
        let parsed: unknown
        try {
          parsed = JSON.parse(requireText(row.value, "migration.v1-v2 state"))
        } catch (error) {
          if (error instanceof FolioError) throw error
          throw new FolioError("E_AMBIGUOUS_LAYOUT", "migration.v1-v2 state is not valid JSON; refusing to guess")
        }
        if (parsed === null || typeof parsed !== "object" || (parsed as { phase?: unknown }).phase !== "completed") {
          throw new FolioError(
            "E_AMBIGUOUS_LAYOUT",
            "migration.v1-v2 is not completed; overlapping layouts are unsupported until the native import completes",
          )
        }
        authority = "v2-completed-migration"
      } else {
        authority = "v2-native"
      }
      layout = "v2"
    } else if (has("session")) {
      // A pre-split V2 lineage renamed session only; without session_v2 the
      // native rename would die on V1-only history, so this is unsupported.
      if (has("migration") && columnsOf("migration").has("id")) {
        const marker = db
          .prepare("SELECT id FROM migration WHERE id = ?")
          .get("20260730195856_optional_session_title")
        if (marker !== undefined) {
          throw new FolioError(
            "E_UNSUPPORTED_LAYOUT",
            "unsupported layout: pre-split v2 lineage (20260730195856_optional_session_title) without session_v2",
          )
        }
      }
      if (!has("message") || !has("part")) {
        throw new FolioError(
          "E_UNSUPPORTED_LAYOUT",
          "unsupported layout: session without message/part is a partial legacy store",
        )
      }
      requireColumns("session", V1_REQUIRED.session ?? [])
      requireColumns("message", V1_REQUIRED.message ?? [])
      requireColumns("part", V1_REQUIRED.part ?? [])
      layout = "v1"
      authority = "v1-message-part"
    } else {
      const summary = [...tables].sort().slice(0, 8).join(", ")
      throw new FolioError(
        "E_UNSUPPORTED_LAYOUT",
        `unsupported layout: expected v1 (session/message/part) or v2 (session_v2/session_message); found [${summary}]`,
      )
    }

    return {
      db,
      file,
      layout,
      authority,
      columns: columnsOf,
      close() {
        if (closed) return
        closed = true
        try {
          db.exec("COMMIT")
        } catch {
          // A read-only transaction has nothing to persist; releasing below is what matters.
        }
        try {
          db.close()
        } catch (error) {
          throw new FolioError("E_DB_OPEN", `failed to close database: ${boundedMessage(error)}`)
        }
      },
    }
  } catch (error) {
    closeQuietly()
    if (error instanceof FolioError) throw error
    if (isSqliteBusy(error)) throw new FolioError("E_DB_BUSY", `database is locked while reading its schema`)
    throw new FolioError("E_DB_OPEN", `cannot read database schema: ${boundedMessage(error)}`)
  }
}

export function decodeJsonRow(data: unknown, locator: string): Record<string, unknown> {
  if (typeof data !== "string" && !(data instanceof Uint8Array)) {
    throw new FolioError("E_DATA", `malformed row ${locator}: data column is not text`)
  }
  const text = requireText(data, `row ${locator} data column`)
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new FolioError("E_DATA", `malformed JSON in ${locator}: ${boundedMessage(error, 160)}`)
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new FolioError("E_DATA", `malformed row ${locator}: JSON value is not an object`)
  }
  return parsed as Record<string, unknown>
}
