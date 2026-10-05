import type { BigIntStats } from "node:fs"
import fsp from "node:fs/promises"
import path from "node:path"
import type { NativeMessage, ViewFlags } from "./content.js"
import { activeViews, viewEnabled } from "./content.js"
import { boundedMessage, FolioError } from "./errors.js"
import type { SessionRow } from "./session-sql.js"
import type { Store } from "./store.js"

export type WriteResult = { out: string; bytes: number; messages: number; blocks: number }
export type FileIdentity = { dev: bigint; ino: bigint }

export type TranscriptHandle = {
  write(
    buffer: Buffer,
    offset?: number | null,
    length?: number | null,
    position?: number | null,
  ): Promise<{ bytesWritten: number }>
  close(): Promise<void>
}

export async function writeString(handle: TranscriptHandle, text: string): Promise<number> {
  const buffer = Buffer.from(text, "utf8")
  let written = 0
  while (written < buffer.length) {
    const result = await handle.write(buffer, written, buffer.length - written, null)
    const step = result.bytesWritten
    if (!Number.isInteger(step) || step <= 0) {
      throw new FolioError("E_OUTPUT", "output write made no progress")
    }
    written += step
  }
  return buffer.length
}

export function identityOf(stat: { dev: bigint; ino: bigint }): FileIdentity {
  return { dev: stat.dev, ino: stat.ino }
}

export async function removeIfOwned(file: string, identity: FileIdentity): Promise<boolean> {
  if (identity.ino === 0n) return false
  let current: BigIntStats
  try {
    current = await fsp.lstat(file, { bigint: true })
  } catch {
    return false
  }
  if (!current.isFile() || current.ino === 0n || current.ino !== identity.ino || current.dev !== identity.dev) return false
  try {
    await fsp.unlink(file)
    return true
  } catch {
    return false
  }
}

export async function publishExclusive(stage: string, file: string): Promise<void> {
  try {
    await fsp.link(stage, file)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new FolioError("E_OUT_EXISTS", `output already exists: ${file}`)
    }
    throw new FolioError("E_OUTPUT", `cannot complete output file: ${boundedMessage(error)}`)
  }
}

export async function discardStage(stage: string, stageDir: string, identity: FileIdentity): Promise<void> {
  await removeIfOwned(stage, identity)
  try {
    await fsp.rmdir(stageDir)
  } catch {
    // A non-empty private staging directory is left in place rather than deleting unverified entries.
  }
}

export async function closeStage(
  handle: TranscriptHandle,
  stage: string,
  stageDir: string,
  identity: FileIdentity,
): Promise<void> {
  try {
    await handle.close()
  } catch (error) {
    await discardStage(stage, stageDir, identity)
    throw new FolioError("E_OUTPUT", `failed to close output file: ${boundedMessage(error)}`)
  }
}

function iso(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return "unknown"
  return new Date(ms).toISOString()
}

function commentSafe(value: string): string {
  return value.replace(/-{2,}/g, (match) => match.split("").join(" "))
}

function fenceFor(text: string): string {
  let longest = 0
  let current = 0
  for (const ch of text) {
    if (ch === "`") {
      current++
      if (current > longest) longest = current
    } else {
      current = 0
    }
  }
  return "`".repeat(Math.max(3, longest + 1))
}

