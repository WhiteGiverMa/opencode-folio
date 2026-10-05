// Failing-first regressions for the independently identified Folio core gaps:
// folding/traversal, envelope budgets, transcript write ownership, tool fidelity,
// malformed known data, store authority, and timestamp/cursor validation.
import { after, before, describe, it } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import * as content from "../dist/content.js"
import {
  ins,
  makeDb,
  tmpRoot,
  v1Message,
  v1Part,
  v1Session,
  v2Message,
  v2Session,
} from "./fixtures.mjs"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const BIN = path.join(ROOT, "bin", "opencode-folio.js")
const transcript = await import("../dist/transcript.js")

let root

function cleanEnv(extra = {}) {
  return {
    ...process.env,
    OPENCODE_DB: "",
    OPENCODE_SESSION_DB: "",
    OPENCODE_SESSION_EXPORT_DIR: "",
    XDG_DATA_HOME: "",
    XDG_CACHE_HOME: "",
    ...extra,
  }
}

function run(args, opts = {}) {
  const r = spawnSync(process.execPath, [BIN, ...args], {
    cwd: opts.cwd ?? root,
    env: cleanEnv(opts.env),
    encoding: "utf8",
    timeout: 30000,
  })
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" }
}

function runJson(args, opts) {
  const r = run(args, opts)
  assert.equal(r.status, 0, `expected success, got ${r.status}: ${r.stdout} | ${r.stderr}`)
  return JSON.parse(r.stdout)
}

function expectError(args, code, opts) {
  const r = run(args, opts)
  assert.equal(r.status, 1, `expected failure, got ${r.status}: ${r.stdout}`)
  const j = JSON.parse(r.stdout)
  assert.equal(j.ok, false)
  assert.equal(j.error.code, code, `unexpected error: ${r.stdout}`)
  assert.ok(Buffer.byteLength(r.stdout, "utf8") <= 2048, "error envelope must be <=2KiB")
  return j
}

function outPath(name) {
  return path.join(root, "out", name)
}

function cursorEnvelope(token) {
  return JSON.parse(Buffer.from(token, "base64url").toString("utf8"))
}

function rawCursor(digest, anchorJson) {
  return Buffer.from(`{"v":1,"d":${JSON.stringify(digest)},"a":${anchorJson}}`).toString("base64url")
}

function deepObject(depth, leaf) {
  let value = leaf
  for (let i = 0; i < depth; i++) value = { [`level${i}`]: value }
  return value
}

before(() => {
  root = tmpRoot("folio-regress-")
})

