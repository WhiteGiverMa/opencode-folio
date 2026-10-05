import { randomBytes } from "node:crypto"
import path from "node:path"
import { activeViews, preview, type ViewFlags } from "./content.js"
import { adapterOf, iso, isoOrNull } from "./adapter.js"
import { assertFitsStdout } from "./envelope.js"
import { FolioError } from "./errors.js"
import type { Store } from "./store.js"
import { writeTranscript } from "./transcript.js"

export function runInfo(store: Store, sessionID: string): Record<string, unknown> {
  const impl = adapterOf(store)
  const info = impl.sessionInfo(store, sessionID)
  if (info === null) {
    throw new FolioError("E_SESSION_NOT_FOUND", `session not found in the selected ${store.layout} store: ${sessionID}`)
  }
  const session: Record<string, unknown> = { ...info }
  if (typeof session.title === "string") {
    const title = preview(session.title)
    session.title = title.value
    session.titleTruncated = title.truncated
  }
  if (typeof session.timeCreated === "number") session.created = iso(session.timeCreated)
  if (typeof session.timeUpdated === "number") session.updated = iso(session.timeUpdated)
  const counts = impl.sessionCounts(store, sessionID)
  return assertFitsStdout(
    {
      ok: true,
      command: "info",
      db: store.file,
      layout: store.layout,
      authority: store.authority,
      session,
      counts,
    },
    "info",
  )
}

export type ReadArgs = {
  sessionID: string
  messageIDs: string[]
  from: number | null
  until: number | null
  views: ViewFlags
  out: { dir: string; explicit: boolean }
}

function messageExists(store: Store, sessionID: string, messageID: string): boolean {
  const table = store.layout === "v1" ? "message" : "session_message"
  const row = store.db.prepare(`SELECT 1 AS present FROM ${table} WHERE id = ? AND session_id = ?`).get(messageID, sessionID)
  return row !== undefined
}

function defaultExportName(sessionID: string): string {
  const safe = sessionID.replace(/[^A-Za-z0-9._-]/g, "_")
  const stamp = new Date().toISOString().slice(0, 19).replace(/[-:]/g, "").replace("T", "-")
  return `folio-${safe}-${stamp}-${randomBytes(4).toString("hex")}.md`
}

export async function runRead(store: Store, args: ReadArgs): Promise<Record<string, unknown>> {
  const impl = adapterOf(store)
  const session = impl.getSession(store, args.sessionID)
  if (session === null) {
    throw new FolioError("E_SESSION_NOT_FOUND", `session not found in the selected ${store.layout} store: ${args.sessionID}`)
  }
  for (const messageID of args.messageIDs) {
    if (!messageExists(store, args.sessionID, messageID)) {
      throw new FolioError("E_MESSAGE_NOT_FOUND", `message not found in session ${args.sessionID}: ${messageID}`)
    }
  }
  const file = args.out.explicit ? args.out.dir : path.join(args.out.dir, defaultExportName(args.sessionID))
  const title = session.title === null ? null : preview(session.title)
  const receipt = {
    ok: true,
    command: "read",
    db: store.file,
    layout: store.layout,
    authority: store.authority,
    sessionID: args.sessionID,
    title: title === null ? null : title.value,
    titleTruncated: title !== null && title.truncated,
    out: file,
    view: activeViews(args.views),
    order: "native",
    filters: {
      messageIDs: args.messageIDs,
      from: isoOrNull(args.from),
      until: isoOrNull(args.until),
    },
  }
  assertFitsStdout(
    {
      ...receipt,
      outBytes: Number.MAX_SAFE_INTEGER,
      messages: Number.MAX_SAFE_INTEGER,
      blocks: Number.MAX_SAFE_INTEGER,
    },
    "read preflight",
  )
  const written = await writeTranscript({
    file,
    store,
    session,
    messages: impl.readMessages(store, args.sessionID, args.messageIDs, args.from, args.until),
    views: args.views,
    filters: { messageIDs: args.messageIDs, from: args.from, until: args.until },
  })
  return assertFitsStdout(
    { ...receipt, outBytes: written.bytes, messages: written.messages, blocks: written.blocks },
    "read",
  )
}
