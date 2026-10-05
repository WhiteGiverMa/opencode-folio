import os from "node:os"
import path from "node:path"
import { FolioError } from "./errors.js"

export function openCodeDataRoot(): string {
  const xdg = process.env.XDG_DATA_HOME
  const base = xdg && xdg !== "" ? xdg : path.join(os.homedir(), ".local", "share")
  return path.join(base, "opencode")
}

export function openCodeCacheRoot(): string {
  const xdg = process.env.XDG_CACHE_HOME
  return xdg && xdg !== "" ? xdg : path.join(os.homedir(), ".cache")
}

function envValue(name: string): string | undefined {
  const value = process.env[name]
  if (value === undefined || value === "") return undefined
  return value
}

function assertUsableDbValue(value: string, source: string): string {
  const trimmed = value
  if (trimmed === "") throw new FolioError("E_USAGE", `empty database path from ${source}`)
  if (trimmed === ":memory:") throw new FolioError("E_USAGE", `${source} must not be ':memory:'; Folio reads existing files only`)
  if (/^file:/i.test(trimmed)) throw new FolioError("E_USAGE", `${source} must be a plain filesystem path, not a SQLite URI`)
  return trimmed
}

export type DbSelection = {
  file: string
  source: "--db" | "OPENCODE_SESSION_DB" | "OPENCODE_DB" | "standard"
}

export function resolveDbPath(explicit: string | undefined): DbSelection {
  if (explicit !== undefined) {
    return { file: path.resolve(assertUsableDbValue(explicit, "--db")), source: "--db" }
  }
  const sessionDb = envValue("OPENCODE_SESSION_DB")
  if (sessionDb !== undefined) {
    return { file: path.resolve(assertUsableDbValue(sessionDb, "OPENCODE_SESSION_DB")), source: "OPENCODE_SESSION_DB" }
  }
  const nativeDb = envValue("OPENCODE_DB")
  if (nativeDb !== undefined) {
    return { file: path.resolve(openCodeDataRoot(), assertUsableDbValue(nativeDb, "OPENCODE_DB")), source: "OPENCODE_DB" }
  }
  return { file: path.join(openCodeDataRoot(), "opencode.db"), source: "standard" }
}

export function resolveExportDir(explicit: string | undefined): { dir: string; explicit: boolean } {
  if (explicit !== undefined) {
    if (explicit === "") throw new FolioError("E_USAGE", "empty --out path")
    return { dir: path.resolve(explicit), explicit: true }
  }
  const envDir = envValue("OPENCODE_SESSION_EXPORT_DIR")
  if (envDir !== undefined) return { dir: path.resolve(envDir), explicit: false }
  return { dir: path.join(openCodeCacheRoot(), "opencode-folio", "exports"), explicit: false }
}

// Normalize path separators only, for explicit project comparisons. The stored
// directory value is always reported unchanged.
export function normalizeProjectFilter(input: string): string {
  if (input === "") throw new FolioError("E_USAGE", "empty --project path")
  let normalized = input.replace(/\\/g, "/")
  while (normalized.length > 1 && normalized.endsWith("/") && !/^[A-Za-z]:\/$/.test(normalized)) {
    normalized = normalized.slice(0, -1)
  }
  return normalized
}
