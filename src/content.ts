export type View = "body" | "tools" | "reasoning" | "injected" | "system" | "compaction"

export type ViewFlags = {
  tools: boolean
  reasoning: boolean
  injected: boolean
  system: boolean
  compaction: boolean
}

export type RenderItem = { label: string; text?: string; json?: unknown }

export type Block = {
  view: View
  type: string
  locator: string
  messageID: string
  sessionID: string
  timeCreated: number | null
  text: string | null
  toolName?: string
  callID?: string | null
  payload?: unknown
  render: RenderItem[]
  /** Position in the message's full native block sequence, before view filtering. */
  orderKey: number
}

export type NativeMessage = {
  id: string
  sessionID: string
  role: string
  type: string
  seq: number | null
  timeCreated: number | null
  timeUpdated: number | null
  parentID: string | null
  blocks: Block[]
}

export function viewEnabled(block: Block, flags: ViewFlags): boolean {
  if (block.view === "body") return true
  return flags[block.view]
}

export function activeViews(flags: ViewFlags): View[] {
  const views: View[] = ["body"]
  if (flags.tools) views.push("tools")
  if (flags.reasoning) views.push("reasoning")
  if (flags.injected) views.push("injected")
  if (flags.system) views.push("system")
  if (flags.compaction) views.push("compaction")
  return views
}

type FoldUnit = { start: number; length: number }

// Exact ECMAScript String.prototype.toLowerCase semantics (full-string, so
// context rules such as Greek final sigma apply), with a folded-code-unit ->
// original-code-unit map so snippets and offsets always point into the raw
// text. No normalization, locale, regex or SQL LIKE semantics are involved.
export function foldText(text: string): { folded: string; map: FoldUnit[] } {
  const folded = text.toLowerCase()
  const map: FoldUnit[] = []
  let original = 0
  let position = 0
  for (const ch of text) {
    const unit = { start: original, length: ch.length }
    const take = Math.min(ch.toLowerCase().length, folded.length - position)
    for (let i = 0; i < take; i++) map.push(unit)
    position += take
    original += ch.length
  }
  if (position < folded.length) {
    const tail = { start: Math.max(0, original - 1), length: 1 }
    while (map.length < folded.length) map.push(tail)
  }
  while (map.length > folded.length) map.pop()
  return { folded, map }
}

const OCCURRENCE_CAP = 1000

export type MatchInfo = {
  offset: number
  occurrences: number
  occurrencesCapped: boolean
}

export function firstMatch(text: string, query: string, caseSensitive: boolean): MatchInfo | null {
  if (query === "") return null
  let hay = text
  let needle = query
  let map: FoldUnit[] | null = null
  if (!caseSensitive) {
    const folded = foldText(text)
    hay = folded.folded
    map = folded.map
    needle = query.toLowerCase()
  }
  if (needle === "") return null
  let from = 0
  let firstFolded = -1
  let occurrences = 0
  let capped = false
  for (;;) {
    const index = hay.indexOf(needle, from)
    if (index === -1) break
    if (firstFolded === -1) firstFolded = index
    occurrences++
    if (occurrences >= OCCURRENCE_CAP) {
      capped = true
      break
    }
    from = index + Math.max(1, needle.length)
  }
  if (firstFolded === -1) return null
  let offset = firstFolded
  if (map) {
    const unit = map[firstFolded]
    if (unit !== undefined) offset = unit.start
  }
  return { offset, occurrences, occurrencesCapped: capped }
}

export function makeSnippet(text: string, offset: number, max = 200): { snippet: string; truncated: boolean } {
  const codePoints = Array.from(text.slice(offset))
  if (codePoints.length <= max) return { snippet: codePoints.join(""), truncated: false }
  return { snippet: codePoints.slice(0, max).join(""), truncated: true }
}

export function preview(text: string, max = 256): { value: string; truncated: boolean } {
  const codePoints = Array.from(text)
  if (codePoints.length <= max) return { value: text, truncated: false }
  return { value: codePoints.slice(0, max).join(""), truncated: true }
}

export type SearchText = { path: string; text: string }

// Iterative pre-order traversal: every stored string leaf is collected with no
// depth cap and no silent skipping. Objects and arrays never contribute text.
function collectStrings(root: unknown, rootPath: string, out: SearchText[]): void {
  const stack: Array<{ value: unknown; path: string }> = [{ value: root, path: rootPath }]
  while (stack.length > 0) {
    const frame = stack.pop()
    if (frame === undefined) break
    const value = frame.value
    if (typeof value === "string") {
      out.push({ path: frame.path, text: value })
      continue
    }
    if (Array.isArray(value)) {
      for (let i = value.length - 1; i >= 0; i--) stack.push({ value: value[i], path: `${frame.path}[${i}]` })
      continue
    }
    if (value !== null && typeof value === "object") {
      const entries = Object.entries(value)
      for (let i = entries.length - 1; i >= 0; i--) {
        const entry = entries[i]
        if (entry === undefined) continue
        stack.push({ value: entry[1], path: `${frame.path}.${entry[0]}` })
      }
    }
  }
}

// Searchable literal strings of one block. Each stored string leaf is tested
// separately; different blocks are never concatenated into synthetic text.
export function blockSearchItems(block: Block): SearchText[] {
  const items: SearchText[] = []
  if (block.toolName !== undefined) items.push({ path: `${block.locator}:tool`, text: block.toolName })
  if (block.text !== null) items.push({ path: block.locator, text: block.text })
  if (block.payload !== undefined) collectStrings(block.payload, block.locator, items)
  return items
}
