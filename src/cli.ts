import { parseArgs } from "node:util"
import {
  HELP,
  OPTION_SPEC,
  parseLimit,
  parseOrder,
  parseTime,
  requiredString,
  stringValue,
  validateOptions,
  VERSION,
  viewsOf,
} from "./args.js"
import { MAX_STDOUT_BYTES } from "./envelope.js"
import { boundedMessage, FolioError } from "./errors.js"
import { normalizeProjectFilter, resolveDbPath, resolveExportDir } from "./paths.js"

const ERROR_BUDGET = 2048

function envelopeJson(code: string, message: string, command: string | null, db: string | undefined): string {
  return JSON.stringify({
    ok: false,
    command,
    ...(db !== undefined ? { db } : {}),
    error: { code, message },
  })
}

function fitsError(json: string): boolean {
  return Buffer.byteLength(json, "utf8") + 1 <= ERROR_BUDGET
}

function clampMessage(
  code: string,
  message: string,
  command: string | null,
  db: string | undefined,
): string | null {
  let lo = 0
  let hi = message.length
  let best: string | null = null
  while (lo <= hi) {
    const mid = (lo + hi + 1) >> 1
    const candidate = envelopeJson(code, `${message.slice(0, mid)}...`, command, db)
    if (fitsError(candidate)) {
      best = candidate
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return best
}

function fail(command: string | undefined, error: unknown, db?: string): number {
  const folio = error instanceof FolioError ? error : new FolioError("E_INTERNAL", boundedMessage(error))
  const variants: Array<{ command: string | null; db: string | undefined }> = []
  if (command !== undefined) variants.push({ command, db })
  if (command !== undefined && db !== undefined) variants.push({ command, db: undefined })
  if (command === undefined && db !== undefined) variants.push({ command: null, db: undefined })
  variants.push({ command: null, db: undefined })
  for (const variant of variants) {
    const full = envelopeJson(folio.code, folio.message, variant.command, variant.db)
    if (fitsError(full)) {
      process.stdout.write(`${full}\n`)
      return 1
    }
    const clamped = clampMessage(folio.code, folio.message, variant.command, variant.db)
    if (clamped !== null) {
      process.stdout.write(`${clamped}\n`)
      return 1
    }
  }
  process.stdout.write(`${envelopeJson(folio.code, "", null, undefined)}\n`)
  return 1
}

async function dispatch(command: string, values: Record<string, unknown>, positionals: string[]): Promise<number> {
  validateOptions(command, values)

  if (command === "search") {
    if (positionals.length !== 2 || positionals[1] === undefined || positionals[1] === "") {
      throw new FolioError("E_USAGE", "search requires exactly one literal <query> argument")
    }
  } else if (positionals.length !== 1) {
    throw new FolioError("E_USAGE", `${command} does not accept positional arguments`)
  }

  const selection = resolveDbPath(stringValue(values, "db"))
  const from = parseTime(values, "from", "--from")
  const until = parseTime(values, "until", "--until")
  const order = parseOrder(values)
  const limit = parseLimit(values, command)
  const views = viewsOf(values)
  const projectValue = stringValue(values, "project")
  const project = projectValue === undefined ? null : normalizeProjectFilter(projectValue)
  const parent = stringValue(values, "parent") ?? null

  const [{ openStore }, query] = await Promise.all([import("./store.js"), import("./query.js")])
  let store: import("./store.js").Store | undefined
  let ok = false
  try {
    store = openStore(selection.file)
    let envelope: Record<string, unknown>
    switch (command) {
      case "list": {
        envelope = query.runList(store, {
          project,
          parent,
          from,
          until,
          order,
          limit,
          cursor: stringValue(values, "cursor") ?? null,
        })
        break
      }
      case "search": {
        envelope = query.runSearch(store, {
          query: positionals[1] ?? "",
          caseSensitive: values["case-sensitive"] === true,
          sessionID: stringValue(values, "session-id") ?? null,
          project,
          parent,
          from,
          until,
          order,
          limit,
          cursor: stringValue(values, "cursor") ?? null,
          views,
        })
        break
      }
      case "read": {
        const messageIDs = Array.isArray(values["message-id"])
          ? values["message-id"].filter((entry): entry is string => typeof entry === "string")
          : []
        envelope = await query.runRead(store, {
          sessionID: requiredString(values, "session-id", "--session-id"),
          messageIDs,
          from,
          until,
          views,
          out: resolveExportDir(stringValue(values, "out")),
        })
        break
      }
      case "info": {
        envelope = query.runInfo(store, requiredString(values, "session-id", "--session-id"))
        break
      }
      default: {
        throw new FolioError("E_INTERNAL", `unhandled command: ${command}`)
      }
    }

    const json = JSON.stringify(envelope)
    if (Buffer.byteLength(json, "utf8") + 1 > MAX_STDOUT_BYTES) {
      throw new FolioError("E_BUDGET", `receipt exceeds the ${MAX_STDOUT_BYTES} byte stdout budget`)
    }

    try {
      store.close()
    } catch (error) {
      return fail(command, error, selection.file)
    }
    ok = true
    process.stdout.write(`${json}\n`)
    return 0
  } catch (error) {
    return fail(command, error, selection.file)
  } finally {
    if (!ok && store !== undefined) {
      try {
        store.close()
      } catch {
        // the original failure is already being reported
      }
    }
  }
}

export async function main(argv: string[]): Promise<number> {
  let values: Record<string, unknown>
  let positionals: string[]
  try {
    const parsed = parseArgs({ args: argv, options: OPTION_SPEC, strict: true, allowPositionals: true })
    values = parsed.values as Record<string, unknown>
    positionals = parsed.positionals
  } catch (error) {
    return fail(undefined, new FolioError("E_USAGE", boundedMessage(error)))
  }

  if (values.help === true) {
    process.stdout.write(HELP)
    return 0
  }
  if (values.version === true) {
    process.stdout.write(`${VERSION}\n`)
    return 0
  }

  const command = positionals[0]
  if (command === undefined) return fail(undefined, new FolioError("E_USAGE", "missing command; run opencode-folio --help"))
  if (command === "help") {
    process.stdout.write(HELP)
    return 0
  }
  if (command === "version") {
    process.stdout.write(`${VERSION}\n`)
    return 0
  }
  if (command !== "list" && command !== "read" && command !== "search" && command !== "info") {
    return fail(command, new FolioError("E_USAGE", `unknown command: ${command}`))
  }

  try {
    return await dispatch(command, values, positionals)
  } catch (error) {
    return fail(command, error)
  }
}