export async function writeTranscript(input: {
  file: string
  store: Store
  session: SessionRow
  messages: Iterable<NativeMessage>
  views: ViewFlags
  filters: { messageIDs: string[]; from: number | null; until: number | null }
}): Promise<WriteResult> {
  const { file, store, session, messages, views, filters } = input
  try {
    await fsp.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  } catch (error) {
    throw new FolioError("E_OUTPUT", `cannot create output directory: ${boundedMessage(error)}`)
  }

  let stageDir: string
  try {
    stageDir = await fsp.mkdtemp(path.join(path.dirname(file), ".folio-stage-"))
  } catch (error) {
    throw new FolioError("E_OUTPUT", `cannot create private staging directory: ${boundedMessage(error)}`)
  }
  const stage = path.join(stageDir, "export.md")

  let handle: fsp.FileHandle
  try {
    handle = await fsp.open(stage, "wx", 0o600)
  } catch (error) {
    await fsp.rm(stageDir, { recursive: true, force: true }).catch(() => {})
    throw new FolioError("E_OUTPUT", `cannot create output file: ${boundedMessage(error)}`)
  }

  let identity: FileIdentity
  try {
    identity = identityOf(await fsp.lstat(stage, { bigint: true }))
  } catch (error) {
    try {
      await handle.close()
    } catch {
      // keep the original failure
    }
    await fsp.rm(stageDir, { recursive: true, force: true }).catch(() => {})
    throw new FolioError("E_OUTPUT", `cannot stat output file: ${boundedMessage(error)}`)
  }

  let bytes = 0
  let messageCount = 0
  let blockCount = 0
  const write = async (chunk: string) => {
    bytes += await writeString(handle, chunk)
  }

  try {
    await write(`# ${session.title ?? session.id}\n\n`)
    await write(`- Session: ${session.id}\n`)
    await write(`- Parent: ${session.parentID ?? "none"}\n`)
    await write(`- Directory: ${session.directory ?? "unknown"}\n`)
    await write(`- Created: ${iso(session.timeCreated)}\n`)
    await write(`- Updated: ${iso(session.timeUpdated)}\n`)
    await write(`- Store: ${store.file}\n`)
    await write(`- Layout: ${store.layout} (${store.authority})\n`)
    await write(`- Exported: ${new Date().toISOString()}\n`)
    await write(`- View: ${activeViews(views).join(",")}\n`)
    await write(`- Filters: messageIDs=[${filters.messageIDs.join(",")}] from=${iso(filters.from)} until=${iso(filters.until)}\n\n---\n\n`)

    for (const message of messages) {
      const selected = message.blocks.filter((block) => viewEnabled(block, views))
      if (selected.length === 0) continue
      messageCount++
      await write(`## ${message.role} ${message.id}\n\n`)
      await write(
        `<!-- folio:message id=${commentSafe(message.id)} role=${commentSafe(message.role)} session=${commentSafe(message.sessionID)} time=${iso(message.timeCreated)} -->\n\n`,
      )
      for (const block of selected) {
        blockCount++
        await write(
          `<!-- folio:block message=${commentSafe(message.id)} locator=${commentSafe(block.locator)} type=${commentSafe(block.type)} view=${block.view} -->\n`,
        )
        if (block.view === "body" && block.text !== null) {
          await write(`${block.text}\n\n`)
          continue
        }
        const heading = `### ${block.type}${block.toolName ? ` ${block.toolName}` : ""}${block.callID ? ` (${block.callID})` : ""}`
        await write(`${heading}\n\n`)
        for (const item of block.render) {
          if (item.text !== undefined) {
            const fence = fenceFor(item.text)
            await write(`**${item.label}:**\n\n${fence}\n${item.text}\n${fence}\n\n`)
          } else if (item.json !== undefined) {
            const json = JSON.stringify(item.json, null, 2)
            const fence = fenceFor(json)
            await write(`**${item.label}:**\n\n${fence}json\n${json}\n${fence}\n\n`)
          } else {
            await write(`**${item.label}:**\n\n`)
          }
        }
      }
      await write(`---\n\n`)
    }
  } catch (error) {
    try {
      await handle.close()
    } catch {
      // keep the original failure
    }
    await discardStage(stage, stageDir, identity)
    throw error
  }

  await closeStage(handle, stage, stageDir, identity)
  try {
    await publishExclusive(stage, file)
  } catch (error) {
    await discardStage(stage, stageDir, identity)
    throw error
  }
  await discardStage(stage, stageDir, identity)
  return { out: file, bytes, messages: messageCount, blocks: blockCount }
}
