import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { readFile } from "node:fs/promises"
import { installControlDriver } from "./lib/control-driver-install.mjs"
import { join, resolve } from "node:path"
import { homedir } from "node:os"
import { createHash } from "node:crypto"

// Install the reviewed local package separately from the notarized upstream app.
// Existing daemons retain their running executable; no active task is killed.
assert.equal(process.platform, "darwin")
const manifest = JSON.parse(
  await readFile("vendor/cua-driver/release.json", "utf8")
)
const source = resolve("release/control-driver", manifest.version)
const provenance = JSON.parse(
  await readFile(join(source, "provenance.json"), "utf8")
)
assert.equal(provenance.version, manifest.version)
assert.equal(provenance.base, manifest.base)
assert.match(provenance.identity, /^[A-F0-9]{40}$/)
const hash = (data) => createHash("sha256").update(data).digest("hex")
assert.equal(
  hash(await readFile(join("vendor/cua-driver", manifest.patch))),
  provenance.patchSha256
)
const run = promisify(execFile)
const requirement = `=identifier "com.trycua.driver.local" and certificate leaf = H"${provenance.identity}"`
async function verify(app) {
  assert.equal(
    hash(await readFile(join(app, "Contents/MacOS/cua-driver"))),
    provenance.binarySha256
  )
  await run(
    "/usr/bin/codesign",
    ["--verify", "--deep", "--strict", "--test-requirement", requirement, app],
    { timeout: 60000 }
  )
}
await verify(join(source, "CuaDriverLocal.app"))
const installed = await installControlDriver({
  source: join(source, "CuaDriverLocal.app"),
  root: join(homedir(), "Library/Application Support/mako/control-drivers"),
  link: join(homedir(), ".local/bin/cua-driver"),
  version: manifest.version,
  binarySha256: provenance.binarySha256,
  verify,
})
console.log(
  `Installed ${manifest.version}; new driver launches select ${installed.binary}. Existing daemons were not restarted. Rollback selection is recorded in ${installed.receipt}.`
)
