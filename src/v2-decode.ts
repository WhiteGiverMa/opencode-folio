import type { Block, NativeMessage, RenderItem } from "./content.js"
import { FolioError } from "./errors.js"
import { requireIdentifier, requireSafeInteger, requireString } from "./session-sql.js"
import { decodeJsonRow } from "./store.js"

const TOOL_STATUSES = new Set(["pending", "streaming", "running", "completed", "error"])

function buildToolRender(item: Record<string, unknown>, state: Record<string, unknown>): RenderItem[] {
  const items: RenderItem[] = []
  if (typeof state.status === "string") items.push({ label: "status", text: state.status })
  if (state.input !== undefined) {
    if (typeof state.input === "string") items.push({ label: "input", text: state.input })
    else items.push({ label: "input", json: state.input })
  }
  if (state.title !== undefined) items.push({ label: "title", json: state.title })
  if (state.content !== undefined) items.push({ label: "content", json: state.content })
  if (state.output !== undefined) items.push({ label: "output", json: state.output })
  if (state.error !== undefined) {
    if (typeof state.error === "string") items.push({ label: "error", text: state.error })
    else items.push({ label: "error", json: state.error })
  }
  if (state.metadata !== undefined) items.push({ label: "metadata", json: state.metadata })
  if (state.time !== undefined) items.push({ label: "time", json: state.time })
  if (state.attachments !== undefined) items.push({ label: "attachments", json: state.attachments })
  if (item.executed !== undefined) items.push({ label: "executed", json: item.executed })
  if (item.providerState !== undefined) items.push({ label: "providerState", json: item.providerState })
  if (item.providerResultState !== undefined) items.push({ label: "providerResultState", json: item.providerResultState })
  if (item.time !== undefined) items.push({ label: "tool.time", json: item.time })
  items.push({ label: "record", json: item })
  return items
}

function toolStateOf(record: Record<string, unknown>, locator: string): Record<string, unknown> {
  const state = record.state
  if (state === null || typeof state !== "object" || Array.isArray(state)) {
    throw new FolioError("E_DATA", `malformed ${locator}: tool state is not an object`)
  }
  const stateRecord = state as Record<string, unknown>
  const status = requireString(stateRecord.status, `${locator} tool status`)
  if (!TOOL_STATUSES.has(status)) throw new FolioError("E_DATA", `malformed ${locator}: unknown tool status`)
  return stateRecord
}

