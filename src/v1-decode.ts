import type { Block, NativeMessage, RenderItem } from "./content.js"
import { FolioError } from "./errors.js"
import { requireIdentifier, requireRole, requireSafeInteger, requireString } from "./session-sql.js"
import { decodeJsonRow } from "./store.js"

const TOOL_STATUSES = new Set(["pending", "running", "completed", "error"])

function buildToolRender(part: Record<string, unknown>, state: Record<string, unknown>): RenderItem[] {
  const items: RenderItem[] = []
  if (typeof state.status === "string") items.push({ label: "status", text: state.status })
  if (state.input !== undefined) items.push({ label: "input", json: state.input })
  if (typeof state.raw === "string") items.push({ label: "raw", text: state.raw })
  if (typeof state.title === "string" && state.title !== "") items.push({ label: "title", text: state.title })
  if (typeof state.output === "string") items.push({ label: "output", text: state.output })
  if (state.error !== undefined) {
    if (typeof state.error === "string") items.push({ label: "error", text: state.error })
    else items.push({ label: "error", json: state.error })
  }
  if (state.metadata !== undefined) items.push({ label: "metadata", json: state.metadata })
  if (state.time !== undefined) items.push({ label: "time", json: state.time })
  if (state.attachments !== undefined) items.push({ label: "attachments", json: state.attachments })
  if (part.metadata !== undefined) items.push({ label: "part.metadata", json: part.metadata })
  const known = new Set(["type", "id", "sessionID", "messageID", "callID", "tool", "state", "metadata"])
  const extra: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(part)) {
    if (!known.has(key)) extra[key] = value
  }
  if (Object.keys(extra).length > 0) items.push({ label: "extra", json: extra })
  items.push({ label: "record", json: part })
  return items
}

