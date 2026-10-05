// Synthetic OpenCode session-store fixtures for Folio black-box tests.
// Shapes mirror the pinned native source: v1.18.34 (session/message/part plus a
// session_message projection) and v2.0.21 (session_v2/session_message/kv).
// No real user data is used or read.
import { DatabaseSync } from "node:sqlite"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

export const V1_SCHEMA = `
CREATE TABLE "session" (
  id text PRIMARY KEY,
  project_id text NOT NULL,
  workspace_id text,
  parent_id text,
  slug text NOT NULL,
  directory text NOT NULL,
  path text,
  title text NOT NULL,
  version text NOT NULL,
  share_url text,
  summary_additions integer,
  summary_deletions integer,
  summary_files integer,
  summary_diffs text,
  metadata text,
  cost real DEFAULT 0 NOT NULL,
  tokens_input integer DEFAULT 0 NOT NULL,
  tokens_output integer DEFAULT 0 NOT NULL,
  tokens_reasoning integer DEFAULT 0 NOT NULL,
  tokens_cache_read integer DEFAULT 0 NOT NULL,
  tokens_cache_write integer DEFAULT 0 NOT NULL,
  revert text,
  permission text,
  agent text,
  model text,
  time_created integer NOT NULL,
  time_updated integer NOT NULL,
  time_compacting integer,
  time_archived integer
);
CREATE INDEX "session_project_idx" ON "session" ("project_id");
CREATE TABLE "message" (
  id text PRIMARY KEY,
  session_id text NOT NULL,
  time_created integer NOT NULL,
  time_updated integer NOT NULL,
  data text NOT NULL
);
CREATE INDEX "message_session_time_created_id_idx" ON "message" ("session_id","time_created","id");
CREATE TABLE "part" (
  id text PRIMARY KEY,
  message_id text NOT NULL,
  session_id text NOT NULL,
  time_created integer NOT NULL,
  time_updated integer NOT NULL,
  data text NOT NULL
);
CREATE INDEX "part_message_id_id_idx" ON "part" ("message_id","id");
CREATE INDEX "part_session_idx" ON "part" ("session_id");
CREATE TABLE "session_message" (
  id text PRIMARY KEY,
  session_id text NOT NULL,
  type text NOT NULL,
  seq integer NOT NULL,
  time_created integer NOT NULL,
  time_updated integer NOT NULL,
  data text NOT NULL
);
`

export const V2_SCHEMA = `
CREATE TABLE "session_v2" (
  id text PRIMARY KEY,
  project_id text NOT NULL,
  workspace_id text,
  parent_id text,
  fork_session_id text,
  fork_boundary text,
  slug text NOT NULL,
  directory text NOT NULL,
  path text,
  title text,
  version text NOT NULL,
  share_url text,
  summary_additions integer,
  summary_deletions integer,
  summary_files integer,
  summary_diffs text,
  metadata text,
  cost real DEFAULT 0 NOT NULL,
  tokens_input integer DEFAULT 0 NOT NULL,
  tokens_output integer DEFAULT 0 NOT NULL,
  tokens_reasoning integer DEFAULT 0 NOT NULL,
  tokens_cache_read integer DEFAULT 0 NOT NULL,
  tokens_cache_write integer DEFAULT 0 NOT NULL,
  revert text,
  permission text,
  agent text,
  model text,
  time_created integer NOT NULL,
  time_updated integer NOT NULL,
  time_idle integer,
  time_viewed integer,
  idle_outcome text,
  time_compacting integer,
  time_archived integer,
  time_suspended integer,
  resume_attempts integer DEFAULT 0 NOT NULL
);
CREATE INDEX "session_v2_project_idx" ON "session_v2" ("project_id");
CREATE TABLE IF NOT EXISTS "session_message" (
  id text PRIMARY KEY,
  session_id text NOT NULL,
  type text NOT NULL,
  seq integer NOT NULL,
  time_created integer NOT NULL,
  time_updated integer NOT NULL,
  data text NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "session_message_session_seq_idx" ON "session_message" ("session_id","seq");
`