after(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe("content folding and traversal", () => {
  it("matches Greek final sigma with full ECMAScript lowercase semantics", () => {
    const whole = content.firstMatch("ΟΣ", "ος", false)
    assert.ok(whole, "ΟΣ must case-insensitively contain ς via String.prototype.toLowerCase")
    assert.equal(whole.offset, 0)
    const embedded = content.firstMatch("aΟΣ tail", "ος", false)
    assert.ok(embedded)
    assert.equal(embedded.offset, 1)
  })

  it("keeps folded-offset mapping when a code point expands", () => {
    const match = content.firstMatch("xİy", "i\u0307", false)
    assert.ok(match)
    assert.equal(match.offset, 1)
  })

  it("collects string leaves beyond depth 100 without silent truncation", () => {
    const payload = deepObject(150, "needle-deep")
    const block = {
      view: "tools",
      type: "tool",
      locator: "content[0]",
      messageID: "msg_1",
      sessionID: "ses_1",
      timeCreated: 0,
      text: null,
      payload,
      render: [],
      orderKey: 0,
    }
    const items = content.blockSearchItems(block)
    assert.ok(items.some((item) => item.text === "needle-deep"), "deep string leaf must be collected")
  })
})

describe("store authority", () => {
  it("pure v2 with leftover message/part tables and no legacy session reads v2", () => {
    const file = path.join(root, "leftover.db")
    const db = makeDb(file, { v2: true })
    v2Session(db, { id: "ses_left", title: "Leftover", directory: "/left", timeCreated: 1, timeUpdated: 2 })
    v2Message(db, { id: "msg_left", sessionID: "ses_left", type: "user", seq: 1, timeCreated: 3, data: { text: "v2-authority", files: [], agents: [], time: { created: 3 } } })
    db.exec(`CREATE TABLE message (id text PRIMARY KEY, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL);`)
    db.exec(`CREATE TABLE part (id text PRIMARY KEY, message_id text NOT NULL, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL);`)
    ins(db, "message", { id: "msg_old", session_id: "ses_left", time_created: 4, time_updated: 4, data: JSON.stringify({ role: "user" }) })
    ins(db, "part", { id: "prt_old", message_id: "msg_old", session_id: "ses_left", time_created: 4, time_updated: 4, data: JSON.stringify({ type: "text", text: "legacy-leftover" }) })
    db.close()
    const list = runJson(["list", "--db", file])
    assert.equal(list.layout, "v2")
    const read = runJson(["read", "--db", file, "--session-id", "ses_left", "--out", outPath("leftover.md")])
    const text = fs.readFileSync(read.out, "utf8")
    assert.ok(text.includes("v2-authority"))
    assert.equal(text.includes("legacy-leftover"), false)
  })

  it("pre-split optional-session-title marker without session_v2 is unsupported", () => {
    const file = path.join(root, "presplit.db")
    const db = makeDb(file, { v1: true })
    v1Session(db, { id: "ses_pre", title: "Pre", directory: "/pre", timeCreated: 1, timeUpdated: 2 })
    v1Message(db, { id: "msg_pre", sessionID: "ses_pre", timeCreated: 3, role: "user", time: { created: 3 } })
    v1Part(db, { id: "prt_pre", sessionID: "ses_pre", messageID: "msg_pre", timeCreated: 3, type: "text", text: "pre-split-body" })
    db.exec(`CREATE TABLE migration (id text PRIMARY KEY, time_completed integer NOT NULL);`)
    ins(db, "migration", { id: "20260730195856_optional_session_title", time_completed: 1 })
    db.close()
    expectError(["list", "--db", file], "E_UNSUPPORTED_LAYOUT")
  })
})

describe("timestamp and cursor validation", () => {
  it("rejects normalized invalid calendar dates", () => {
    const file = path.join(root, "time.db")
    const db = makeDb(file, { v1: true })
    v1Session(db, { id: "ses_t", title: "T", directory: "/t", timeCreated: 1, timeUpdated: 2 })
    db.close()
    expectError(["list", "--db", file, "--from", "2026-02-30T00:00:00Z"], "E_USAGE")
    expectError(["list", "--db", file, "--until", "2026-13-01T00:00:00Z"], "E_USAGE")
    expectError(["list", "--db", file, "--from", "2026-10-04T24:00:00Z"], "E_USAGE")
    expectError(["list", "--db", file, "--from", "2026-10-04T00:00:00+25:00"], "E_USAGE")
    runJson(["list", "--db", file, "--from", "2024-02-29T00:00:00Z"])
  })

  it("rejects non-finite, unsafe, and fractional cursor anchors", () => {
    const file = path.join(root, "cursor.db")
    const db = makeDb(file, { v1: true })
    v1Session(db, { id: "ses_c1", title: "C1", directory: "/c", timeCreated: 1, timeUpdated: 100 })
    v1Session(db, { id: "ses_c2", title: "C2", directory: "/c", timeCreated: 2, timeUpdated: 200 })
    v1Message(db, { id: "msg_c1", sessionID: "ses_c1", timeCreated: 10, role: "user", time: { created: 10 } })
    v1Part(db, { id: "prt_c1", sessionID: "ses_c1", messageID: "msg_c1", timeCreated: 10, type: "text", text: "cursor-needle" })
    v1Message(db, { id: "msg_c2", sessionID: "ses_c2", timeCreated: 20, role: "user", time: { created: 20 } })
    v1Part(db, { id: "prt_c2", sessionID: "ses_c2", messageID: "msg_c2", timeCreated: 20, type: "text", text: "cursor-needle-two" })
    db.close()

    const listPage = runJson(["list", "--db", file, "--limit", "1"])
    const digest = cursorEnvelope(listPage.nextCursor).d
    expectError(["list", "--db", file, "--limit", "1", "--cursor", rawCursor(digest, `{"time":1e999,"id":"ses_c2"}`)], "E_CURSOR_INVALID")
    expectError(["list", "--db", file, "--limit", "1", "--cursor", rawCursor(digest, `{"time":9007199254740993,"id":"ses_c2"}`)], "E_CURSOR_INVALID")
    expectError(["list", "--db", file, "--limit", "1", "--cursor", rawCursor(digest, `{"time":100,"id":""}`)], "E_CURSOR_INVALID")

    const searchPage = runJson(["search", "--db", file, "cursor-needle", "--limit", "1"])
    const searchDigest = cursorEnvelope(searchPage.nextCursor).d
    expectError(
      ["search", "--db", file, "cursor-needle", "--limit", "1", "--cursor", rawCursor(searchDigest, `{"time":10,"sessionID":"ses_c1","messageID":"msg_c1","orderKey":-1}`)],
      "E_CURSOR_INVALID",
    )
    expectError(
      ["search", "--db", file, "cursor-needle", "--limit", "1", "--cursor", rawCursor(searchDigest, `{"time":10,"sessionID":"ses_c1","messageID":"msg_c1","orderKey":0.5}`)],
      "E_CURSOR_INVALID",
    )
    expectError(
      ["search", "--db", file, "cursor-needle", "--limit", "1", "--cursor", rawCursor(searchDigest, `{"time":10,"sessionID":"ses_c1","messageID":"","orderKey":0}`)],
      "E_CURSOR_INVALID",
    )
  })
})

describe("envelope budgets", () => {
  it("info previews a huge title and stays within 32768 stdout bytes", () => {
    const file = path.join(root, "huge-title.db")
    const db = makeDb(file, { v2: true })
    v2Session(db, { id: "ses_huge", title: "T".repeat(100000), directory: "/huge", timeCreated: 1, timeUpdated: 2 })
    db.close()
    const r = run(["info", "--db", file, "--session-id", "ses_huge"])
    assert.equal(r.status, 0, r.stdout)
    assert.ok(Buffer.byteLength(r.stdout, "utf8") <= 32768)
    const j = JSON.parse(r.stdout)
    assert.equal(j.session.titleTruncated, true)
    assert.ok([...j.session.title].length <= 256)
  })

  it("info returns a controlled E_BUDGET when native metadata cannot fit", () => {
    const file = path.join(root, "huge-model.db")
    const db = makeDb(file, { v2: true })
    v2Session(db, {
      id: "ses_model",
      title: "M",
      directory: "/m",
      timeCreated: 1,
      timeUpdated: 2,
      model: { id: "m", providerID: "p", blob: "Z".repeat(200000) },
    })
    db.close()
    expectError(["info", "--db", file, "--session-id", "ses_model"], "E_BUDGET")
  })

  it("read refuses E_BUDGET before creating a file when the receipt cannot fit", () => {
    const file = path.join(root, "many-ids.db")
    const db = makeDb(file, { v2: true })
    v2Session(db, { id: "ses_many", title: "Many", directory: "/many", timeCreated: 1, timeUpdated: 2 })
    const args = ["read", "--db", file, "--session-id", "ses_many"]
    for (let i = 0; i < 1200; i++) {
      // UTF-8 exceeds the receipt budget without exceeding Windows' UTF-16 command-line limit.
      const id = `m${i.toString(36)}${"界".repeat(8)}`
      v2Message(db, { id, sessionID: "ses_many", type: "user", seq: i, timeCreated: 10 + i, data: { text: `line ${i}`, files: [], agents: [], time: { created: 10 + i } } })
      args.push("--message-id", id)
    }
    db.close()
    const out = outPath("many-ids.md")
    args.push("--out", out)
    expectError(args, "E_BUDGET")
    assert.equal(fs.existsSync(out), false)
  })

  it("keeps the error envelope within 2048 bytes with a huge --db", () => {
    const huge = path.join(root, "d".repeat(10000) + ".db")
    const r = run(["list", "--db", huge])
    assert.equal(r.status, 1)
    assert.ok(Buffer.byteLength(r.stdout, "utf8") <= 2048)
    const j = JSON.parse(r.stdout)
    assert.equal(j.error.code, "E_DB_NOT_FOUND")
  })

  it("keeps the error envelope within 2048 bytes with a huge command", () => {
    const r = run(["x".repeat(10000)])
    assert.equal(r.status, 1)
    assert.ok(Buffer.byteLength(r.stdout, "utf8") <= 2048)
    const j = JSON.parse(r.stdout)
    assert.equal(j.error.code, "E_USAGE")
  })
})

describe("tool fidelity", () => {
  it("v2 tools preserve top-level time, executed and provider state", () => {
    const file = path.join(root, "tool-v2.db")
    const db = makeDb(file, { v2: true })
    v2Session(db, { id: "ses_tv2", title: "T", directory: "/t", timeCreated: 1, timeUpdated: 2 })
    v2Message(db, {
      id: "msg_tv2",
      sessionID: "ses_tv2",
      type: "assistant",
      seq: 1,
      timeCreated: 3,
      data: {
        agent: "build",
        model: { id: "m", providerID: "p" },
        content: [
          {
            type: "tool",
            id: "call_top",
            name: "vendor",
            executed: true,
            providerState: { vendorFlag: "provider-state-xyz" },
            providerResultState: { vendorResult: "result-abc" },
            state: { status: "completed", input: { q: "x" }, content: [{ type: "text", text: "ok" }], metadata: { m: 1 } },
            time: { created: 111, ran: 222, completed: 333 },
          },
        ],
        time: { created: 3, completed: 4 },
      },
    })
    db.close()
    const read = runJson(["read", "--db", file, "--session-id", "ses_tv2", "--include-tools", "--out", outPath("tool-v2.md")])
    const text = fs.readFileSync(read.out, "utf8")
    for (const present of ["provider-state-xyz", "result-abc", '"executed": true', '"ran": 222']) {
      assert.ok(text.includes(present), `v2 tool record missing: ${present}`)
    }
  })

  it("v1 tools preserve part.metadata and unknown top-level fields, and search finds their strings", () => {
    const file = path.join(root, "tool-v1.db")
    const db = makeDb(file, { v1: true })
    v1Session(db, { id: "ses_tv1", title: "T", directory: "/t", timeCreated: 1, timeUpdated: 2 })
    v1Message(db, { id: "msg_tv1", sessionID: "ses_tv1", timeCreated: 3, role: "assistant", time: { created: 3 }, parentID: "msg_x", modelID: "m", providerID: "p", mode: "build", agent: "build", path: { cwd: "/t", root: "/t" }, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } })
    v1Part(db, {
      id: "prt_tv1",
      sessionID: "ses_tv1",
      messageID: "msg_tv1",
      timeCreated: 3,
      type: "tool",
      callID: "call_tv1",
      tool: "vendor",
      metadata: { vendorMeta: "meta-xyz" },
      extraField: "extra-xyz",
      state: { status: "completed", input: { a: 1 }, output: "done" },
    })
    db.close()
    const read = runJson(["read", "--db", file, "--session-id", "ses_tv1", "--include-tools", "--out", outPath("tool-v1.md")])
    const text = fs.readFileSync(read.out, "utf8")
    assert.ok(text.includes("meta-xyz"), "v1 part.metadata must be preserved")
    assert.ok(text.includes("extra-xyz"), "v1 unknown top-level fields must be preserved")
    const found = runJson(["search", "--db", file, "meta-xyz", "--include-tools"])
    assert.equal(found.count, 1)
    assert.equal(found.hits[0].locator, "part:prt_tv1")
  })
})

