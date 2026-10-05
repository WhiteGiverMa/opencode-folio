export type ErrorCode =
  | "E_USAGE"
  | "E_DB_NOT_FOUND"
  | "E_DB_OPEN"
  | "E_DB_BUSY"
  | "E_UNSUPPORTED_LAYOUT"
  | "E_AMBIGUOUS_LAYOUT"
  | "E_SESSION_NOT_FOUND"
  | "E_MESSAGE_NOT_FOUND"
  | "E_OUT_EXISTS"
  | "E_OUTPUT"
  | "E_CURSOR_MISMATCH"
  | "E_CURSOR_INVALID"
  | "E_BUDGET"
  | "E_DATA"
  | "E_INTERNAL"

export class FolioError extends Error {
  readonly code: ErrorCode

  constructor(code: ErrorCode, message: string) {
    super(message)
    this.name = "FolioError"
    this.code = code
  }
}

export function isSqliteBusy(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const text = `${error.message}`
  return /SQLITE_BUSY|database is locked|database table is locked/i.test(text)
}

export function boundedMessage(error: unknown, limit = 400): string {
  const raw = error instanceof Error ? error.message : String(error)
  const collapsed = raw.replace(/\s+/g, " ").trim()
  if (collapsed.length <= limit) return collapsed
  return collapsed.slice(0, limit) + "..."
}
