import assert from "node:assert/strict"
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  VERIFIED_CUA_DRIVER_VERSION,
  compareVersions,
  CuaDriverVersions,
  parseCuaDriverVersion,
} from "@mako/host/control/cua-driver-version"

assert.equal(parseCuaDriverVersion("cua-driver 0.19.3\n"), "0.19.3")
assert.equal(parseCuaDriverVersion("cua-driver v0.28.0 — driver"), "0.28.0")
assert.equal(parseCuaDriverVersion("nothing here"), null)
assert.equal(parseCuaDriverVersion("cua-driver 0.28.2+mako.1"), "0.28.2+mako.1")
assert.equal(compareVersions("0.28.2+mako.1", "0.28.2"), 0)
assert.ok(compareVersions("0.19.3", "0.28.0") < 0)
assert.ok(compareVersions("0.28.0", "0.28.0") === 0)
assert.ok(compareVersions("1.0.0", "0.99.9") > 0)
assert.ok(compareVersions("0.28.1", "0.28") > 0)

const root = await mkdtemp(join(tmpdir(), "mako-driver-version-"))
try {
  const executable = join(root, "cua-driver")
  await writeFile(executable, "#!/bin/sh\n")
  const calls: string[][] = []
  let version = "0.19.3"
  const run = async (_command: string, args: string[]) => {
    calls.push(args)
    return { stdout: `cua-driver ${version}\n`, stderr: "" }
  }
  const versions = new CuaDriverVersions(run)
  const missing = await versions.status(null)
  assert.equal(missing.executable, null)
  assert.equal(missing.outdated, false)
  assert.equal(calls.length, 0)

  const old = await versions.status(executable)
  assert.equal(old.version, "0.19.3")
  assert.equal(old.verified, VERIFIED_CUA_DRIVER_VERSION)
  assert.equal(old.outdated, true)
  assert.match(old.detail, /0\.19\.3 is older than the verified/)
  assert.deepEqual(calls, [["--version"]])

  // Unchanged executable: cached, no second process.
  version = "9.9.9"
  assert.equal((await versions.status(executable)).version, "0.19.3")
  assert.equal(calls.length, 1)

  // A replaced binary (new mtime) is read again.
  await utimes(
    executable,
    new Date(Date.now() + 5_000),
    new Date(Date.now() + 5_000)
  )
  const fresh = await versions.status(executable)
  assert.equal(fresh.version, "9.9.9")
  assert.equal(fresh.outdated, false)
  assert.equal(fresh.detail, "CUA Driver 9.9.9")
  assert.equal(calls.length, 2)

  const failing = async () => {
    throw new Error("spawn EACCES")
  }
  const failed = await new CuaDriverVersions(failing).status(executable)
  assert.equal(failed.version, null)
  assert.equal(failed.outdated, false)
  assert.match(failed.detail, /EACCES/)

  version = "0.28.2+mako.1"
  const beforeLocalUpdate = calls.length
  await assert.rejects(
    versions.update(executable),
    /signed Mako driver package/
  )
  assert.deepEqual(
    calls.slice(beforeLocalUpdate),
    [["--version"]],
    "Local packages must never run the upstream updater"
  )
  version = "9.9.9"
  const updated = await versions.update(executable)
  assert.deepEqual(calls.at(-1), ["update", "--apply"])
  assert.match(updated.output, /cua-driver 9\.9\.9/)
  // The update forgets the cached reading so the next status runs the binary.
  await versions.status(executable)
  assert.deepEqual(calls.at(-1), ["--version"])
} finally {
  await rm(root, { recursive: true, force: true })
}
console.log(
  "CUA Driver version: parsed, compared against the verified release, cached per executable mtime, and refreshed after update"
)