describe("malformed known data", () => {
  it("rejects v1 text and reasoning parts without string text", () => {
    const file = path.join(root, "bad-text.db")
    const db = makeDb(file, { v1: true })
    v1Session(db, { id: "ses_bt", title: "B", directory: "/b", timeCreated: 1, timeUpdated: 2 })
    v1Message(db, { id: "msg_bt", sessionID: "ses_bt", timeCreated: 3, role: "user", time: { created: 3 } })
    v1Part(db, { id: "prt_bt", sessionID: "ses_bt", messageID: "msg_bt", timeCreated: 3, type: "text" })
    db.close()
    expectError(["read", "--db", file, "--session-id", "ses_bt"], "E_DATA")

    const file2 = path.join(root, "bad-reason.db")
    const db2 = makeDb(file2, { v1: true })
    v1Session(db2, { id: "ses_br", title: "R", directory: "/r", timeCreated: 1, timeUpdated: 2 })
    v1Message(db2, { id: "msg_br", sessionID: "ses_br", timeCreated: 3, role: "assistant", time: { created: 3 } })
    v1Part(db2, { id: "prt_br", sessionID: "ses_br", messageID: "msg_br", timeCreated: 3, type: "reasoning", text: 5 })
    db2.close()
    expectError(["read", "--db", file2, "--session-id", "ses_br"], "E_DATA")
  })

  it("rejects unknown v1 roles instead of treating them as body content", () => {
    const file = path.join(root, "bad-role.db")
    const db = makeDb(file, { v1: true })
    v1Session(db, { id: "ses_bro", title: "R", directory: "/r", timeCreated: 1, timeUpdated: 2 })
    v1Message(db, { id: "msg_bro", sessionID: "ses_bro", timeCreated: 3, role: "system", time: { created: 3 } })
    v1Part(db, { id: "prt_bro", sessionID: "ses_bro", messageID: "msg_bro", timeCreated: 3, type: "text", text: "should-not-be-body" })
    db.close()
    expectError(["read", "--db", file, "--session-id", "ses_bro"], "E_DATA")
  })

  it("rejects non-numeric required timestamps instead of fabricating 1970", () => {
    const file = path.join(root, "bad-time.db")
    const db = makeDb(file, { v1: true })
    v1Session(db, { id: "ses_bt2", title: "T", directory: "/t", timeCreated: 1, timeUpdated: 2 })
    ins(db, "message", { id: "msg_bt2", session_id: "ses_bt2", time_created: "abc", time_updated: 3, data: JSON.stringify({ role: "user", time: { created: 3 } }) })
    db.close()
    expectError(["read", "--db", file, "--session-id", "ses_bt2"], "E_DATA")

    const file2 = path.join(root, "bad-time-v2.db")
    const db2 = makeDb(file2, { v2: true })
    v2Session(db2, { id: "ses_bt3", title: "T", directory: "/t", timeCreated: 1, timeUpdated: 2 })
    ins(db2, "session_message", { id: "msg_bt3", session_id: "ses_bt3", type: "user", seq: 1, time_created: "abc", time_updated: 3, data: JSON.stringify({ text: "x", files: [], agents: [], time: { created: 3 } }) })
    db2.close()
    expectError(["read", "--db", file2, "--session-id", "ses_bt3"], "E_DATA")
  })
})