export function decodeMessage(row: Record<string, unknown>, partRows: Array<Record<string, unknown>>): NativeMessage {
  const id = requireIdentifier(row.id, "message row id")
  const sessionID = requireIdentifier(row.session_id, `message ${id} session_id`)
  const timeCreated = requireSafeInteger(row.time_created, `message ${id} time_created`)
  const timeUpdated = requireSafeInteger(row.time_updated, `message ${id} time_updated`)
  const data = decodeJsonRow(row.data, `message ${id}`)
  const role = requireRole(data.role, `message ${id} role`)

  const blocks: Block[] = []
  let orderKey = 0
  const push = (block: Omit<Block, "orderKey" | "messageID" | "sessionID" | "timeCreated">) => {
    blocks.push({ ...block, orderKey: orderKey++, messageID: id, sessionID, timeCreated })
  }

  if (data.system !== undefined && typeof data.system !== "string") {
    throw new FolioError("E_DATA", `malformed message ${id}: system field is not a string`)
  }
  if (typeof data.system === "string") {
    push({
      view: "system",
      type: "system",
      locator: "field:system",
      text: data.system,
      render: [{ label: "system", text: data.system }],
    })
  }
  if (data.error !== undefined) {
    push({
      view: "system",
      type: "message-error",
      locator: "field:error",
      text: null,
      payload: data.error,
      render: [{ label: "error", json: data.error }],
    })
  }
  if (data.structured !== undefined) {
    push({
      view: "tools",
      type: "structured-output",
      locator: "field:structured",
      text: null,
      payload: data.structured,
      render: [{ label: "structured", json: data.structured }],
    })
  }
  if (data.summary !== undefined && role === "user") {
    if (data.summary === null || typeof data.summary !== "object" || Array.isArray(data.summary)) {
      throw new FolioError("E_DATA", `malformed message ${id}: user summary is not an object`)
    }
    const summary = data.summary as Record<string, unknown>
    if (summary.body !== undefined && typeof summary.body !== "string") {
      throw new FolioError("E_DATA", `malformed message ${id}: user summary body is not a string`)
    }
    const body = typeof summary.body === "string" ? summary.body : null
    push({
      view: "compaction",
      type: "user-summary",
      locator: "field:summary",
      text: body,
      payload: data.summary,
      render: [...(body !== null ? [{ label: "body", text: body }] : []), { label: "summary", json: data.summary }],
    })
  }

  const isSummary = role === "assistant" && data.summary === true
  if (role === "assistant" && data.summary !== undefined && typeof data.summary !== "boolean") {
    throw new FolioError("E_DATA", `malformed message ${id}: assistant summary flag is not a boolean`)
  }
  if (data.parentID !== undefined && typeof data.parentID !== "string") {
    throw new FolioError("E_DATA", `malformed message ${id}: parentID is not a string`)
  }

  for (const partRow of partRows) {
    const partID = requireIdentifier(partRow.id, `part row in message ${id}`)
    const part = decodeJsonRow(partRow.data, `part ${partID}`)
    const type = requireIdentifier(part.type, `part ${partID} type`)
    const locator = `part:${partID}`
    const looseText = typeof part.text === "string" ? part.text : null

    switch (type) {
      case "text": {
        const text = requireString(part.text, `part ${partID} text`)
        if (part.synthetic !== undefined && typeof part.synthetic !== "boolean") {
          throw new FolioError("E_DATA", `malformed part ${partID}: synthetic flag is not a boolean`)
        }
        if (part.ignored !== undefined && typeof part.ignored !== "boolean") {
          throw new FolioError("E_DATA", `malformed part ${partID}: ignored flag is not a boolean`)
        }
        if (isSummary) {
          push({
            view: "compaction",
            type: "summary-text",
            locator,
            text,
            payload: part,
            render: [{ label: "summary", text }],
          })
        } else if (part.synthetic === true || part.ignored === true) {
          push({
            view: "injected",
            type,
            locator,
            text,
            payload: part,
            render: [{ label: "text", text }, { label: "record", json: part }],
          })
        } else {
          push({ view: "body", type, locator, text, render: [{ label: "text", text }] })
        }
        break
      }
      case "reasoning": {
        const text = requireString(part.text, `part ${partID} text`)
        push({
          view: "reasoning",
          type,
          locator,
          text,
          payload: part,
          render: [{ label: "text", text }, { label: "record", json: part }],
        })
        break
      }
      case "tool": {
        const state = part.state
        if (state === null || typeof state !== "object" || Array.isArray(state)) {
          throw new FolioError("E_DATA", `malformed part ${partID}: tool state is not an object`)
        }
        const stateRecord = state as Record<string, unknown>
        const status = requireString(stateRecord.status, `part ${partID} tool status`)
        if (!TOOL_STATUSES.has(status)) {
          throw new FolioError("E_DATA", `malformed part ${partID}: unknown tool status`)
        }
        push({
          view: "tools",
          type,
          locator,
          text: null,
          toolName: requireString(part.tool, `part ${partID} tool name`),
          callID: requireString(part.callID, `part ${partID} callID`),
          payload: part,
          render: buildToolRender(part, stateRecord),
        })
        break
      }
      case "compaction": {
        push({
          view: "compaction",
          type,
          locator,
          text: null,
          payload: part,
          render: [{ label: "record", json: part }],
        })
        break
      }
      case "subtask":
      case "retry":
      case "step-start":
      case "step-finish": {
        push({
          view: "tools",
          type,
          locator,
          text: looseText,
          payload: part,
          render: [{ label: "record", json: part }],
        })
        break
      }
      case "file":
      case "agent":
      case "snapshot":
      case "patch": {
        push({
          view: "injected",
          type,
          locator,
          text: looseText,
          payload: part,
          render: [{ label: "record", json: part }],
        })
        break
      }
      default: {
        push({
          view: "injected",
          type,
          locator,
          text: looseText,
          payload: part,
          render: [{ label: "record", json: part }],
        })
      }
    }
  }

  return {
    id,
    sessionID,
    role,
    type: role,
    seq: null,
    timeCreated,
    timeUpdated,
    parentID: typeof data.parentID === "string" ? data.parentID : null,
    blocks,
  }
}