export function tmpRoot(prefix = "folio-test-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

export function openWrite(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  return new DatabaseSync(file)
}

export function makeDb(file, { v1 = false, v2 = false, kv = false, wal = false } = {}) {
  const db = openWrite(file)
  if (wal) db.exec("PRAGMA journal_mode = WAL")
  if (v1) db.exec(V1_SCHEMA)
  if (v2) db.exec(V2_SCHEMA)
  if (kv) db.exec(`CREATE TABLE "kv" (key text PRIMARY KEY, value text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL);`)
  return db
}

export function ins(db, table, row) {
  const keys = Object.keys(row)
  const sql = `INSERT INTO "${table}" (${keys.map((k) => `"${k}"`).join(",")}) VALUES (${keys.map(() => "?").join(",")})`
  db.prepare(sql).run(...keys.map((k) => row[k]))
  return row
}

// v1 session row (native columns; defaults filled).
export function v1Session(db, input) {
  return ins(db, "session", {
    id: input.id,
    project_id: input.projectID ?? "prj_1",
    workspace_id: null,
    parent_id: input.parentID ?? null,
    slug: input.slug ?? input.id,
    directory: input.directory,
    path: null,
    title: input.title,
    version: "1.18.34",
    share_url: null,
    summary_additions: null,
    summary_deletions: null,
    summary_files: null,
    summary_diffs: null,
    metadata: null,
    cost: input.cost ?? 0,
    tokens_input: 0,
    tokens_output: 0,
    tokens_reasoning: 0,
    tokens_cache_read: 0,
    tokens_cache_write: 0,
    revert: null,
    permission: null,
    agent: input.agent ?? null,
    model: input.model ? JSON.stringify(input.model) : null,
    time_created: input.timeCreated,
    time_updated: input.timeUpdated,
    time_compacting: null,
    time_archived: null,
  })
}

// v1 message row: data omits id/sessionID (restored from columns by readers).
export function v1Message(db, input) {
  const { id, sessionID, timeCreated, timeUpdated, ...data } = input
  return ins(db, "message", {
    id,
    session_id: sessionID,
    time_created: timeCreated,
    time_updated: timeUpdated ?? timeCreated,
    data: JSON.stringify(data),
  })
}

// v1 part row: data omits id/sessionID/messageID.
export function v1Part(db, input) {
  const { id, sessionID, messageID, timeCreated, timeUpdated, ...data } = input
  return ins(db, "part", {
    id,
    message_id: messageID,
    session_id: sessionID,
    time_created: timeCreated,
    time_updated: timeUpdated ?? timeCreated,
    data: JSON.stringify(data),
  })
}

// v1 session_message projection row (a shadow copy readers must ignore).
export function v1ShadowMessage(db, input) {
  return ins(db, "session_message", {
    id: input.id,
    session_id: input.sessionID,
    type: input.type,
    seq: input.seq,
    time_created: input.timeCreated,
    time_updated: input.timeUpdated ?? input.timeCreated,
    data: JSON.stringify(input.data),
  })
}

export function v2Session(db, input) {
  return ins(db, "session_v2", {
    id: input.id,
    project_id: input.projectID ?? "prj_1",
    workspace_id: null,
    parent_id: input.parentID ?? null,
    fork_session_id: null,
    fork_boundary: null,
    slug: input.slug ?? input.id,
    directory: input.directory,
    path: null,
    title: input.title,
    version: "2.0.21",
    share_url: null,
    summary_additions: null,
    summary_deletions: null,
    summary_files: null,
    summary_diffs: null,
    metadata: null,
    cost: input.cost ?? 0,
    tokens_input: 0,
    tokens_output: 0,
    tokens_reasoning: 0,
    tokens_cache_read: 0,
    tokens_cache_write: 0,
    revert: null,
    permission: null,
    agent: input.agent ?? null,
    model: input.model ? JSON.stringify(input.model) : null,
    time_created: input.timeCreated,
    time_updated: input.timeUpdated,
    time_idle: null,
    time_viewed: null,
    idle_outcome: null,
    time_compacting: null,
    time_archived: null,
    time_suspended: null,
    resume_attempts: 0,
  })
}

// v2 session_message row: data omits id/type (restored from columns by readers).
export function v2Message(db, input) {
  const { id, sessionID, type, seq, timeCreated, timeUpdated, data } = input
  return ins(db, "session_message", {
    id,
    session_id: sessionID,
    type,
    seq,
    time_created: timeCreated,
    time_updated: timeUpdated ?? timeCreated,
    data: JSON.stringify(data),
  })
}

export function kvSet(db, key, value, time = 1) {
  return ins(db, "kv", {
    key,
    value: typeof value === "string" ? value : JSON.stringify(value),
    time_created: time,
    time_updated: time,
  })
}

export function fileHash(file) {
  return fs.readFileSync(file).toString("hex")
}

// Standard v1 fixture: main + child sessions, user/assistant text, synthetic and
// ignored text parts, file part, reasoning, tools (completed/error/pending),
// compaction, assistant summary message, stored system field, and a shadow
// session_message projection whose text must never be served.
export function writeV1Fixture(root, name = "v1.db") {
  const file = path.join(root, name)
  const db = makeDb(file, { v1: true })
  v1Session(db, { id: "ses_main", title: "Main Session", directory: "/home/user/project", timeCreated: 1000, timeUpdated: 2000, agent: "build" })
  v1Session(db, { id: "ses_child", parentID: "ses_main", title: "Child Session", directory: "/home/user/project/sub", timeCreated: 1100, timeUpdated: 2100 })
  v1Session(db, { id: "ses_win", title: "Win Session", directory: "C:\\work\\proj", timeCreated: 900, timeUpdated: 950 })

  // Shadow projection with a marker the v1 reader must ignore.
  v1ShadowMessage(db, {
    id: "msg_shadow",
    sessionID: "ses_main",
    type: "user",
    seq: 99,
    timeCreated: 1250,
    data: { text: "SHADOW-PROJECTION-MUST-NOT-APPEAR" },
  })

  v1Message(db, { id: "msg_u1", sessionID: "ses_main", timeCreated: 1200, timeUpdated: 1200, role: "user", time: { created: 1200 }, agent: "build", model: { providerID: "p", modelID: "m" } })
  v1Part(db, { id: "prt_u1_text", sessionID: "ses_main", messageID: "msg_u1", timeCreated: 1200, type: "text", text: "Hello \u0130stanbul %_ done \u0000 \u4e16\u754c \ud83d\ude00" })
  v1Part(db, { id: "prt_u1_synth", sessionID: "ses_main", messageID: "msg_u1", timeCreated: 1201, type: "text", text: "SYNTHETIC-NOT-DEFAULT", synthetic: true })
  v1Part(db, { id: "prt_u1_ignored", sessionID: "ses_main", messageID: "msg_u1", timeCreated: 1202, type: "text", text: "IGNORED-NOT-DEFAULT", ignored: true })
  v1Part(db, { id: "prt_u1_file", sessionID: "ses_main", messageID: "msg_u1", timeCreated: 1203, type: "file", mime: "image/png", url: "file:///tmp/a.png", filename: "a.png" })

  v1Message(db, { id: "msg_u2", sessionID: "ses_main", timeCreated: 1210, timeUpdated: 1210, role: "user", time: { created: 1210 }, agent: "build", model: { providerID: "p", modelID: "m" }, system: "STORED-SYSTEM-PROMPT" })
  v1Part(db, { id: "prt_u2_text", sessionID: "ses_main", messageID: "msg_u2", timeCreated: 1210, type: "text", text: "second user line" })

  v1Message(db, { id: "msg_a1", sessionID: "ses_main", timeCreated: 1300, timeUpdated: 1310, role: "assistant", time: { created: 1300, completed: 1400 }, parentID: "msg_u1", modelID: "m", providerID: "p", mode: "build", agent: "build", path: { cwd: "/home/user/project", root: "/home/user/project" }, cost: 0.01, tokens: { input: 1, output: 2, reasoning: 0, cache: { read: 0, write: 0 } } })
  v1Part(db, { id: "prt_a1_text", sessionID: "ses_main", messageID: "msg_a1", timeCreated: 1300, type: "text", text: "Assistant body \u03b1" })
  v1Part(db, { id: "prt_a1_reason", sessionID: "ses_main", messageID: "msg_a1", timeCreated: 1301, type: "reasoning", text: "REASONING-ONLY", time: { start: 1300, end: 1305 } })
  v1Part(db, { id: "prt_a1_tool", sessionID: "ses_main", messageID: "msg_a1", timeCreated: 1302, type: "tool", callID: "call_abc", tool: "bash", state: { status: "completed", input: { command: "echo hi" }, output: "hi\n```\ninside fence\n```\n", title: "bash", metadata: { exit: 0 }, time: { start: 1300, end: 1350 }, attachments: [{ type: "file", mime: "text/plain", url: "file:///tmp/x.txt", filename: "x.txt" }] } })
  v1Part(db, { id: "prt_a1_tool2", sessionID: "ses_main", messageID: "msg_a1", timeCreated: 1303, type: "tool", callID: "call_def", tool: "write", state: { status: "error", input: { path: "/x" }, error: "boom", metadata: {}, time: { start: 1300, end: 1301 } } })
  v1Part(db, { id: "prt_a1_tool3", sessionID: "ses_main", messageID: "msg_a1", timeCreated: 1304, type: "tool", callID: "call_ghi", tool: "read", state: { status: "pending", input: { path: "/y" }, raw: "partial raw" } })
  v1Part(db, { id: "prt_a1_comp", sessionID: "ses_main", messageID: "msg_a1", timeCreated: 1305, type: "compaction", auto: true })
  v1Part(db, { id: "prt_a1_text2", sessionID: "ses_main", messageID: "msg_a1", timeCreated: 1306, type: "text", text: "needle-first" })
  v1Part(db, { id: "prt_a1_text3", sessionID: "ses_main", messageID: "msg_a1", timeCreated: 1307, type: "text", text: "needle-second" })

  v1Message(db, { id: "msg_sum", sessionID: "ses_main", timeCreated: 1400, timeUpdated: 1400, role: "assistant", time: { created: 1400, completed: 1400 }, parentID: "msg_u2", modelID: "m", providerID: "p", mode: "build", agent: "build", path: { cwd: "/home/user/project", root: "/home/user/project" }, summary: true, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } })
  v1Part(db, { id: "prt_sum_text", sessionID: "ses_main", messageID: "msg_sum", timeCreated: 1400, type: "text", text: "SUMMARY-COMPACTED-CONTENT" })

  v1Message(db, { id: "msg_c1", sessionID: "ses_child", timeCreated: 1150, timeUpdated: 1150, role: "user", time: { created: 1150 }, agent: "explore", model: { providerID: "p", modelID: "m" } })
  v1Part(db, { id: "prt_c1_text", sessionID: "ses_child", messageID: "msg_c1", timeCreated: 1150, type: "text", text: "child task prompt with needle-child" })

  db.close()
  return file
}

