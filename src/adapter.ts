import { preview, type NativeMessage } from "./content.js"
import type { ListQuery, SearchQuery, SessionRow } from "./session-sql.js"
import type { Store } from "./store.js"
import * as v1 from "./v1.js"
import * as v2 from "./v2.js"

export type Adapter = {
  listSessions: (store: Store, query: ListQuery) => SessionRow[]
  getSession: (store: Store, id: string) => SessionRow | null
  sessionInfo: (store: Store, id: string) => Record<string, unknown> | null
  sessionCounts: (store: Store, id: string) => Record<string, unknown>
  readMessages: (
    store: Store,
    sessionID: string,
    messageIDs: string[],
    from: number | null,
    until: number | null,
  ) => Iterable<NativeMessage>
  searchMessages: (store: Store, query: SearchQuery) => Iterable<NativeMessage>
}

export function adapterOf(store: Store): Adapter {
  if (store.layout === "v1") {
    return {
      listSessions: v1.listSessions,
      getSession: v1.getSession,
      sessionInfo: v1.sessionInfo,
      sessionCounts: v1.sessionCounts,
      readMessages: v1.readMessages,
      searchMessages: v1.searchMessages,
    }
  }
  return {
    listSessions: v2.listSessions,
    getSession: v2.getSession,
    sessionInfo: v2.sessionInfo,
    sessionCounts: v2.sessionCounts,
    readMessages: v2.readMessages,
    searchMessages: v2.searchMessages,
  }
}

export function iso(ms: number): string {
  return new Date(ms).toISOString()
}

export function isoOrNull(ms: number | null): string | null {
  return ms === null ? null : iso(ms)
}

export function sessionJson(row: SessionRow): Record<string, unknown> {
  const title = row.title === null ? null : preview(row.title)
  return {
    id: row.id,
    parentID: row.parentID,
    title: title === null ? null : title.value,
    titleTruncated: title !== null && title.truncated,
    directory: row.directory,
    timeCreated: row.timeCreated,
    timeUpdated: row.timeUpdated,
    created: iso(row.timeCreated),
    updated: iso(row.timeUpdated),
  }
}
