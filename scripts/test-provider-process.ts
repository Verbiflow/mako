import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs"
import { installProviderChildren } from "../electron/provider-children.ts"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  MissingWorkingDirectoryError,
  spawnProviderProcess,
} from "../electron/providers/provider-process.ts"
import { withDiscoveryProcess } from "../electron/providers/discovery-process.ts"
import { CursorSdkClient } from "../electron/providers/cursor/sdk/client.ts"

// A provider started in a folder that is gone names the folder, for every
// harness, instead of Node's ENOENT against an executable that exists.
const root = mkdtempSync(join(tmpdir(), "mako-provider-process-"))
const gone = join(root, "deleted-worktree")
try {
  assert.throws(
    () => spawnProviderProcess(process.execPath, ["-e", "process.exit(0)"], { cwd: gone }),
    { name: MissingWorkingDirectoryError.name, cwd: gone, message: `The folder ${gone} no longer exists. Open this in a folder that exists.` },
    "a missing folder is refused before anything is spawned"
  )
  const child = spawnProviderProcess(process.execPath, ["-e", "process.stdout.write(process.cwd())"], { cwd: root })
  let output = ""
  child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString() })
  await new Promise((resolve) => child.once("close", resolve))
  assert.equal(output, realpathSync(root), "an existing folder starts as asked")

  // A provider that exits leaving its own child on its pipes: Mako ends the
  // child with the group and closes the pipes, from one exit listener.
  const providers = installProviderChildren(root)
  const parent = spawnProviderProcess("/bin/sh", ["-c", "sleep 30 & echo $!"], { cwd: root }, { kind: "test:provider", owner: "exit-cleanup" })
  assert.equal(parent.listenerCount("exit"), 1, "Mako's exit cleanup is one listener, leaving an SDK room for its own")
  assert.deepEqual(JSON.parse(readFileSync(providers.path, "utf8")).children.map((entry: { pid: number }) => entry.pid), [parent.pid], "the process is recorded for reaping while it runs")
  let printed = ""
  parent.stdout.on("data", (chunk: Buffer) => { printed += chunk.toString() })
  const closed = new Promise((resolve) => parent.once("close", resolve))
  await new Promise((resolve) => parent.once("exit", resolve))
  assert.deepEqual(JSON.parse(readFileSync(providers.path, "utf8")).children, [], "an exited process leaves the registry")
  const orphan = Number(printed.trim())
  assert.ok(orphan > 0)
  await closed
  const deadline = Date.now() + 5_000
  for (;;) {
    try { process.kill(orphan, 0) } catch { break }
    assert.ok(Date.now() < deadline, "the provider's own child ends with its process group")
    await new Promise((resolve) => setTimeout(resolve, 50))
  }

  await assert.rejects(
    withDiscoveryProcess({ command: process.execPath, args: ["-e", ""], env: process.env, cwd: gone }, async () => "ran"),
    /no longer exists/,
    "discovery says which folder is gone, not that the CLI is missing"
  )
  assert.throws(
    () => new CursorSdkClient({ owner: "missing-folder", cwd: gone, env: {}, onEvent() {}, execPath: process.execPath }),
    MissingWorkingDirectoryError,
    "the Cursor child is refused the same way"
  )
} finally {
  rmSync(root, { recursive: true, force: true })
}
console.log("Provider process: a missing folder is named for spawned harnesses, discovery and the Cursor child; an existing one starts")
