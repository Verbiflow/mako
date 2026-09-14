import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { promisify } from "node:util"
import { createMakoBridge } from "../electron/contracts/renderer-bridge.ts"
import { WorkspaceGit } from "../electron/host-git.ts"
import { WorkspaceFiles } from "../electron/host-workspace.ts"
import { inlineFileTarget } from "../src/lib/file-citations.ts"

/**
 * Opening a file the transcript linked.
 *
 * An answer writes `test-notifications.ts` in prose, `inlineFileTarget` turns
 * that inline code into a link, and the file is in `scripts/`. Resolving the
 * name against the workspace root read nothing and reported
 * `Error invoking remote method 'mako:read-live-file': Error: ENOENT … stat
 * '/Users/you/project/test-notifications.ts'` — an internal channel name in
 * front of an absolute path the reader never typed, about a file that exists.
 * Both halves are checked here: the host resolves the name, and no host error
 * reaches the UI wearing Electron's IPC wrapper.
 */

const run = promisify(execFile)
const root = await mkdtemp(join(tmpdir(), "mako-file-open-"))
try {
  await run("git", ["init", "-q", "."], { cwd: root })
  const tracked = [
    "AGENTS.md",
    "scripts/test-notifications.ts",
    "src/components/rail/store.ts",
    "src/components/rail/use-row-flip.ts",
    "src/state/store.ts",
  ]
  for (const path of tracked) {
    await mkdir(dirname(join(root, path)), { recursive: true })
    await writeFile(join(root, path), `// ${path}\n`)
  }
  await run("git", ["add", "-A"], { cwd: root })
  await run(
    "git",
    ["-c", "user.email=t@mako", "-c", "user.name=Test", "commit", "-qm", "init"],
    { cwd: root }
  )

  // The input that starts this: bare inline code becomes a file link.
  assert.deepEqual(inlineFileTarget("test-notifications.ts"), {
    path: "test-notifications.ts",
    line: undefined,
    endLine: undefined,
  })

  const files = new WorkspaceFiles(root, new WorkspaceGit(root))
  const opened = async (path: string) => (await files.read(path)).path
  const refused = async (path: string) =>
    await files.read(path).then(
      () => "resolved",
      (error: Error) => error.message
    )

  assert.equal(
    await opened("scripts/test-notifications.ts"),
    "scripts/test-notifications.ts",
    "a real path is read as given"
  )
  assert.equal(
    await opened("test-notifications.ts"),
    "scripts/test-notifications.ts",
    "a name resolves to the one tracked file that carries it"
  )
  assert.equal(
    await opened("rail/use-row-flip.ts"),
    "src/components/rail/use-row-flip.ts",
    "a partial path resolves by suffix, never by prefix"
  )
  assert.equal(await opened("AGENTS.md"), "AGENTS.md", "a root file is itself")

  // Ambiguity and absence are sentences, never a stat error.
  assert.equal(
    await refused("store.ts"),
    "2 files are named store.ts — src/components/rail/store.ts, src/state/store.ts. Open it by its full path.",
    "two files of one name name both"
  )
  assert.equal(
    await refused("nope.ts"),
    "No file named nope.ts in this project"
  )
  assert.equal(
    await refused(join(root, "absent.ts")),
    `No file at ${join(root, "absent.ts")}`,
    "an absolute request is taken literally"
  )
  assert.equal(await refused("scripts"), "scripts is a directory")
  assert.match(
    await refused("../outside.ts"),
    /^No file named/,
    "a path climbing out of the workspace is not searched for"
  )

  // Electron wraps whatever a handler throws; the UI prints `error.message`.
  class Disconnected extends Error {}
  const thrown: Error[] = []
  const bridge = createMakoBridge({
    // This fixture is only ever asked how a failure reaches the caller.
    invoke: async () => {
      throw (
        thrown.shift() ??
        new Error("The fixture transport was asked for a value")
      )
    },
    onEvent: () => () => {},
    onTerminalEvent: () => () => {},
    pathForFile: () => null,
    resolveFileUrl: (url) => url,
  })
  const caught = async (error: Error) => {
    thrown.push(error)
    return await bridge.readFile("x").then(
      () => null,
      (failure: Error) => failure
    )
  }

  assert.equal(
    (
      await caught(
        new Error(
          "Error invoking remote method 'mako:read-live-file': Error: No file named nope.ts in this project"
        )
      )
    )?.message,
    "No file named nope.ts in this project",
    "the channel name and Electron's own Error: never reach the reader"
  )
  assert.equal(
    (await caught(new Error("The Mako host is reconnecting")))?.message,
    "The Mako host is reconnecting",
    "a message without the wrapper is untouched"
  )
  const disconnected = new Disconnected(
    "Error invoking remote method 'mako:git-status': Error: gone"
  )
  const settled = await caught(disconnected)
  assert.equal(settled, disconnected, "the error object itself is never replaced")
  assert.equal(settled?.message, "gone")

  console.log(
    "Opening a linked file: named and partial paths resolve, ambiguity and absence read as sentences, and host errors lose Electron's IPC wrapper"
  )
} finally {
  await rm(root, { recursive: true, force: true })
}