describe("transcript write primitives", () => {
  it("writeString loops partial writes and counts exact UTF-8 bytes", async () => {
    assert.equal(typeof transcript.writeString, "function", "writeString primitive must exist")
    const written = []
    const handle = {
      async write(buffer, offset = 0, length = buffer.length) {
        const take = Math.min(3, length)
        written.push(Buffer.from(buffer.subarray(offset, offset + take)))
        return { bytesWritten: take, buffer }
      },
    }
    const text = "héllo\u0000世界😀"
    const count = await transcript.writeString(handle, text)
    assert.equal(count, Buffer.byteLength(text, "utf8"))
    assert.equal(Buffer.concat(written).toString("utf8"), text)
  })

  it("removeIfOwned never deletes another actor's replacement", async () => {
    assert.equal(typeof transcript.removeIfOwned, "function", "removeIfOwned primitive must exist")
    const file = path.join(root, "owned.md")
    fs.writeFileSync(file, "original")
    const identity = transcript.identityOf(fs.lstatSync(file, { bigint: true }))
    fs.renameSync(file, `${file}.moved`)
    fs.writeFileSync(file, "replacement-by-other-actor")
    const removed = await transcript.removeIfOwned(file, identity)
    assert.equal(removed, false)
    assert.equal(fs.readFileSync(file, "utf8"), "replacement-by-other-actor")
    const replacementIdentity = transcript.identityOf(fs.lstatSync(file, { bigint: true }))
    assert.equal(await transcript.removeIfOwned(file, replacementIdentity), true)
    assert.equal(fs.existsSync(file), false)
  })

  it("closeStage removes the private stage and its directory when close fails", async () => {
    assert.equal(typeof transcript.closeStage, "function", "closeStage primitive must exist")
    const stageDir = fs.mkdtempSync(path.join(root, "close-fail-"))
    const stage = path.join(stageDir, "export.md")
    fs.writeFileSync(stage, "owned-partial")
    const identity = transcript.identityOf(fs.lstatSync(stage, { bigint: true }))
    const failing = {
      async close() {
        throw new Error("simulated close failure")
      },
    }
    await assert.rejects(() => transcript.closeStage(failing, stage, stageDir, identity), /close/i)
    assert.equal(fs.existsSync(stage), false)
    assert.equal(fs.existsSync(stageDir), false)
  })

  it("discardStage never deletes a substituted symlink and leaves the private stage dir", async () => {
    const stageDir = fs.mkdtempSync(path.join(root, "discard-"))
    const victim = path.join(root, "discard-victim.md")
    fs.writeFileSync(victim, "ours")
    const identity = transcript.identityOf(fs.lstatSync(victim, { bigint: true }))
    const stage = path.join(stageDir, "export.md")
    fs.renameSync(victim, `${victim}.moved`)
    fs.symlinkSync(`${victim}.moved`, stage)
    await transcript.discardStage(stage, stageDir, identity)
    assert.equal(fs.lstatSync(stage).isSymbolicLink(), true, "foreign symlink must survive")
    assert.equal(fs.readFileSync(`${victim}.moved`, "utf8"), "ours")
    assert.equal(fs.existsSync(stageDir), true, "non-empty private stage dir must not be force-removed")
    fs.rmSync(stageDir, { recursive: true, force: true })
  })
})
