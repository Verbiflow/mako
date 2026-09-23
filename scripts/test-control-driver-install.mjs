import assert from "node:assert/strict"
import {
  mkdtemp,
  mkdir,
  readFile,
  readlink,
  symlink,
  writeFile,
} from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { installControlDriver } from "./lib/control-driver-install.mjs"
const directory = await mkdtemp(join(tmpdir(), "mako-driver-install-"))
const source = join(directory, "candidate.app")
await mkdir(join(source, "Contents/MacOS"), { recursive: true })
await writeFile(join(source, "Contents/MacOS/cua-driver"), "candidate")
const options = {
  source,
  root: join(directory, "versions"),
  link: join(directory, "bin/cua-driver"),
  version: "0.28.2+mako.7",
  binarySha256: "candidate-sha",
  verify: async (app) =>
    assert.equal(
      await readFile(join(app, "Contents/MacOS/cua-driver"), "utf8"),
      "candidate"
    ),
}
await mkdir(join(directory, "bin"))
await symlink(
  "/Applications/CuaDriverLocal.app/Contents/MacOS/cua-driver",
  options.link
)
const first = await installControlDriver(options)
assert.equal(await readlink(options.link), first.binary)
assert.equal(
  first.previous,
  "/Applications/CuaDriverLocal.app/Contents/MacOS/cua-driver"
)
const second = await installControlDriver(options)
assert.equal(
  second.previous,
  first.previous,
  "repeat retains original rollback selection"
)
assert.equal(second.state, "selected")
assert.equal(
  JSON.parse(await readFile(first.receipt, "utf8")).previous,
  first.previous
)
await writeFile(join(source, "Contents/MacOS/cua-driver"), "corrupted")
await assert.rejects(
  installControlDriver({ ...options, version: "0.28.2+mako.8" })
)
assert.equal(
  await readlink(options.link),
  first.binary,
  "invalid candidate never changes selection"
)
await writeFile(join(source, "Contents/MacOS/cua-driver"), "candidate")
let release, entered
const gate = new Promise((resolve) => {
  release = resolve
})
const held = new Promise((resolve) => {
  entered = resolve
})
const pending = installControlDriver({
  ...options,
  version: "0.28.2+mako.8",
  verify: async (app) => {
    entered()
    await gate
    await options.verify(app)
  },
})
await held
await assert.rejects(installControlDriver(options), /installation owns/)
release()
const third = await pending
assert.equal(third.previous, first.binary)
assert.equal(
  await readFile(first.binary, "utf8"),
  "candidate",
  "older executable remains available to active tasks"
)
const unmanaged = join(directory, "unmanaged")
await writeFile(unmanaged, "unmanaged executable")
await assert.rejects(
  installControlDriver({ ...options, link: unmanaged }),
  /unmanaged/
)
assert.equal(await readFile(unmanaged, "utf8"), "unmanaged executable")
console.log(
  "Driver install: versioned upgrades, repeat receipts, invalid candidate, concurrent admission, retained old executable and unmanaged selection refusal passed"
)
