import {
  activeViews,
  blockSearchItems,
  firstMatch,
  makeSnippet,
  preview,
  viewEnabled,
  type ViewFlags,
} from "./content.js"
import { adapterOf, iso, isoOrNull, sessionJson } from "./adapter.js"
import {
  dbIdentity,
  decodeCursor,
  digestOf,
  encodeCursor,
  requireListAnchor,
  requireSearchAnchor,
  type SearchAnchor,
} from "./cursor.js"
import { fitItems } from "./envelope.js"
import { FolioError } from "./errors.js"
import type { Store } from "./store.js"

export { runInfo, runRead, type ReadArgs } from "./query-read.js"

export type ListArgs = {
  project: string | null
  parent: string | null
  from: number | null
  until: number | null
  order: "asc" | "desc"
  limit: number
  cursor: string | null
}

export function runList(store: Store, args: ListArgs): Record<string, unknown> {
  const impl = adapterOf(store)
  const digest = digestOf({
    v: 1,
    cmd: "list",
    db: dbIdentity(store),
    order: args.order,
    filters: { project: args.project, parent: args.parent, from: args.from, until: args.until },
  })
  let anchor: { time: number; id: string } | null = null
  if (args.cursor !== null) {
    anchor = requireListAnchor(decodeCursor(args.cursor, digest, "list"), "list")
  }

  const rows = impl.listSessions(store, {
    project: args.project,
    parent: args.parent,
    from: args.from,
    until: args.until,
    order: args.order,
    limit: args.limit + 1,
    anchor,
  })
  const hasExtra = rows.length > args.limit
  const items = rows.slice(0, args.limit).map(sessionJson)
  const base = {
    ok: true,
    command: "list",
    db: store.file,
    layout: store.layout,
    authority: store.authority,
    live: true,
    order: args.order,
    limit: args.limit,
    filters: {
      project: args.project,
      parent: args.parent,
      from: isoOrNull(args.from),
      until: isoOrNull(args.until),
    },
  }
  return fitItems(
    base,
    items,
    "sessions",
    (kept) => {
      const last = rows[kept - 1]
      return last ? encodeCursor(digest, { time: last.timeUpdated, id: last.id }) : null
    },
    hasExtra,
  )
}

export type SearchArgs = {
  query: string
  caseSensitive: boolean
  sessionID: string | null
  project: string | null
  parent: string | null
  from: number | null
  until: number | null
  order: "asc" | "desc"
  limit: number
  cursor: string | null
  views: ViewFlags
}

export function runSearch(store: Store, args: SearchArgs): Record<string, unknown> {
  const impl = adapterOf(store)
  if (args.sessionID !== null && impl.getSession(store, args.sessionID) === null) {
    throw new FolioError("E_SESSION_NOT_FOUND", `session not found in the selected ${store.layout} store: ${args.sessionID}`)
  }
  const digest = digestOf({
    v: 1,
    cmd: "search",
    db: dbIdentity(store),
    order: args.order,
    caseSensitive: args.caseSensitive,
    views: activeViews(args.views),
    scope: {
      sessionID: args.sessionID,
      project: args.project,
      parent: args.parent,
      from: args.from,
      until: args.until,
    },
    query: args.query,
  })
  let anchor: SearchAnchor | null = null
  if (args.cursor !== null) {
    anchor = requireSearchAnchor(decodeCursor(args.cursor, digest, "search"), "search")
  }

  const messages = impl.searchMessages(store, {
    sessionID: args.sessionID,
    project: args.project,
    parent: args.parent,
    from: args.from,
    until: args.until,
    order: args.order,
    anchor,
  })

  type Hit = Record<string, unknown>
  const hits: Hit[] = []
  const anchors: SearchAnchor[] = []
  let hasExtra = false

  outer: for (const message of messages) {
    let selected = message.blocks.filter((block) => viewEnabled(block, args.views))
    if (anchor && message.timeCreated === anchor.time && message.sessionID === anchor.sessionID && message.id === anchor.messageID) {
      selected = selected.filter((block) =>
        args.order === "asc" ? block.orderKey > anchor.orderKey : block.orderKey < anchor.orderKey,
      )
    }
    if (args.order === "desc") selected = selected.slice().reverse()
    for (const block of selected) {
      let matchedText: string | null = null
      let match: ReturnType<typeof firstMatch> = null
      for (const item of blockSearchItems(block)) {
        const found = firstMatch(item.text, args.query, args.caseSensitive)
        if (found) {
          match = found
          matchedText = item.text
          break
        }
      }
      if (!match || matchedText === null) continue
      const snippet = makeSnippet(matchedText, match.offset)
      hits.push({
        sessionID: message.sessionID,
        messageID: message.id,
        role: message.role,
        blockType: block.type,
        locator: block.locator,
        ...(block.callID !== null && block.callID !== undefined ? { callID: block.callID } : {}),
        timeCreated: message.timeCreated,
        created: message.timeCreated === null ? null : iso(message.timeCreated),
        snippet: snippet.snippet,
        snippetTruncated: snippet.truncated,
        matchOffset: match.offset,
        occurrences: match.occurrences,
      })
      anchors.push({
        time: message.timeCreated ?? 0,
        sessionID: message.sessionID,
        messageID: message.id,
        orderKey: block.orderKey,
      })
      if (hits.length > args.limit) {
        hasExtra = true
        break outer
      }
    }
  }

  const items = hits.slice(0, args.limit)
  const queryPreview = preview(args.query)
  const base = {
    ok: true,
    command: "search",
    db: store.file,
    layout: store.layout,
    authority: store.authority,
    live: true,
    order: args.order,
    caseSensitive: args.caseSensitive,
    query: queryPreview.value,
    queryTruncated: queryPreview.truncated,
    limit: args.limit,
    views: activeViews(args.views),
    scope: {
      sessionID: args.sessionID,
      project: args.project,
      parent: args.parent,
      from: isoOrNull(args.from),
      until: isoOrNull(args.until),
    },
  }
  return fitItems(
    base,
    items,
    "hits",
    (kept) => {
      const last = anchors[kept - 1]
      return last ? encodeCursor(digest, last) : null
    },
    hasExtra,
  )
}
