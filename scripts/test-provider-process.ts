import assert from "node:assert/strict"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
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
