import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import {
  readFile,
  writeFile,
  cp,
  lstat,
  mkdir,
  rename,
  readlink,
  symlink,
} from "node:fs/promises"
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
const app = "/Applications/CuaDriverLocal.app",
  binary = join(app, "Contents/MacOS/cua-driver")
const bin = join(homedir(), ".local/bin"),
  link = join(bin, "cua-driver")
await mkdir(bin, { recursive: true })
const existing = await lstat(link).catch((error) => {
  if (error.code !== "ENOENT") throw error
  return null
})
assert.ok(
  !existing || existing.isSymbolicLink(),
  "Refusing to replace an unmanaged cua-driver executable"
)
const previous = existing ? await readlink(link) : null
assert.ok(
  previous === null ||
    previous === "/Applications/CuaDriver.app/Contents/MacOS/cua-driver" ||
    previous === binary,
  "Refusing to replace an unrecognized driver selection"
)
const installed = await lstat(app).catch((error) => {
  if (error.code !== "ENOENT") throw error
  return null
})
if (installed) await verify(app)
else {
  const stage = `/Applications/.CuaDriverLocal-install-${process.pid}.app`
  await cp(join(source, "CuaDriverLocal.app"), stage, {
    recursive: true,
    errorOnExist: true,
    force: false,
  })
  await verify(stage)
  await rename(stage, app)
}
const receipt = join(source, "installation.json")
if (previous !== binary) {
  await writeFile(
    receipt,
    JSON.stringify(
      {
        app,
        link,
        previous,
        version: manifest.version,
        binarySha256: provenance.binarySha256,
        activatedAt: new Date().toISOString(),
      },
      null,
      2
    )
  )
  const pending = link + `.${process.pid}.tmp`
  await symlink(binary, pending)
  await rename(pending, link)
}
await verify(app)
assert.equal(await readlink(link), binary)
console.log(
  `Installed ${manifest.version}; new driver launches select ${binary}. Existing daemons were not restarted. Rollback selection is recorded in ${receipt}.`
)
