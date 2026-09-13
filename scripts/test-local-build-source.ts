import assert from "node:assert/strict"
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { copyBuildSource, LocalUpdates } from "../electron/local-updates.js"

const root = await mkdtemp(join(tmpdir(), "mako-source-copy-"))
try {
  const source = join(root, "source")
  const isolated = join(root, "isolated")
  await mkdir(join(source, "node_modules/@mako"), { recursive: true })
  await mkdir(join(source, "packages/sessions"), { recursive: true })
  await mkdir(join(source, "ignore"))
  await mkdir(join(source, "release"))
  await mkdir(isolated)
  await writeFile(join(source, "packages/sessions/value.txt"), "source")
  await writeFile(join(source, ".npmrc"), "minimum-release-age=10080\n")
  await writeFile(join(source, ".env"), "fixture=not-for-build\n")
  await symlink(
    "../../packages/sessions",
    join(source, "node_modules/@mako/sessions")
  )
  await copyBuildSource(source, isolated)
  assert.equal(
    await realpath(join(isolated, "node_modules/@mako/sessions")),
    await realpath(join(isolated, "packages/sessions"))
  )
  await writeFile(
    join(isolated, "node_modules/@mako/sessions/value.txt"),
    "isolated"
  )
  assert.equal(
    await readFile(join(source, "packages/sessions/value.txt"), "utf8"),
    "source"
  )
  assert.equal(
    await readFile(join(isolated, ".npmrc"), "utf8"),
    "minimum-release-age=10080\n"
  )
  for (const name of [".env", "ignore", "release"])
    await assert.rejects(realpath(join(isolated, name)), { code: "ENOENT" })
  await symlink(
    join(source, "packages/sessions"),
    join(source, "node_modules/escape")
  )
  const second = join(root, "second")
  await mkdir(second)
  await assert.rejects(copyBuildSource(source, second), /leaves the private/)
  const updatesRoot = join(root, "updates")
  await mkdir(updatesRoot)
  await writeFile(join(updatesRoot, "source.json"), JSON.stringify(join(root, "missing-checkout")))
  // Build directories an earlier host left behind go on the first load; the
  // receipt, the source selection, and anything not ours stay.
  await mkdir(join(updatesRoot, "build-Old1/output/mac-arm64/Mako.app"), { recursive: true })
  await writeFile(join(updatesRoot, "build-Old1/output/mac-arm64/Mako.app/stale"), "x")
  await mkdir(join(updatesRoot, "build-Old2"))
  await mkdir(join(updatesRoot, "not-a-build"))
  await symlink(join(root, "source"), join(updatesRoot, "build-Link"))
  await writeFile(join(updatesRoot, "install-result.json"), JSON.stringify({ ok: true }))
  let complete = () => {}
  const completed = new Promise<void>((resolve) => { complete = resolve })
  const updates = new LocalUpdates(updatesRoot, "A".repeat(40), () => { if (!updates.building && updates.snapshot().local.kind === "error") complete() })
  await updates.load()
  for (const name of ["build-Old1", "build-Old2"])
    await assert.rejects(realpath(join(updatesRoot, name)), { code: "ENOENT" })
  for (const name of ["not-a-build", "build-Link", "install-result.json", "source.json"])
    assert.ok(await realpath(join(updatesRoot, name)))
  assert.ok(await realpath(join(root, "source/packages/sessions/value.txt")), "a linked target is never followed")
  updates.start()
  await completed
  const failed = updates.snapshot().local
  assert.equal(failed.kind, "error")
  if (failed.kind === "error") assert.match(failed.message, /missing-checkout|Node.js and npm/)
  console.log("Local build copies preserve workspace links and security configuration, isolate writes, exclude generated data, reject escaping links, prune earlier build directories and report the real preparation error")
} finally {
  await rm(root, { recursive: true, force: true })
}
