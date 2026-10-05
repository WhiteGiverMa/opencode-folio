// Black-box CLI contract tests for opencode-folio.
// Every assertion drives bin/opencode-folio.js as a child process over
// synthetic SQLite fixtures; no real user store is opened.
import { after, before, describe, it } from "node:test"
import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import {
  fileHash,
  ins,
  kvSet,
  makeDb,
  tmpRoot,
  v1Message,
  v1Part,
  v1Session,
  v2Message,
  v2Session,
  writeMixedFixture,
  writeV1Fixture,
  writeV2EmptyBody,
  writeV2Fixture,
} from "./fixtures.mjs"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const BIN = path.join(ROOT, "bin", "opencode-folio.js")
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version

let root
let v1db
let v2db
let mixedCompleted
let mixedEmpty
let mixedNoMarker
let mixedSessions
let mixedInvalid

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

before(() => {
  root = tmpRoot("folio-cli-")
  v1db = writeV1Fixture(root)
  v2db = writeV2Fixture(root)
  mixedCompleted = writeMixedFixture(root, "mixed-completed.db", "completed")
  mixedEmpty = writeMixedFixture(root, "mixed-empty.db", "completed", { v2EmptyBody: true })
  mixedNoMarker = writeMixedFixture(root, "mixed-no-marker.db", null)
  mixedSessions = writeMixedFixture(root, "mixed-sessions.db", { phase: "sessions", cursor: "msg_x" })
  mixedInvalid = writeMixedFixture(root, "mixed-invalid.db", "not-json{{{")
})