export function decodeMessage(row: Record<string, unknown>): NativeMessage {
  const id = requireIdentifier(row.id, "message row id")
  const sessionID = requireIdentifier(row.session_id, `message ${id} session_id`)
  const nativeType = requireIdentifier(row.type, `message ${id} type`)
  const seq = requireSafeInteger(row.seq, `message ${id} seq`)
  const timeCreated = requireSafeInteger(row.time_created, `message ${id} time_created`)
  const timeUpdated = requireSafeInteger(row.time_updated, `message ${id} time_updated`)
  const data = decodeJsonRow(row.data, `message ${id}`)

  const blocks: Block[] = []
  let orderKey = 0
  const push = (block: Omit<Block, "orderKey" | "messageID" | "sessionID" | "timeCreated">) => {
    blocks.push({ ...block, orderKey: orderKey++, messageID: id, sessionID, timeCreated })
  }

  if (nativeType === "assistant" && data.error !== undefined) {
    push({
      view: "system",
      type: "message-error",
      locator: "field:error",
      text: null,
      payload: data.error,
      render: [{ label: "error", json: data.error }],
    })
  }

  switch (nativeType) {
    case "user": {
      const text = requireString(data.text, `message ${id} text`)
      push({ view: "body", type: "text", locator: "text", text, render: [{ label: "text", text }] })
      for (const optional of ["files", "agents", "skills"] as const) {
        if (data[optional] !== undefined && !Array.isArray(data[optional])) {
          throw new FolioError("E_DATA", `malformed message ${id}: ${optional} is not an array`)
        }
      }
      if (Array.isArray(data.files)) {
        for (let i = 0; i < data.files.length; i++) {
          push({
            view: "injected",
            type: "file",
            locator: `files[${i}]`,
            text: null,
            payload: data.files[i],
            render: [{ label: "file", json: data.files[i] }],
          })
        }
      }
      if (Array.isArray(data.agents)) {
        for (let i = 0; i < data.agents.length; i++) {
          const value = data.agents[i]
          push({
            view: "injected",
            type: "agent",
            locator: `agents[${i}]`,
            text: typeof value === "string" ? value : null,
            payload: value,
            render: [{ label: "agent", json: value }],
          })
        }
      }
      if (Array.isArray(data.skills)) {
        for (let i = 0; i < data.skills.length; i++) {
          push({
            view: "injected",
            type: "skill-ref",
            locator: `skills[${i}]`,
            text: null,
            payload: data.skills[i],
            render: [{ label: "skill", json: data.skills[i] }],
          })
        }
      }
      break
    }
    case "assistant": {
      if (!Array.isArray(data.content)) {
        throw new FolioError("E_DATA", `malformed assistant message ${id}: content is not an array`)
      }
      for (let i = 0; i < data.content.length; i++) {
        const item = data.content[i]
        if (item === null || typeof item !== "object" || Array.isArray(item)) {
          throw new FolioError("E_DATA", `malformed assistant content ${id} content[${i}]`)
        }
        const record = item as Record<string, unknown>
        const itemType = requireIdentifier(record.type, `assistant content ${id} content[${i}] type`)
        const locator = `content[${i}]`
        switch (itemType) {
          case "text": {
            const text = requireString(record.text, `assistant text ${id} ${locator}`)
            push({ view: "body", type: "text", locator, text, render: [{ label: "text", text }] })
            break
          }
          case "reasoning": {
            const text = requireString(record.text, `assistant reasoning ${id} ${locator}`)
            push({
              view: "reasoning",
              type: "reasoning",
              locator,
              text,
              payload: record,
              render: [{ label: "text", text }, { label: "record", json: record }],
            })
            break
          }
          case "tool": {
            const state = toolStateOf(record, `assistant tool ${id} ${locator}`)
            push({
              view: "tools",
              type: "tool",
              locator,
              text: null,
              toolName: requireString(record.name, `assistant tool ${id} ${locator} name`),
              callID: requireIdentifier(record.id, `assistant tool ${id} ${locator} id`),
              payload: record,
              render: buildToolRender(record, state),
            })
            break
          }
          default: {
            push({
              view: "injected",
              type: itemType,
              locator,
              text: null,
              payload: record,
              render: [{ label: "record", json: record }],
            })
          }
        }
      }
      break
    }
    case "synthetic":
    case "system":
    case "skill": {
      const text = requireString(data.text, `message ${id} text`)
      const view = nativeType === "system" ? "system" : "injected"
      push({
        view,
        type: nativeType,
        locator: "record",
        text,
        payload: data,
        render: [{ label: "text", text }, { label: "record", json: data }],
      })
      break
    }
    case "shell": {
      const items: RenderItem[] = []
      const status = requireString(data.status, `message ${id} shell status`)
      const command = requireString(data.command, `message ${id} shell command`)
      requireString(data.shellID, `message ${id} shell shellID`)
      items.push({ label: "status", text: status })
      items.push({ label: "command", text: command })
      if (typeof data.output === "string") items.push({ label: "output", text: data.output })
      if (data.exit !== undefined) items.push({ label: "exit", json: data.exit })
      if (data.time !== undefined) items.push({ label: "time", json: data.time })
      items.push({ label: "record", json: data })
      push({
        view: "tools",
        type: "shell",
        locator: "record",
        text: null,
        payload: data,
        render: items,
      })
      break
    }
    case "compaction": {
      const status = requireString(data.status, `message ${id} compaction status`)
      if (status === "completed") {
        const summary = requireString(data.summary, `message ${id} compaction summary`)
        const render: RenderItem[] = [{ label: "summary", text: summary }]
        if (data.recent !== undefined) {
          render.push({ label: "recent", text: requireString(data.recent, `message ${id} compaction recent`) })
        }
        render.push({ label: "record", json: data })
        push({ view: "compaction", type: "compaction", locator: "record", text: summary, payload: data, render })
      } else if (status === "failed") {
        if (data.reason !== undefined && typeof data.reason !== "string") {
          throw new FolioError("E_DATA", `malformed message ${id} compaction reason: expected a string`)
        }
        if (data.error === undefined) throw new FolioError("E_DATA", `malformed message ${id} compaction failure: missing error`)
        if (data.time !== undefined && (data.time === null || typeof data.time !== "object" || Array.isArray(data.time))) {
          throw new FolioError("E_DATA", `malformed message ${id} compaction time: expected an object`)
        }
        const render: RenderItem[] = [{ label: "status", text: status }]
        if (typeof data.reason === "string") render.push({ label: "reason", text: data.reason })
        render.push(typeof data.error === "string" ? { label: "error", text: data.error } : { label: "error", json: data.error })
        if (data.time !== undefined) render.push({ label: "time", json: data.time })
        render.push({ label: "record", json: data })
        push({ view: "compaction", type: "compaction", locator: "record", text: null, payload: data, render })
      } else {
        throw new FolioError("E_DATA", `malformed message ${id}: unknown compaction status`)
      }
      break
    }
    case "idle":
    case "agent-switched":
    case "model-switched":
    case "location-switched": {
      push({
        view: "system",
        type: nativeType,
        locator: "record",
        text: null,
        payload: data,
        render: [{ label: "record", json: data }],
      })
      break
    }
    default: {
      push({
        view: "injected",
        type: nativeType,
        locator: "record",
        text: null,
        payload: data,
        render: [{ label: "record", json: data }],
      })
    }
  }

  return {
    id,
    sessionID,
    role: nativeType,
    type: nativeType,
    seq,
    timeCreated,
    timeUpdated,
    parentID: null,
    blocks,
  }
}