// Standard v2 fixture with original content indices, streaming/completed/error
// tools, file content, opaque extra error JSON, and all opt-in message types.
export function writeV2Fixture(root, name = "v2.db") {
  const file = path.join(root, name)
  const db = makeDb(file, { v2: true })
  v2Session(db, { id: "ses_v2", title: "V2 Session", directory: "/work/v2", timeCreated: 4000, timeUpdated: 6000, agent: "build" })
  v2Session(db, { id: "ses_v2_child", parentID: "ses_v2", title: "V2 Child", directory: "/work/v2/child", timeCreated: 4100, timeUpdated: 6100 })

  v2Message(db, { id: "msg_v2_u1", sessionID: "ses_v2", type: "user", seq: 1, timeCreated: 5000, data: { text: "V2 user text with needle-one", files: [{ name: "a.png", mime: "image/png", uri: "file:///a.png" }], agents: ["build"], time: { created: 5000 } } })
  v2Message(db, { id: "msg_v2_synth", sessionID: "ses_v2", type: "synthetic", seq: 2, timeCreated: 5050, data: { text: "V2 SYNTHETIC-NOT-DEFAULT", time: { created: 5050 } } })
  v2Message(db, {
    id: "msg_v2_a1",
    sessionID: "ses_v2",
    type: "assistant",
    seq: 3,
    timeCreated: 5100,
    data: {
      agent: "build",
      model: { id: "m", providerID: "p" },
      content: [
        { type: "reasoning", text: "V2 REASONING-ONLY", time: { created: 5100 } },
        { type: "text", text: "V2 body text needle-two" },
        { type: "tool", id: "call_v2_stream", name: "bash", state: { status: "streaming", input: "{\"partial\"" }, time: { created: 5100 } },
        { type: "tool", id: "call_v2_done", name: "edit", state: { status: "completed", input: { filePath: "/f" }, content: [{ type: "text", text: "done" }, { type: "file", uri: "file:///out.png", mime: "image/png", name: "out.png" }], metadata: { diff: "..." } }, time: { created: 5100, completed: 5150 } },
        { type: "tool", id: "call_v2_err", name: "fetch", state: { status: "error", input: { url: "http://x" }, error: { type: "http", message: "HTTP 500", status: 500, response: { body: "oops" }, extra: { deep: ["nested"] } }, content: [{ type: "text", text: "partial content before error" }] }, time: { created: 5100 } },
        { type: "tool", id: "call_v2_empty", name: "noop", state: { status: "completed", input: {}, content: [{ type: "text", text: "" }] }, time: { created: 5100, completed: 5101 } },
        { type: "text", text: "V2 tail text" },
      ],
      time: { created: 5100, completed: 5200 },
    },
  })
  v2Message(db, { id: "msg_v2_system", sessionID: "ses_v2", type: "system", seq: 4, timeCreated: 5200, data: { text: "V2 STORED-SYSTEM", description: "desc", time: { created: 5200 } } })
  v2Message(db, { id: "msg_v2_skill", sessionID: "ses_v2", type: "skill", seq: 5, timeCreated: 5250, data: { skill: "sk_1", name: "demo", text: "V2 SKILL-TEXT", time: { created: 5250 } } })
  v2Message(db, { id: "msg_v2_shell", sessionID: "ses_v2", type: "shell", seq: 6, timeCreated: 5300, data: { shellID: "sh_1", command: "ls", status: "completed", exit: 0, output: "a\nb\n", time: { created: 5300, completed: 5350 } } })
  v2Message(db, { id: "msg_v2_comp", sessionID: "ses_v2", type: "compaction", seq: 7, timeCreated: 5400, data: { status: "completed", reason: "auto", summary: "V2 COMPACTION-SUMMARY", recent: "recent tail", time: { created: 5400 } } })
  v2Message(db, { id: "msg_v2_idle", sessionID: "ses_v2", type: "idle", seq: 8, timeCreated: 5450, data: { outcome: "succeeded", time: { created: 5450 } } })
  v2Message(db, { id: "msg_v2_ctl", sessionID: "ses_v2", type: "agent-switched", seq: 9, timeCreated: 5500, data: { agent: "build", time: { created: 5500 } } })
  v2Message(db, { id: "msg_v2_u2", sessionID: "ses_v2", type: "user", seq: 10, timeCreated: 5600, data: { text: "V2 second user line", files: [], agents: [], time: { created: 5600 } } })
  v2Message(db, { id: "msg_v2_c1", sessionID: "ses_v2_child", type: "user", seq: 1, timeCreated: 4200, data: { text: "child v2 prompt needle-child", files: [], agents: [], time: { created: 4200 } } })
  db.close()
  return file
}

