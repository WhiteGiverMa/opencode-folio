// Exact path-based ownership is required across Linux and Windows Node 24.0.
import { after, before, it } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import fsp from "node:fs/promises"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { identityOf, removeIfOwned } from "../dist/transcript.js"
import { tmpRoot, writeV1Fixture, writeV2Fixture } from "./fixtures.mjs"

const BIN = fileURLToPath(new URL("../bin/opencode-folio.js", import.meta.url))
let root
before(() => { root = tmpRoot("folio-identity-") })
after(() => { fs.rmSync(root, { recursive: true, force: true }) })

it("removes an owned stage identified by exact path-based BigInt stats", async () => {
  const file = path.join(root, "owned.md")
  fs.writeFileSync(file, "synthetic partial export")
  const identity = identityOf(await fsp.lstat(file, { bigint: true }))
  assert.equal(typeof identity.ino, "bigint")
  assert.equal(await removeIfOwned(file, identity), true)
  assert.equal(fs.existsSync(file), false)
})

it("preserves a file when either exact device or inode identity differs", async () => {
  const file = path.join(root, "foreign.md")
  fs.writeFileSync(file, "must survive")
  const identity = identityOf(await fsp.lstat(file, { bigint: true }))
  for (const changed of [{ ...identity, dev: identity.dev + 1n }, { ...identity, ino: identity.ino + 1n }]) {
    assert.equal(await removeIfOwned(file, changed), false)
    assert.equal(fs.readFileSync(file, "utf8"), "must survive")
  }
  const large = 2n ** 60n
  assert.notDeepEqual(identityOf({ dev: 1n, ino: large }), identityOf({ dev: 1n, ino: large + 1n }))
})

it("successful v1/v2 CLI exports leave only completed files, never owned stage residue", () => {
  const outDir = path.join(root, "exports")
  fs.mkdirSync(outDir)
  for (const [db, session] of [[writeV1Fixture(root), "ses_main"], [writeV2Fixture(root), "ses_v2"]]) {
    for (let i = 0; i < 4; i++) {
      const out = path.join(outDir, `${session}-${i}.md`)
      const result = spawnSync(process.execPath, [BIN, "read", "--db", db, "--session-id", session, "--out", out], { encoding: "utf8", timeout: 30000 })
      assert.equal(result.status, 0, `${result.stdout} | ${result.stderr}`)
      assert.equal(JSON.parse(result.stdout).outBytes, fs.readFileSync(out).length)
      assert.deepEqual(fs.readdirSync(outDir).filter((entry) => entry.startsWith(".folio-stage-")), [])
    }
  }
})
