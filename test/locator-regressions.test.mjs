// Whole-record opt-in searches must not claim unrelated scalar source fields.
import { after, before, it } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { makeDb, tmpRoot, v2Message, v2Session } from "./fixtures.mjs"

const BIN = fileURLToPath(new URL("../bin/opencode-folio.js", import.meta.url))
let root
before(() => { root = tmpRoot("folio-locator-") })
after(() => { fs.rmSync(root, { recursive: true, force: true }) })

function run(args) {
  const result = spawnSync(process.execPath, [BIN, ...args], {
    cwd: root,
    env: { ...process.env, OPENCODE_DB: "", OPENCODE_SESSION_DB: "" },
    encoding: "utf8",
    timeout: 30000,
  })
  assert.equal(result.status, 0, `${result.stdout} | ${result.stderr}`)
  return JSON.parse(result.stdout)
}

for (const [type, view, data, query] of [
  ["compaction", "--include-compaction", { status: "completed", summary: "actual summary", recent: "RECENT-ONLY-NEEDLE" }, "RECENT-ONLY-NEEDLE"],
  ["system", "--include-system", { text: "actual system text", description: "DESCRIPTION-ONLY-NEEDLE" }, "DESCRIPTION-ONLY-NEEDLE"],
  ["skill", "--include-injected", { text: "actual skill text", name: "SKILLNAME-ONLY-NEEDLE", skill: "synthetic-skill" }, "SKILLNAME-ONLY-NEEDLE"],
  ["synthetic", "--include-injected", { text: "actual injected text", extra: { note: "EXTRA-ONLY-NEEDLE" } }, "EXTRA-ONLY-NEEDLE"],
]) {
  it(`${type} payload-only hits locate the whole native record, not text/summary`, () => {
    const file = path.join(root, `${type}.db`)
    const db = makeDb(file, { v2: true })
    v2Session(db, { id: "ses_locator", title: "Synthetic locator fixture", directory: "/synthetic", timeCreated: 1, timeUpdated: 2 })
    v2Message(db, { id: `msg_${type}`, sessionID: "ses_locator", type, seq: 1, timeCreated: 3, data: { ...data, time: { created: 3 } } })
    db.close()

    const searched = run(["search", query, "--db", file, view])
    assert.equal(searched.count, 1)
    assert.equal(searched.hits[0].locator, "record", "the match is in the native payload, not its unrelated scalar text")
    assert.equal(searched.hits[0].messageID, `msg_${type}`)
    assert.ok(searched.hits[0].snippet.includes(query))
    const exported = run(["read", "--db", file, "--session-id", "ses_locator", view, "--out", path.join(root, `${type}.md`)])
    const text = fs.readFileSync(exported.out, "utf8")
    assert.ok(text.includes(`message=msg_${type} locator=record`))
    assert.ok(text.includes(query))
    assert.ok(text.includes(data.text ?? data.summary))
  })
}