// A v2-native session whose default body view is empty (idle-only), used to
// prove no fallback to overlapping legacy rows.
export function writeV2EmptyBody(root, name = "v2-empty.db") {
  const file = path.join(root, name)
  const db = makeDb(file, { v2: true })
  v2Session(db, { id: "ses_mix", title: "Authority Session", directory: "/work/mix", timeCreated: 1, timeUpdated: 2 })
  v2Message(db, { id: "msg_mix_idle", sessionID: "ses_mix", type: "idle", seq: 1, timeCreated: 3, data: { outcome: "succeeded", time: { created: 3 } } })
  db.close()
  return file
}

// Mixed layout: identical session IDs in both generations. Legacy rows carry
// LEGACY-MARKER text; native v2 rows carry MIXED-AUTHORITY text. `kv` selects
// the migration marker content: "completed", "sessions", "invalid", or null.
export function writeMixedFixture(root, name, kvValue, opts = {}) {
  const file = path.join(root, name)
  const db = makeDb(file, { v1: true, v2: true, kv: true })
  v1Session(db, { id: "ses_mix", title: "LEGACY-TITLE", directory: "/work/legacy", timeCreated: 1, timeUpdated: 2 })
  v1Message(db, { id: "msg_legacy", sessionID: "ses_mix", timeCreated: 10, role: "user", time: { created: 10 } })
  v1Part(db, { id: "prt_legacy", sessionID: "ses_mix", messageID: "msg_legacy", timeCreated: 10, type: "text", text: "LEGACY-MARKER-TEXT" })

  v2Session(db, { id: "ses_mix", title: "AUTHORITY-TITLE", directory: "/work/authority", timeCreated: 100, timeUpdated: 200 })
  if (opts.v2EmptyBody) {
    v2Message(db, { id: "msg_auth_idle", sessionID: "ses_mix", type: "idle", seq: 1, timeCreated: 100, data: { outcome: "succeeded", time: { created: 100 } } })
  } else {
    v2Message(db, { id: "msg_auth", sessionID: "ses_mix", type: "user", seq: 1, timeCreated: 100, data: { text: "MIXED-AUTHORITY-TEXT", files: [], agents: [], time: { created: 100 } } })
  }

  if (kvValue !== null) {
    const value = kvValue === "completed" ? JSON.stringify({ phase: "completed" }) : kvValue
    kvSet(db, "migration.v1-v2", value, 50)
  }
  db.close()
  return file
}
