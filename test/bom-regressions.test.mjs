// Failing-first regressions for byte-faithful leading U+FEFF decoding.
// Stored TEXT is read through CAST(... AS BLOB) and strictly decoded, so a
// leading BOM must survive as the real first character (TextDecoder
// ignoreBOM:true); JSON.parse keeps rejecting BOM-prefixed JSON exactly like
// native code, so malformed markers/rows are never silently trimmed into
// acceptance. Every test drives the compiled decoder or the real CLI over
// self-owned synthetic fixtures.
import { after, before, describe, it } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { decodeTextBytes, requireText } from "../dist/store.js"
import { ins, makeDb, tmpRoot, v1Session, v2Session } from "./fixtures.mjs"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const BIN = path.join(ROOT, "bin", "opencode-folio.js")
const BOM = "\uFEFF"

let root

before(() => {
  root = tmpRoot("folio-bom-")
})

after(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

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
  return j
}

function outPath(name) {
  return path.join(root, "out", name)
}

function bytesOf(value) {
  return Buffer.from(value, "utf8")
}

function assertByteEqual(actual, expected, label) {
  assert.ok(bytesOf(actual).equals(bytesOf(expected)), `${label}: ${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`)
  assert.equal(actual, expected, `${label} must be identical as a string`)
}

describe("leading U+FEFF byte fidelity", () => {
  it("requireText/decodeTextBytes keep a leading BOM as the real first character", () => {
    const raw = bytesOf(`${BOM}before`)
    const viaRequire = requireText(raw, "probe")
    const viaDecode = decodeTextBytes(raw, "probe")
    assertByteEqual(viaRequire, `${BOM}before`, "requireText")
    assertByteEqual(viaDecode, `${BOM}before`, "decodeTextBytes")
    assert.equal(viaRequire.codePointAt(0), 0xfeff)
    assert.equal(viaRequire.length, 7)
  })

  it("CLI list/info keep a leading BOM in a real SQLite TEXT title and session id", () => {
    const file = path.join(root, "bom-text.db")
    const id = `${BOM}ses_bom_text`
    const title = `${BOM}BOM title \u03a3`
    const db = makeDb(file, { v2: true })
    v2Session(db, { id, title, directory: "/work/bom", timeCreated: 1000, timeUpdated: 2000 })
    db.close()

    const list = runJson(["list", "--db", file, "--order", "asc"])
    assert.equal(list.sessions.length, 1)
    assertByteEqual(list.sessions[0].id, id, "list id")
    assertByteEqual(list.sessions[0].title, title, "list title")
    assert.equal(list.sessions[0].id.codePointAt(0), 0xfeff)

    const info = runJson(["info", "--db", file, "--session-id", id])
    assertByteEqual(info.session.id, id, "info id")
    assertByteEqual(info.session.title, title, "info title")
  })

  it("CLI keeps a leading BOM when the title is stored as a real BLOB", () => {
    const file = path.join(root, "bom-blob.db")
    const title = `${BOM}Blob \u03a3 title`
    const db = makeDb(file, { v2: true })
    v2Session(db, {
      id: "ses_bom_blob",
      title: Buffer.from(title, "utf8"),
      directory: "/work/blob",
      timeCreated: 1000,
      timeUpdated: 2000,
    })
    db.close()

    const list = runJson(["list", "--db", file, "--order", "asc"])
    assert.equal(list.sessions.length, 1)
    assertByteEqual(list.sessions[0].title, title, "list BLOB title")
  })

  it("rejects a BOM-prefixed migration.v1-v2 marker as E_AMBIGUOUS_LAYOUT", () => {
    const file = path.join(root, "bom-mixed.db")
    const db = makeDb(file, { v1: true, v2: true, kv: true })
    v1Session(db, { id: "ses_mix", title: "LEGACY-TITLE", directory: "/legacy", timeCreated: 1, timeUpdated: 2 })
    v2Session(db, { id: "ses_mix", title: "AUTHORITY-TITLE", directory: "/authority", timeCreated: 10, timeUpdated: 20 })
    const marker = Buffer.from(`${BOM}${JSON.stringify({ phase: "completed" })}`, "utf8")
    ins(db, "kv", { key: "migration.v1-v2", value: marker, time_created: 5, time_updated: 5 })
    db.close()

    expectError(["list", "--db", file], "E_AMBIGUOUS_LAYOUT")
  })

  it("rejects BOM-prefixed JSON row data as E_DATA instead of trimming it", () => {
    const file = path.join(root, "bom-row.db")
    const db = makeDb(file, { v1: true })
    v1Session(db, { id: "ses_bom_row", title: "row", directory: "/row", timeCreated: 1, timeUpdated: 2 })
    const data = Buffer.from(`${BOM}${JSON.stringify({ role: "user", time: { created: 1 } })}`, "utf8")
    ins(db, "message", { id: "msg_bom", session_id: "ses_bom_row", time_created: 1, time_updated: 1, data })
    db.close()

    expectError(["read", "--db", file, "--session-id", "ses_bom_row", "--out", outPath("bom-row.md")], "E_DATA")
  })
})
