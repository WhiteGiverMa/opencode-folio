// Failing-first regressions for the seven independently audited core blockers:
// NUL-faithful TEXT reads, native failed compaction, exclusive staging, real
// search locators, malformed optional shapes, nonmonotonic JSON fit, and
// sub-millisecond ISO precision. Every assertion drives the real CLI or the
// real staging seam over self-owned synthetic fixtures.
import { after, before, describe, it } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { identityOf, removeIfOwned } from "../dist/transcript.js"
import * as transcript from "../dist/transcript.js"
import { FolioError } from "../dist/errors.js"
import {
  ins,
  kvSet,
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
  assert.equal(j.error.code, code, `unexpected error: ${r.stdout}`)
  return j
}

function outPath(name) {
  return path.join(root, "out", name)
}

before(() => {
  root = tmpRoot("folio-audit-blockers-")
})

after(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe("blocker 1: literal NUL in SQLite TEXT is never truncated", () => {
  it("rejects a completed migration marker with a NUL-appended invalid suffix", () => {
    const file = path.join(root, "nul-marker.db")
    const db = makeDb(file, { v1: true, v2: true, kv: true })
    v1Session(db, { id: "ses_probe", title: "Legacy", directory: "/synthetic", timeCreated: 1, timeUpdated: 2 })
    v2Session(db, { id: "ses_probe", title: "Native", directory: "/synthetic", timeCreated: 1, timeUpdated: 2 })
    kvSet(db, "migration.v1-v2", '{"phase":"completed"}\u0000INVALID')
    db.close()
    expectError(["list", "--db", file], "E_AMBIGUOUS_LAYOUT")
  })

  it("rejects raw row JSON with an invalid NUL-appended suffix", () => {
    const file = path.join(root, "nul-row.db")
    const db = makeDb(file, { v2: true })
    v2Session(db, { id: "ses_probe", title: "S", directory: "/synthetic", timeCreated: 1, timeUpdated: 2 })
    ins(db, "session_message", {
      id: "msg_probe",
      session_id: "ses_probe",
      type: "user",
      seq: 1,
      time_created: 3,
      time_updated: 3,
      data: '{"text":"needle"}\u0000TRAILING',
    })
    db.close()
    expectError(["search", "--db", file, "needle"], "E_DATA")
    expectError(["read", "--db", file, "--session-id", "ses_probe"], "E_DATA")
  })

  it("preserves NUL bytes in native title, directory and v1 part identifiers", () => {
    const file = path.join(root, "nul-native.db")
    const db = makeDb(file, { v1: true })
    v1Session(db, {
      id: "ses_nul",
      title: "before\u0000AFTER",
      directory: "/dir\u0000tail",
      timeCreated: 1,
      timeUpdated: 2,
    })
    v1Message(db, { id: "msg_nul", sessionID: "ses_nul", timeCreated: 3, role: "user", time: { created: 3 } })
    v1Part(db, { id: "prt_before\u0000AFTER", sessionID: "ses_nul", messageID: "msg_nul", timeCreated: 3, type: "text", text: "needle" })
    db.close()

    const listed = runJson(["list", "--db", file])
    assert.equal(listed.sessions[0].title, "before\u0000AFTER")
    assert.equal(listed.sessions[0].directory, "/dir\u0000tail")
    assert.equal(listed.sessions[0].id, "ses_nul")

    const raw = run(["list", "--db", file])
    assert.ok(raw.stdout.includes("before\\u0000AFTER"), "JSON receipt must escape the full raw NUL title")

    const searched = runJson(["search", "--db", file, "needle"])
    assert.equal(searched.count, 1)
    assert.equal(searched.hits[0].locator, "part:prt_before\u0000AFTER")
    assert.equal(searched.hits[0].messageID, "msg_nul")

    const read = runJson(["read", "--db", file, "--session-id", "ses_nul", "--out", outPath("nul-native.md")])
    const bytes = fs.readFileSync(read.out)
    assert.ok(bytes.includes(Buffer.from("before\u0000AFTER", "utf8")), "export must carry the raw NUL title")
    assert.ok(bytes.includes(Buffer.from("prt_before\u0000AFTER", "utf8")), "export must carry the raw NUL locator")
  })
})

describe("blocker 2: native failed compaction stays readable", () => {
  function writeFailedCompaction(file) {
    const db = makeDb(file, { v2: true })
    v2Session(db, { id: "ses_cmp", title: "C", directory: "/cmp", timeCreated: 1, timeUpdated: 2 })
    v2Message(db, { id: "msg_body", sessionID: "ses_cmp", type: "user", seq: 0, timeCreated: 3, data: { text: "body-needle", files: [], agents: [], time: { created: 3 } } })
    v2Message(db, {
      id: "msg_failed",
      sessionID: "ses_cmp",
      type: "compaction",
      seq: 1,
      timeCreated: 4,
      data: { status: "failed", reason: "auto", error: { type: "unknown", message: "synthetic failure" }, time: { created: 4 } },
    })
    db.close()
    return file
  }

  it("body search and default read do not abort on a failed compaction record", () => {
    const file = writeFailedCompaction(path.join(root, "cmp-failed.db"))
    const searched = runJson(["search", "--db", file, "body-needle"])
    assert.equal(searched.count, 1)
    const read = runJson(["read", "--db", file, "--session-id", "ses_cmp", "--out", outPath("cmp-default.md")])
    assert.equal(read.messages, 1)
  })

  it("--include-compaction preserves the raw native failure record", () => {
    const file = writeFailedCompaction(path.join(root, "cmp-optin.db"))
    const read = runJson([
      "read",
      "--db",
      file,
      "--session-id",
      "ses_cmp",
      "--include-compaction",
      "--out",
      outPath("cmp-optin.md"),
    ])
    const text = fs.readFileSync(read.out, "utf8")
    for (const present of ["failed", "auto", "synthetic failure", "unknown"]) {
      assert.ok(text.includes(present), `failed compaction export missing: ${present}`)
    }
  })
})

describe("blocker 3: exclusive private staging with no-replace finalization", () => {
  it("never unlinks a substituted symlink during ownership-checked cleanup", async () => {
    const victim = path.join(root, "symlink-victim.md")
    const link = path.join(root, "symlink-stage.md")
    fs.writeFileSync(victim, "ours")
    const identity = identityOf(fs.lstatSync(victim, { bigint: true }))
    fs.renameSync(victim, `${victim}.moved`)
    fs.symlinkSync(`${victim}.moved`, link)
    const removed = await removeIfOwned(link, identity)
    assert.equal(removed, false)
    assert.equal(fs.lstatSync(link).isSymbolicLink(), true, "foreign symlink must survive cleanup")
    assert.equal(fs.readFileSync(`${victim}.moved`, "utf8"), "ours")
  })

  it("publishes by no-replace link and never touches a pre-existing destination", async () => {
    const stageDir = fs.mkdtempSync(path.join(root, "publish-"))
    const stage = path.join(stageDir, "export.md")
    fs.writeFileSync(stage, "complete export")
    const final = path.join(stageDir, "final.md")
    fs.writeFileSync(final, "foreign")
    assert.equal(typeof transcript.publishExclusive, "function", "no-replace publish seam must exist")
    await assert.rejects(
      () => transcript.publishExclusive(stage, final),
      (error) => error instanceof FolioError && error.code === "E_OUT_EXISTS",
    )
    assert.equal(fs.readFileSync(final, "utf8"), "foreign", "pre-existing destination must never be replaced")
    const fresh = path.join(stageDir, "fresh.md")
    await transcript.publishExclusive(stage, fresh)
    assert.equal(fs.readFileSync(fresh, "utf8"), "complete export")
    assert.equal(fs.existsSync(stage), true, "publish must not delete the caller's stage")
  })

  it("leaves no staging residue and no destination after a corrupt-row failure", () => {
    const exportsDir = path.join(root, "stage-failure-exports")
    const file = path.join(root, "stage-corrupt.db")
    const db = makeDb(file, { v1: true })
    v1Session(db, { id: "ses_bad", title: "Bad", directory: "/bad", timeCreated: 1, timeUpdated: 2 })
    ins(db, "message", { id: "msg_bad", session_id: "ses_bad", time_created: 3, time_updated: 3, data: "{oops" })
    db.close()
    const out = path.join(exportsDir, "bad.md")
    expectError(["read", "--db", file, "--session-id", "ses_bad", "--out", out], "E_DATA")
    assert.equal(fs.existsSync(out), false)
    assert.deepEqual(fs.readdirSync(exportsDir), [], "private staging must be cleaned up")
  })
})

describe("blocker 4: search locators exist in the exported view", () => {
  it("does not match unrelated v1 message metadata through the system view", () => {
    const file = path.join(root, "system-locator.db")
    const db = makeDb(file, { v1: true })
    v1Session(db, { id: "ses_sys", title: "S", directory: "/s", timeCreated: 1, timeUpdated: 2 })
    v1Message(db, {
      id: "msg_sys",
      sessionID: "ses_sys",
      timeCreated: 3,
      role: "user",
      system: "actual stored system text",
      agent: "metadata-needle",
      time: { created: 3 },
    })
    v1Part(db, { id: "prt_sys", sessionID: "ses_sys", messageID: "msg_sys", timeCreated: 3, type: "text", text: "body" })
    db.close()
    const searched = runJson(["search", "--db", file, "metadata-needle", "--include-system"])
    assert.equal(searched.count, 0, "agent metadata is not part of the exported system view")
    const read = runJson(["read", "--db", file, "--session-id", "ses_sys", "--include-system", "--out", outPath("system-view.md")])
    const text = fs.readFileSync(read.out, "utf8")
    assert.ok(text.includes("actual stored system text"))
    assert.equal(text.includes("metadata-needle"), false)
  })

  it("uses the real record path for v2 shell and compaction hits", () => {
    const file = path.join(root, "locator-shell.db")
    const db = makeDb(file, { v2: true })
    v2Session(db, { id: "ses_loc", title: "L", directory: "/l", timeCreated: 1, timeUpdated: 2 })
    v2Message(db, {
      id: "msg_shell",
      sessionID: "ses_loc",
      type: "shell",
      seq: 1,
      timeCreated: 3,
      data: { shellID: "sh_1", command: "literal-shell-needle", status: "completed", output: "out", time: { created: 3 } },
    })
    v2Message(db, {
      id: "msg_comp",
      sessionID: "ses_loc",
      type: "compaction",
      seq: 2,
      timeCreated: 4,
      data: { status: "completed", reason: "auto", summary: "literal-summary-needle", recent: "recent", time: { created: 4 } },
    })
    v2Message(db, {
      id: "msg_comp_failed",
      sessionID: "ses_loc",
      type: "compaction",
      seq: 3,
      timeCreated: 5,
      data: { status: "failed", reason: "auto", error: { message: "literal-error-needle", type: "unknown" }, time: { created: 5 } },
    })
    db.close()

    const shell = runJson(["search", "--db", file, "literal-shell-needle", "--include-tools"])
    assert.equal(shell.count, 1)
    assert.equal(shell.hits[0].locator, "record")
    const summary = runJson(["search", "--db", file, "literal-summary-needle", "--include-compaction"])
    assert.equal(summary.count, 1)
    assert.equal(summary.hits[0].locator, "record")
    const failed = runJson(["search", "--db", file, "literal-error-needle", "--include-compaction"])
    assert.equal(failed.count, 1)
    assert.equal(failed.hits[0].locator, "record")

    const read = runJson([
      "read",
      "--db",
      file,
      "--session-id",
      "ses_loc",
      "--include-tools",
      "--include-compaction",
      "--out",
      outPath("locator-parity.md"),
    ])
    const text = fs.readFileSync(read.out, "utf8")
    assert.ok(text.includes("locator=record"), "export comment must use the same locator as search")
    assert.equal(text.includes("locator=summary"), false, "whole-record matches must not claim scalar-only locations")
    for (const hit of [shell.hits[0], summary.hits[0], failed.hits[0]]) {
      assert.ok(text.includes(`locator=${hit.locator}`), `export lacks search locator ${hit.locator}`)
      assert.ok(text.includes(hit.snippet), `export lacks search snippet ${JSON.stringify(hit.snippet)}`)
    }
  })
})

describe("blocker 5: malformed known optionals fail instead of disappearing", () => {
  it("rejects v2 user files/agents/skills that are not arrays", () => {
    const cases = [
      ["files", { uri: "hidden-needle" }],
      ["agents", 7],
      ["skills", { name: "x" }],
    ]
    for (const [field, value] of cases) {
      const file = path.join(root, `optional-${field}.db`)
      const db = makeDb(file, { v2: true })
      v2Session(db, { id: "ses_opt", title: "O", directory: "/o", timeCreated: 1, timeUpdated: 2 })
      const data = { text: "body", files: [], agents: [], skills: [], time: { created: 3 } }
      data[field] = value
      v2Message(db, { id: "msg_opt", sessionID: "ses_opt", type: "user", seq: 1, timeCreated: 3, data })
      db.close()
      expectError(["read", "--db", file, "--session-id", "ses_opt", "--include-injected"], "E_DATA")
    }
  })

  it("rejects non-boolean v1 synthetic/ignored text flags instead of serving them as body", () => {
    for (const [field, value] of [
      ["synthetic", "yes"],
      ["ignored", 1],
    ]) {
      const file = path.join(root, `v1-flag-${field}.db`)
      const db = makeDb(file, { v1: true })
      v1Session(db, { id: "ses_flag", title: "F", directory: "/f", timeCreated: 1, timeUpdated: 2 })
      v1Message(db, { id: "msg_flag", sessionID: "ses_flag", timeCreated: 3, role: "user", time: { created: 3 } })
      v1Part(db, { id: "prt_flag", sessionID: "ses_flag", messageID: "msg_flag", timeCreated: 3, type: "text", text: "flag-body", [field]: value })
      db.close()
      expectError(["read", "--db", file, "--session-id", "ses_flag"], "E_DATA")
      expectError(["search", "--db", file, "flag-body"], "E_DATA")
    }
  })
})

describe("blocker 6: maximum fitting prefix without monotonic cursor assumptions", () => {
  it("returns the complete list page whose terminal receipt has no oversized cursor", () => {
    const file = path.join(root, "long-id-budget.db")
    const db = makeDb(file, { v2: true })
    const longID = `ses_${"z".repeat(18000)}`
    const ids = [longID, "ses_b", "ses_a"]
    ids.forEach((id, i) => v2Session(db, { id, title: "S", directory: "/synthetic", timeCreated: 1, timeUpdated: 100 - i }))
    db.close()
    const r = run(["list", "--db", file])
    assert.equal(r.status, 0, `expected full terminal page, got: ${r.stdout}`)
    assert.ok(Buffer.byteLength(r.stdout, "utf8") <= 32768)
    const j = JSON.parse(r.stdout)
    assert.equal(j.count, 3)
    assert.equal(j.nextCursor, null)
    assert.equal(j.truncated, false)
    assert.deepEqual(j.sessions.map((s) => s.id), [longID, "ses_b", "ses_a"])
  })

  it("returns the complete search page even when the first hit anchor is huge", () => {
    const file = path.join(root, "long-search-budget.db")
    const db = makeDb(file, { v1: true })
    v1Session(db, { id: "ses_s", title: "S", directory: "/synthetic", timeCreated: 1, timeUpdated: 2 })
    const longMessageID = `msg_${"y".repeat(18000)}`
    v1Message(db, { id: longMessageID, sessionID: "ses_s", timeCreated: 30, role: "user", time: { created: 30 } })
    v1Part(db, { id: "prt_long", sessionID: "ses_s", messageID: longMessageID, timeCreated: 30, type: "text", text: "search-needle" })
    v1Message(db, { id: "msg_mid", sessionID: "ses_s", timeCreated: 20, role: "user", time: { created: 20 } })
    v1Part(db, { id: "prt_mid", sessionID: "ses_s", messageID: "msg_mid", timeCreated: 20, type: "text", text: "search-needle" })
    v1Message(db, { id: "msg_low", sessionID: "ses_s", timeCreated: 10, role: "user", time: { created: 10 } })
    v1Part(db, { id: "prt_low", sessionID: "ses_s", messageID: "msg_low", timeCreated: 10, type: "text", text: "search-needle" })
    db.close()
    const r = run(["search", "--db", file, "search-needle"])
    assert.equal(r.status, 0, `expected full terminal search page, got: ${r.stdout}`)
    assert.ok(Buffer.byteLength(r.stdout, "utf8") <= 32768)
    const j = JSON.parse(r.stdout)
    assert.equal(j.count, 3)
    assert.equal(j.nextCursor, null)
    assert.equal(j.truncated, false)
  })
})

describe("blocker 7: unsupported sub-millisecond ISO precision is rejected", () => {
  it("rejects 4+ fraction digits on from and until instead of rounding across bounds", () => {
    const file = path.join(root, "fraction-time.db")
    const db = makeDb(file, { v2: true })
    v2Session(db, { id: "ses_frac", title: "T", directory: "/synthetic", timeCreated: 0, timeUpdated: 0 })
    db.close()
    for (const flag of ["--from", "--until"]) {
      const j = expectError(["list", "--db", file, flag, "1970-01-01T00:00:00.0001Z"], "E_USAGE")
      assert.match(j.error.message, /millisecond|fraction|precision/i)
    }
    expectError(["search", "--db", file, "x", "--from", "1970-01-01T00:00:00.123456789Z"], "E_USAGE")
  })

  it("keeps left-closed right-open bounds exact at one millisecond", () => {
    const file = path.join(root, "fraction-boundary.db")
    const db = makeDb(file, { v2: true })
    v2Session(db, { id: "ses_zero", title: "T", directory: "/synthetic", timeCreated: 0, timeUpdated: 0 })
    db.close()
    assert.equal(runJson(["list", "--db", file, "--until", "1970-01-01T00:00:00.001Z"]).count, 1)
    assert.equal(runJson(["list", "--db", file, "--from", "1970-01-01T00:00:00.001Z"]).count, 0)
    assert.equal(runJson(["list", "--db", file, "--until", "1970-01-01T00:00:00.1Z"]).count, 1)
    assert.equal(runJson(["list", "--db", file, "--from", "1970-01-01T00:00:00.1Z"]).count, 0)
  })
})
