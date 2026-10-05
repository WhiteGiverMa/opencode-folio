import { FolioError } from "./errors.js"

export const MAX_STDOUT_BYTES = 32768
export const JSON_BUDGET = MAX_STDOUT_BYTES - 1

export function fitsStdout(json: string): boolean {
  return Buffer.byteLength(json, "utf8") + 1 <= MAX_STDOUT_BYTES
}

export function assertFitsStdout(envelope: Record<string, unknown>, context: string): Record<string, unknown> {
  if (!fitsStdout(JSON.stringify(envelope))) {
    throw new FolioError("E_BUDGET", `${context} receipt exceeds the ${MAX_STDOUT_BYTES} byte stdout budget`)
  }
  return envelope
}

export function fitItems(
  base: Record<string, unknown>,
  items: unknown[],
  itemsKey: string,
  cursorFor: (kept: number) => string | null,
  hasExtra: boolean,
): Record<string, unknown> {
  const build = (kept: number): Record<string, unknown> => {
    const more = kept < items.length || (kept === items.length && hasExtra)
    return {
      ...base,
      [itemsKey]: items.slice(0, kept),
      count: kept,
      truncated: more,
      nextCursor: more ? cursorFor(kept) : null,
    }
  }
  const itemBytes = items.map((item) => Buffer.byteLength(JSON.stringify(item) ?? "null", "utf8"))
  const prefix = new Array<number>(items.length + 1)
  prefix[0] = 0
  for (let i = 0; i < itemBytes.length; i++) prefix[i + 1] = (prefix[i] ?? 0) + (itemBytes[i] ?? 0)
  const fixedHeadBytes = Buffer.byteLength(JSON.stringify(base).slice(0, -1) + `,"${itemsKey}":`, "utf8")
  // Item and cursor sizes are not monotonic: a longer kept prefix can drop the
  // cursor (terminal page) or shrink it, so scan from the full page downwards
  // and compute each candidate size in O(1) instead of serializing every one.
  const envelopeBytes = (kept: number): number => {
    const more = kept < items.length || (kept === items.length && hasExtra)
    const cursor = more ? cursorFor(kept) : null
    const cursorJson = cursor === null ? "null" : JSON.stringify(cursor)
    const arrayBytes = 2 + (prefix[kept] ?? 0) + Math.max(0, kept - 1)
    const tailBytes = Buffer.byteLength(`,"count":${kept},"truncated":${more},"nextCursor":${cursorJson}}`, "utf8")
    return fixedHeadBytes + arrayBytes + tailBytes
  }
  let best = -1
  for (let kept = items.length; kept >= 0; kept--) {
    if (envelopeBytes(kept) + 1 <= MAX_STDOUT_BYTES) {
      best = kept
      break
    }
  }
  if (best === -1) {
    throw new FolioError("E_BUDGET", `the required JSON envelope exceeds the ${JSON_BUDGET} byte budget`)
  }
  if (items.length > 0 && best === 0) {
    throw new FolioError("E_BUDGET", `no complete result object fits inside the ${JSON_BUDGET} byte budget`)
  }
  const envelope = build(best)
  if (!fitsStdout(JSON.stringify(envelope))) {
    throw new FolioError("E_BUDGET", `receipt exceeds the ${MAX_STDOUT_BYTES} byte stdout budget`)
  }
  return envelope
}