after(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe("surface", () => {
  it("--help exits 0 without opening a database and documents all commands", () => {
    const r = run(["--help"])
    assert.equal(r.status, 0)
    for (const cmd of ["list", "read", "search", "info"]) assert.match(r.stdout, new RegExp(`\\b${cmd}\\b`))
    assert.match(r.stdout, /OPENCODE_SESSION_DB/)
    assert.match(r.stdout, /read-only/i)
  })

  it("--version prints the package version", () => {
    const r = run(["--version"])
    assert.equal(r.status, 0)
    assert.equal(r.stdout.trim(), VERSION)
  })

  it("unknown command and unknown option are usage errors", () => {
    expectError(["nope"], "E_USAGE")
    expectError(["list", "--nope"], "E_USAGE")
    expectError([], "E_USAGE")
  })
})

describe("path precedence and unsupported inputs", () => {
  it("missing --db database is not created and reports its absolute path", () => {
    const missing = path.join(root, "does", "not", "exist.db")
    const j = expectError(["list", "--db", missing], "E_DB_NOT_FOUND")
    assert.ok(j.db.endsWith(path.join("does", "not", "exist.db")))
    assert.equal(fs.existsSync(missing), false)
  })

  it("rejects :memory: and file: SQLite URIs", () => {
    expectError(["list", "--db", ":memory:"], "E_USAGE")
    expectError(["list", "--db", "file:///tmp/x.db?immutable=1"], "E_USAGE")
    expectError(["list", "--db", ""], "E_USAGE")
  })

  it("relative inherited OPENCODE_DB resolves under the OpenCode data root", () => {
    const dataHome = path.join(root, "xdg-data")
    const j = expectError(["list"], "E_DB_NOT_FOUND", { env: { XDG_DATA_HOME: dataHome, OPENCODE_DB: "rel.db" } })
    assert.equal(j.db, path.join(dataHome, "opencode", "rel.db"))
  })

  it("empty OPENCODE_DB counts as unset and falls back to the standard path", () => {
    const dataHome = path.join(root, "xdg-data2")
    const j = expectError(["list"], "E_DB_NOT_FOUND", { env: { XDG_DATA_HOME: dataHome, OPENCODE_DB: "" } })
    assert.equal(j.db, path.join(dataHome, "opencode", "opencode.db"))
  })

  it("OPENCODE_SESSION_DB resolves relative to the CLI cwd and --db wins over env", () => {
    const cwd = path.join(root, "cwd-relative")
    fs.mkdirSync(cwd, { recursive: true })
    fs.copyFileSync(v2db, path.join(cwd, "sess.db"))
    const j = runJson(["list"], { cwd, env: { OPENCODE_SESSION_DB: "./sess.db" } })
    assert.equal(j.layout, "v2")
    const j2 = runJson(["list", "--db", v2db], { env: { OPENCODE_SESSION_DB: path.join(root, "missing.db") } })
    assert.equal(j2.layout, "v2")
  })

  it("resolves a relative --db against the CLI cwd", () => {
    const cwd = path.join(root, "cwd-explicit")
    fs.mkdirSync(cwd, { recursive: true })
    fs.copyFileSync(v1db, path.join(cwd, "rel-v1.db"))
    const j = runJson(["list", "--db", "./rel-v1.db"], { cwd })
    assert.equal(j.layout, "v1")
    assert.equal(j.db, path.join(cwd, "rel-v1.db"))
  })

  it("empty SQLite without a supported schema is unsupported, not an empty v2 store", () => {
    const empty = path.join(root, "empty.db")
    fs.writeFileSync(empty, "")
    makeDb(empty).close()
    expectError(["list", "--db", empty], "E_UNSUPPORTED_LAYOUT")
  })

  it("partial session_v2 without session_message is unsupported", () => {
    const partial = path.join(root, "partial.db")
    const db = makeDb(partial)
    db.exec(`CREATE TABLE session_v2 (id text PRIMARY KEY, project_id text NOT NULL, slug text NOT NULL, directory text NOT NULL, version text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL);`)
    db.close()
    expectError(["list", "--db", partial], "E_UNSUPPORTED_LAYOUT")
  })
})

describe("authority selection", () => {
  it("v1 layout reads message/part and ignores the session_message shadow projection", () => {
    const list = runJson(["list", "--db", v1db])
    assert.equal(list.layout, "v1")
    assert.deepEqual(list.sessions.map((s) => s.id).sort(), ["ses_child", "ses_main", "ses_win"])

    const read = runJson(["read", "--db", v1db, "--session-id", "ses_main", "--out", outPath("v1-main.md")])
    const text = fs.readFileSync(read.out, "utf8")
    assert.ok(text.includes("Hello \u0130stanbul"))
    assert.equal(text.includes("SHADOW-PROJECTION-MUST-NOT-APPEAR"), false)

    const search = runJson(["search", "--db", v1db, "SHADOW-PROJECTION"])
    assert.equal(search.count, 0)
  })

  it("completed mixed import uses v2 as sole authority for every command", () => {
    const list = runJson(["list", "--db", mixedCompleted])
    assert.equal(list.layout, "v2")
    assert.deepEqual(list.sessions.map((s) => s.title), ["AUTHORITY-TITLE"])

    const read = runJson(["read", "--db", mixedCompleted, "--session-id", "ses_mix", "--out", outPath("mixed.md")])
    const text = fs.readFileSync(read.out, "utf8")
    assert.ok(text.includes("MIXED-AUTHORITY-TEXT"))
    assert.equal(text.includes("LEGACY-MARKER-TEXT"), false)

    assert.equal(runJson(["search", "--db", mixedCompleted, "LEGACY-MARKER"]).count, 0)
    assert.equal(runJson(["search", "--db", mixedCompleted, "MIXED-AUTHORITY"]).count, 1)
    const info = runJson(["info", "--db", mixedCompleted, "--session-id", "ses_mix"])
    assert.equal(info.layout, "v2")
    assert.equal(info.session.title, "AUTHORITY-TITLE")
  })

  it("an empty v2 body view never revives overlapping legacy rows", () => {
    const read = runJson(["read", "--db", mixedEmpty, "--session-id", "ses_mix", "--out", outPath("mixed-empty.md")])
    const text = fs.readFileSync(read.out, "utf8")
    assert.equal(text.includes("LEGACY-MARKER-TEXT"), false)
    assert.equal(runJson(["search", "--db", mixedEmpty, "LEGACY-MARKER"]).count, 0)
    assert.equal(runJson(["search", "--db", mixedEmpty, "MIXED"]).count, 0)
  })

  for (const [name, fixture] of [
    ["unmarked", "mixedNoMarker"],
    ["in-progress", "mixedSessions"],
    ["invalid", "mixedInvalid"],
  ]) {
    it(`overlapping layout with ${name} migration state fails closed on all commands`, () => {
      const file = { mixedNoMarker, mixedSessions, mixedInvalid }[fixture]
      expectError(["list", "--db", file], "E_AMBIGUOUS_LAYOUT")
      expectError(["read", "--db", file, "--session-id", "ses_mix"], "E_AMBIGUOUS_LAYOUT")
      expectError(["search", "--db", file, "x"], "E_AMBIGUOUS_LAYOUT")
      expectError(["info", "--db", file, "--session-id", "ses_mix"], "E_AMBIGUOUS_LAYOUT")
    })
  }
})

describe("v1 default body view and fidelity", () => {
  it("read exports user/assistant text in native order with locators and excludes flagged content", () => {
    const read = runJson(["read", "--db", v1db, "--session-id", "ses_main", "--out", outPath("v1-default.md")])
    assert.equal(read.messages, 3)
    assert.equal(read.blocks, 5)
    const text = fs.readFileSync(read.out, "utf8")
    assert.ok(text.includes("Hello \u0130stanbul %_ done \u0000 \u4e16\u754c \ud83d\ude00"))
    assert.ok(text.includes("second user line"))
    assert.ok(text.includes("Assistant body \u03b1"))
    assert.ok(text.includes("needle-first") && text.includes("needle-second"))
    assert.ok(text.indexOf("Hello") < text.indexOf("second user line"))
    assert.ok(text.indexOf("needle-first") < text.indexOf("needle-second"))
    assert.ok(text.includes("## user msg_u1") || text.includes("## User msg_u1"))
    assert.ok(text.includes("locator=part:prt_u1_text"))
    // default exclusions
    for (const absent of [
      "SYNTHETIC-NOT-DEFAULT",
      "IGNORED-NOT-DEFAULT",
      "REASONING-ONLY",
      "SUMMARY-COMPACTED-CONTENT",
      "STORED-SYSTEM-PROMPT",
      "partial raw",
      "hi\n",
      "boom",
    ]) {
      assert.equal(text.includes(absent), false, `default view leaked: ${absent}`)
    }
  })

  it("preserves raw NUL and supplementary-plane text in the exported bytes", () => {
    const read = runJson(["read", "--db", v1db, "--session-id", "ses_main", "--out", outPath("v1-nul.md")])
    const bytes = fs.readFileSync(read.out)
    assert.ok(bytes.includes(0x00), "exported bytes must contain the raw NUL")
    assert.ok(bytes.includes(Buffer.from("\ud83d\ude00", "utf8")))
  })

  it("opt-in views preserve tools, reasoning, injected, system, and compaction records", () => {
    const tools = runJson(["read", "--db", v1db, "--session-id", "ses_main", "--include-tools", "--out", outPath("v1-tools.md")])
    const t = fs.readFileSync(tools.out, "utf8")
    for (const present of ["call_abc", "call_def", "call_ghi", "echo hi", "hi\n", "boom", "partial raw", "x.txt", "attachments", "pending"]) {
      assert.ok(t.includes(present), `tools view missing: ${present}`)
    }
    assert.ok(t.includes("````"), "fences must expand around embedded triple backticks")
    assert.equal(t.includes("SYNTHETIC-NOT-DEFAULT"), false)

    const reasoning = runJson(["read", "--db", v1db, "--session-id", "ses_main", "--include-reasoning", "--out", outPath("v1-reasoning.md")])
    assert.ok(fs.readFileSync(reasoning.out, "utf8").includes("REASONING-ONLY"))

    const injected = runJson(["read", "--db", v1db, "--session-id", "ses_main", "--include-injected", "--out", outPath("v1-injected.md")])
    const i = fs.readFileSync(injected.out, "utf8")
    assert.ok(i.includes("SYNTHETIC-NOT-DEFAULT") && i.includes("IGNORED-NOT-DEFAULT") && i.includes("a.png"))

    const system = runJson(["read", "--db", v1db, "--session-id", "ses_main", "--include-system", "--out", outPath("v1-system.md")])
    assert.ok(fs.readFileSync(system.out, "utf8").includes("STORED-SYSTEM-PROMPT"))

    const comp = runJson(["read", "--db", v1db, "--session-id", "ses_main", "--include-compaction", "--out", outPath("v1-comp.md")])
    const c = fs.readFileSync(comp.out, "utf8")
    assert.ok(c.includes("SUMMARY-COMPACTED-CONTENT"))
    assert.ok(c.includes("compaction"))
  })
})

describe("v2 default body view and fidelity", () => {
  it("read uses scalar user text and original assistant content indices", () => {
    const read = runJson(["read", "--db", v2db, "--session-id", "ses_v2", "--out", outPath("v2-default.md")])
    const text = fs.readFileSync(read.out, "utf8")
    assert.ok(text.includes("V2 user text with needle-one"))
    assert.ok(text.includes("V2 body text needle-two"))
    assert.ok(text.includes("V2 tail text"))
    assert.ok(text.includes("V2 second user line"))
    assert.ok(text.includes("locator=text"))
    assert.ok(text.includes("locator=content[1]"))
    assert.ok(text.includes("locator=content[6]"))
    for (const absent of [
      "V2 REASONING-ONLY",
      "SYNTHETIC-NOT-DEFAULT",
      "STORED-SYSTEM",
      "SKILL-TEXT",
      "COMPACTION-SUMMARY",
      "partial",
      "a\nb\n",
      "call_v2_done",
    ]) {
      assert.equal(text.includes(absent), false, `default view leaked: ${absent}`)
    }
  })

  it("v2 opt-ins preserve streaming input, typed content, opaque errors, files and shell output", () => {
    const tools = runJson(["read", "--db", v2db, "--session-id", "ses_v2", "--include-tools", "--out", outPath("v2-tools.md")])
    const t = fs.readFileSync(tools.out, "utf8")
    for (const present of [
      "call_v2_stream",
      "call_v2_done",
      "call_v2_err",
      "partial",
      "done",
      "out.png",
      "partial content before error",
      "oops",
      "deep",
      "nested",
      "a\nb\n",
      "sh_1",
      "noop",
    ]) {
      assert.ok(t.includes(present), `v2 tools view missing: ${present}`)
    }
    assert.ok(t.includes('""'), "empty content string must be preserved")

    const reasoning = runJson(["read", "--db", v2db, "--session-id", "ses_v2", "--include-reasoning", "--out", outPath("v2-reasoning.md")])
    assert.ok(fs.readFileSync(reasoning.out, "utf8").includes("V2 REASONING-ONLY"))

    const injected = runJson(["read", "--db", v2db, "--session-id", "ses_v2", "--include-injected", "--out", outPath("v2-injected.md")])
    const i = fs.readFileSync(injected.out, "utf8")
    for (const present of ["SYNTHETIC-NOT-DEFAULT", "SKILL-TEXT", "a.png", "build"]) {
      assert.ok(i.includes(present), `v2 injected view missing: ${present}`)
    }

    const system = runJson(["read", "--db", v2db, "--session-id", "ses_v2", "--include-system", "--out", outPath("v2-system.md")])
    const s = fs.readFileSync(system.out, "utf8")
    for (const present of ["STORED-SYSTEM", "succeeded", "agent-switched"]) {
      assert.ok(s.includes(present), `v2 system view missing: ${present}`)
    }

    const comp = runJson(["read", "--db", v2db, "--session-id", "ses_v2", "--include-compaction", "--out", outPath("v2-comp.md")])
    assert.ok(fs.readFileSync(comp.out, "utf8").includes("COMPACTION-SUMMARY"))
  })
})

describe("list", () => {
  it("orders by session updated time descending by default and includes children", () => {
    const j = runJson(["list", "--db", v1db])
    assert.deepEqual(j.sessions.map((s) => s.id), ["ses_child", "ses_main", "ses_win"])
    const child = j.sessions.find((s) => s.id === "ses_child")
    assert.equal(child.parentID, "ses_main")
    assert.equal(child.directory, "/home/user/project/sub")
  })

  it("supports asc order, parent/project filters, and normalized Windows separators", () => {
    const asc = runJson(["list", "--db", v1db, "--order", "asc"])
    assert.deepEqual(asc.sessions.map((s) => s.id), ["ses_win", "ses_main", "ses_child"])

    const byParent = runJson(["list", "--db", v1db, "--parent", "ses_main"])
    assert.deepEqual(byParent.sessions.map((s) => s.id), ["ses_child"])

    const byProject = runJson(["list", "--db", v1db, "--project", "C:/work/proj"])
    assert.deepEqual(byProject.sessions.map((s) => s.id), ["ses_win"])
    assert.equal(byProject.sessions[0].directory, "C:\\work\\proj")

    const trailing = runJson(["list", "--db", v1db, "--project", "C:/work/proj/"])
    assert.deepEqual(trailing.sessions.map((s) => s.id), ["ses_win"])
  })

  it("applies [from,until) against session updated time", () => {
    const from = runJson(["list", "--db", v1db, "--from", "1970-01-01T00:00:02.050Z"])
    assert.deepEqual(from.sessions.map((s) => s.id), ["ses_child"])
    const until = runJson(["list", "--db", v1db, "--until", "1970-01-01T00:00:02.050Z"])
    assert.deepEqual(until.sessions.map((s) => s.id), ["ses_main", "ses_win"])
    const bounded = runJson(["list", "--db", v1db, "--from", "1970-01-01T00:00:02.000Z", "--until", "1970-01-01T00:00:02.100Z"])
    assert.deepEqual(bounded.sessions.map((s) => s.id), ["ses_main"])
  })

  it("pages with a bound keyset cursor and rejects a cursor from another database", () => {
    const page1 = runJson(["list", "--db", v1db, "--limit", "2"])
    assert.equal(page1.sessions.length, 2)
    assert.equal(page1.truncated, true)
    assert.ok(page1.nextCursor)
    const page2 = runJson(["list", "--db", v1db, "--limit", "2", "--cursor", page1.nextCursor])
    assert.deepEqual(page2.sessions.map((s) => s.id), ["ses_win"])
    assert.equal(page2.nextCursor, null)
    expectError(["list", "--db", v2db, "--limit", "2", "--cursor", page1.nextCursor], "E_CURSOR_MISMATCH")
  })

  it("validates limit bounds and required order values", () => {
    expectError(["list", "--db", v1db, "--limit", "0"], "E_USAGE")
    expectError(["list", "--db", v1db, "--limit", "1001"], "E_USAGE")
    expectError(["list", "--db", v1db, "--limit", "abc"], "E_USAGE")
    expectError(["list", "--db", v1db, "--order", "sideways"], "E_USAGE")
    runJson(["list", "--db", v1db, "--limit", "1000"])
  })
})

describe("search", () => {
  it("matches literal substrings case-insensitively by default", () => {
    const j = runJson(["search", "--db", v1db, "HELLO"])
    assert.equal(j.count, 1)
    assert.equal(j.hits[0].sessionID, "ses_main")
    assert.equal(j.hits[0].messageID, "msg_u1")
    assert.equal(j.hits[0].locator, "part:prt_u1_text")
    assert.ok(j.hits[0].snippet.startsWith("Hello \u0130stanbul"))
  })

  it("treats % and _ literally and honors --case-sensitive", () => {
    assert.equal(runJson(["search", "--db", v1db, "%_"]).count, 1)
    assert.equal(runJson(["search", "--db", v1db, "hello"]).count, 1)
    assert.equal(runJson(["search", "--db", v1db, "hello", "--case-sensitive"]).count, 0)
    assert.equal(runJson(["search", "--db", v1db, "Hello", "--case-sensitive"]).count, 1)
  })

  it("folds with ECMAScript toLowerCase and maps snippets back to original offsets", () => {
    const dotted = runJson(["search", "--db", v1db, "i\u0307"])
    assert.equal(dotted.count, 1)
    assert.equal(dotted.hits[0].matchOffset, 6)
    assert.ok(dotted.hits[0].snippet.startsWith("\u0130stanbul"))
    // "istanbul" is not a substring of the folded text: no fake normalization.
    assert.equal(runJson(["search", "--db", v1db, "istanbul"]).count, 0)
  })

  it("returns one hit per block with original order and supports block-level pagination", () => {
    const all = runJson(["search", "--db", v1db, "needle"])
    assert.deepEqual(all.hits.map((h) => h.locator), ["part:prt_a1_text3", "part:prt_a1_text2", "part:prt_c1_text"])
    const p1 = runJson(["search", "--db", v1db, "needle", "--limit", "1"])
    assert.equal(p1.count, 1)
    assert.equal(p1.hits[0].locator, "part:prt_a1_text3")
    assert.equal(p1.truncated, true)
    const p2 = runJson(["search", "--db", v1db, "needle", "--limit", "1", "--cursor", p1.nextCursor])
    assert.equal(p2.hits[0].locator, "part:prt_a1_text2")
    const p3 = runJson(["search", "--db", v1db, "needle", "--limit", "1", "--cursor", p2.nextCursor])
    assert.equal(p3.hits[0].locator, "part:prt_c1_text")
    assert.equal(p3.nextCursor, null)
    assert.equal(p3.truncated, false)
  })

  it("scopes by session, project, and [from,until) message creation time", () => {
    const scoped = runJson(["search", "--db", v2db, "needle", "--session-id", "ses_v2"])
    assert.deepEqual(scoped.hits.map((h) => h.messageID), ["msg_v2_a1", "msg_v2_u1"])
    const childOnly = runJson(["search", "--db", v1db, "needle", "--parent", "ses_main"])
    assert.deepEqual(childOnly.hits.map((h) => h.messageID), ["msg_c1"])
    const byProject = runJson(["search", "--db", v1db, "needle", "--project", "C:/work/proj"])
    assert.equal(byProject.count, 0)
    const bounded = runJson(["search", "--db", v2db, "needle", "--from", "1970-01-01T00:00:05.100Z", "--until", "1970-01-01T00:00:05.600Z"])
    assert.deepEqual(bounded.hits.map((h) => h.messageID), ["msg_v2_a1"])
  })

  it("locates v2 blocks by real content indices and preserves hit identity fields", () => {
    const j = runJson(["search", "--db", v2db, "needle-two"])
    assert.equal(j.count, 1)
    assert.equal(j.hits[0].locator, "content[1]")
    assert.equal(j.hits[0].messageID, "msg_v2_a1")
    assert.equal(j.hits[0].blockType, "text")
  })

  it("finds tool and injected strings only when their views are enabled", () => {
    assert.equal(runJson(["search", "--db", v1db, "echo hi"]).count, 0)
    const tool = runJson(["search", "--db", v1db, "echo hi", "--include-tools"])
    assert.equal(tool.count, 1)
    assert.equal(tool.hits[0].locator, "part:prt_a1_tool")
    assert.equal(tool.hits[0].callID, "call_abc")
    assert.equal(runJson(["search", "--db", v1db, "SYNTHETIC-NOT-DEFAULT"]).count, 0)
    const injected = runJson(["search", "--db", v1db, "SYNTHETIC-NOT-DEFAULT", "--include-injected"])
    assert.equal(injected.count, 1)
    assert.equal(injected.hits[0].locator, "part:prt_u1_synth")
  })

  it("bounded query preview and JSON budget hold for huge inputs", () => {
    const huge = "x".repeat(10000)
    const j = runJson(["search", "--db", v1db, huge])
    assert.ok(Buffer.byteLength(JSON.stringify(j), "utf8") <= 32768)
    assert.ok(j.query.length <= 256)
    assert.equal(j.queryTruncated, true)
  })
})

describe("read filters, outputs and receipts", () => {
  it("filters by --message-id and fails on missing messages or sessions", () => {
    const j = runJson(["read", "--db", v1db, "--session-id", "ses_main", "--message-id", "msg_a1", "--out", outPath("only-a1.md")])
    const text = fs.readFileSync(j.out, "utf8")
    assert.ok(text.includes("Assistant body"))
    assert.equal(text.includes("second user line"), false)
    expectError(["read", "--db", v1db, "--session-id", "ses_main", "--message-id", "msg_missing"], "E_MESSAGE_NOT_FOUND")
    expectError(["read", "--db", v1db, "--session-id", "ses_missing"], "E_SESSION_NOT_FOUND")
  })

  it("never overwrites an existing file or a symlink", () => {
    const target = outPath("v1-fixed.md")
    const first = runJson(["read", "--db", v1db, "--session-id", "ses_main", "--out", target])
    const before = fileHash(target)
    expectError(["read", "--db", v1db, "--session-id", "ses_main", "--out", target], "E_OUT_EXISTS")
    assert.equal(fileHash(target), before)

    const real = outPath("real-target.md")
    fs.writeFileSync(real, "keep me")
    const link = outPath("link.md")
    fs.symlinkSync(real, link)
    expectError(["read", "--db", v1db, "--session-id", "ses_main", "--out", link], "E_OUT_EXISTS")
    assert.equal(fs.readFileSync(real, "utf8"), "keep me")
    assert.equal(first.out, target)
  })

  it("writes unique default exports to the cache dir or OPENCODE_SESSION_EXPORT_DIR", () => {
    const cache = path.join(root, "cache-home")
    const j1 = runJson(["read", "--db", v1db, "--session-id", "ses_main"], { env: { XDG_CACHE_HOME: cache } })
    const j2 = runJson(["read", "--db", v1db, "--session-id", "ses_main"], { env: { XDG_CACHE_HOME: cache } })
    assert.ok(j1.out.startsWith(path.join(cache, "opencode-folio", "exports") + path.sep))
    assert.notEqual(j1.out, j2.out)
    assert.ok(fs.existsSync(j1.out) && fs.existsSync(j2.out))

    const envDir = path.join(root, "env-exports")
    const j3 = runJson(["read", "--db", v1db, "--session-id", "ses_main"], { env: { OPENCODE_SESSION_EXPORT_DIR: envDir } })
    assert.ok(j3.out.startsWith(envDir + path.sep))
    assert.ok(fs.existsSync(j3.out))
  })

  it("does not modify the source database and creates no sidecars", () => {
    const db = path.join(root, "readonly-v1.db")
    fs.copyFileSync(v1db, db)
    const beforeHash = fileHash(db)
    const beforeMtime = fs.statSync(db).mtimeMs
    runJson(["list", "--db", db])
    runJson(["list", "--db", db])
    runJson(["search", "--db", db, "needle"])
    runJson(["info", "--db", db, "--session-id", "ses_main"])
    runJson(["read", "--db", db, "--session-id", "ses_main", "--include-tools"])
    assert.equal(fileHash(db), beforeHash)
    assert.equal(fs.statSync(db).mtimeMs, beforeMtime)
    assert.equal(fs.existsSync(db + "-wal"), false)
    assert.equal(fs.existsSync(db + "-shm"), false)
  })

  it("concurrent reads to the same --out allow at most one success", async () => {
    const big = path.join(root, "big.db")
    const db = makeDb(big, { v2: true })
    v2Session(db, { id: "ses_big", title: "Big", directory: "/big", timeCreated: 1, timeUpdated: 2 })
    for (let i = 0; i < 400; i++) {
      v2Message(db, {
        id: `msg_big_${String(i).padStart(4, "0")}`,
        sessionID: "ses_big",
        type: "user",
        seq: i,
        timeCreated: 10 + i,
        data: { text: `line ${i} ${"z".repeat(200)}`, files: [], agents: [], time: { created: 10 + i } },
      })
    }
    db.close()
    const target = outPath("concurrent.md")
    const spawnOne = () =>
      new Promise((resolve) => {
        const child = spawn(process.execPath, [BIN, "read", "--db", big, "--session-id", "ses_big", "--out", target], {
          cwd: root,
          env: cleanEnv(),
        })
        child.on("close", (code) => resolve(code))
      })
    const codes = await Promise.all([spawnOne(), spawnOne()])
    assert.equal(codes.filter((c) => c === 0).length, 1)
    assert.ok(fs.existsSync(target))
  })

  it("receipt reports session, counts, view and absolute source paths", () => {
    const j = runJson(["read", "--db", v1db, "--session-id", "ses_main", "--out", outPath("receipt.md")])
    assert.equal(j.ok, true)
    assert.equal(j.command, "read")
    assert.equal(j.sessionID, "ses_main")
    assert.equal(j.layout, "v1")
    assert.equal(j.db, v1db)
    assert.ok(j.out.endsWith("receipt.md"))
    assert.equal(j.messages, 3)
    assert.equal(j.blocks, 5)
    assert.ok(j.outBytes > 0)
  })
})

describe("info", () => {
  it("reports native metadata and counts without dumping body text", () => {
    const r = run(["info", "--db", v1db, "--session-id", "ses_main"])
    assert.equal(r.status, 0)
    const j = JSON.parse(r.stdout)
    assert.equal(j.session.id, "ses_main")
    assert.equal(j.session.title, "Main Session")
    assert.equal(j.session.parentID, null)
    assert.equal(j.session.directory, "/home/user/project")
    assert.equal(j.counts.messages, 4)
    assert.equal(j.counts.blocks, 14)
    assert.equal(r.stdout.includes("Hello"), false)
    assert.equal(r.stdout.includes("Assistant body"), false)
  })

  it("reports v2 counts by native type and child parentage", () => {
    const j = runJson(["info", "--db", v2db, "--session-id", "ses_v2"])
    assert.equal(j.session.parentID, null)
    assert.equal(j.counts.messages, 10)
    assert.equal(j.counts.byType.user, 2)
    assert.equal(j.counts.byType.assistant, 1)
    const child = runJson(["info", "--db", v2db, "--session-id", "ses_v2_child"])
    assert.equal(child.session.parentID, "ses_v2")
  })

  it("reports a missing session explicitly", () => {
    expectError(["info", "--db", v1db, "--session-id", "ses_missing"], "E_SESSION_NOT_FOUND")
  })
})

describe("output budgets", () => {
  it("keeps list JSON under 32KiB with complete objects, markers and a working cursor", () => {
    const budget = path.join(root, "budget.db")
    const db = makeDb(budget, { v2: true })
    for (let i = 0; i < 200; i++) {
      v2Session(db, {
        id: `ses_b_${String(i).padStart(3, "0")}`,
        title: `title-${i}-` + "t".repeat(3000),
        directory: "/budget",
        timeCreated: 1000 + i,
        timeUpdated: 2000 + i,
      })
    }
    db.close()
    const r = run(["list", "--db", budget, "--limit", "1000"])
    assert.equal(r.status, 0)
    assert.ok(Buffer.byteLength(r.stdout, "utf8") <= 32768)
    const j = JSON.parse(r.stdout)
    assert.equal(j.truncated, true)
    assert.ok(j.sessions.length > 0 && j.sessions.length < 200)
    assert.ok(j.nextCursor)
    for (const s of j.sessions) {
      assert.ok(s.id && typeof s.id === "string")
      assert.equal(s.titleTruncated, true)
      assert.ok([...s.title].length <= 256)
    }
    const p2 = runJson(["list", "--db", budget, "--cursor", j.nextCursor])
    const ids1 = new Set(j.sessions.map((s) => s.id))
    assert.equal(p2.sessions.some((s) => ids1.has(s.id)), false)
  })
})

describe("robustness and lifecycle", () => {
  it("reads a WAL-mode store while a writer connection holds the sidecars", () => {
    const file = path.join(root, "wal.db")
    const db = makeDb(file, { v1: true, wal: true })
    v1Session(db, { id: "ses_wal", title: "WAL", directory: "/wal", timeCreated: 1, timeUpdated: 2 })
    v1Message(db, { id: "msg_wal", sessionID: "ses_wal", timeCreated: 3, role: "user", time: { created: 3 } })
    v1Part(db, { id: "prt_wal", sessionID: "ses_wal", messageID: "msg_wal", timeCreated: 3, type: "text", text: "wal-body" })
    try {
      const list = runJson(["list", "--db", file])
      assert.equal(list.layout, "v1")
      const read = runJson(["read", "--db", file, "--session-id", "ses_wal", "--out", outPath("wal.md")])
      assert.equal(read.messages, 1)
      assert.ok(fs.readFileSync(read.out, "utf8").includes("wal-body"))
    } finally {
      db.close()
    }
  })

  it("read time filters use message creation time and report the applied window", () => {
    const j = runJson([
      "read",
      "--db",
      v1db,
      "--session-id",
      "ses_main",
      "--from",
      "1970-01-01T00:00:01.300Z",
      "--until",
      "1970-01-01T00:00:01.400Z",
      "--out",
      outPath("window.md"),
    ])
    assert.equal(j.messages, 1)
    assert.equal(j.blocks, 3)
    assert.equal(j.filters.from, "1970-01-01T00:00:01.300Z")
    assert.equal(j.filters.until, "1970-01-01T00:00:01.400Z")
    const text = fs.readFileSync(j.out, "utf8")
    assert.ok(text.includes("Assistant body"))
    assert.equal(text.includes("second user line"), false)
  })

  it("keeps every error envelope valid and under 2KiB even for huge inputs", () => {
    const huge = "x".repeat(10000)
    const r = run(["info", "--db", v1db, "--session-id", huge])
    assert.equal(r.status, 1)
    assert.ok(Buffer.byteLength(r.stdout, "utf8") <= 2048)
    const j = JSON.parse(r.stdout)
    assert.equal(j.error.code, "E_SESSION_NOT_FOUND")
  })

  it("rejects malformed cursors", () => {
    expectError(["list", "--db", v1db, "--cursor", "not-json"], "E_CURSOR_INVALID")
  })

  it("fails explicitly on malformed JSON rows and removes its partial export", () => {
    const malformed = path.join(root, "malformed.db")
    const db = makeDb(malformed, { v1: true })
    v1Session(db, { id: "ses_bad", title: "Bad", directory: "/bad", timeCreated: 1, timeUpdated: 2 })
    ins(db, "message", { id: "msg_bad", session_id: "ses_bad", time_created: 3, time_updated: 3, data: "{oops" })
    db.close()
    const out = outPath("malformed.md")
    expectError(["read", "--db", malformed, "--session-id", "ses_bad", "--out", out], "E_DATA")
    assert.equal(fs.existsSync(out), false)
    expectError(["search", "--db", malformed, "oops"], "E_DATA")
    expectError(["info", "--db", malformed, "--session-id", "ses_bad"], "E_DATA")
  })

  it("search with an unknown --session-id fails instead of reporting a false empty scope", () => {
    expectError(["search", "--db", v1db, "x", "--session-id", "ses_missing"], "E_SESSION_NOT_FOUND")
  })
})
