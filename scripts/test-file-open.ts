import "./lib/scratch-git.mjs"
import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { dirname, join, relative } from "node:path"
import { promisify } from "node:util"
import { createMakoBridge } from "../electron/contracts/renderer-bridge.ts"
import { WorkspaceGit } from "../electron/host-git.ts"
import { readConversationFile, WorkspaceFiles } from "../electron/host-workspace.ts"
import { inlineFileTarget } from "../src/lib/file-citations.ts"
import { threadFileWorkspace } from "../electron/contracts/thread-file-workspace.ts"
import { registeredHarnessIds } from "./registered-harnesses.ts"

/**
 * Opening a file the transcript linked.
 *
 * Explicit links and native citations may carry a basename, which the host
 * resolves through its ignore-aware index. Mere filenames in inline prose
 * carry no location and must remain text. Host failures reach the UI without
 * Electron's IPC wrapper.
 */

const run = promisify(execFile)
const outer = await mkdtemp(join(tmpdir(), "mako-file-open-"))
const root = join(outer, "project")
await mkdir(root)
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
    [
      "-c",
      "user.email=t@mako",
      "-c",
      "user.name=Test",
      "commit",
      "-qm",
      "init",
    ],
    { cwd: root }
  )

  assert.equal(inlineFileTarget("test-notifications.ts"), null,
    "An unlocated filename in prose never starts a file lookup")
  assert.ok(inlineFileTarget("scripts/test-notifications.ts"))

  await writeFile(join(root, ".gitignore"), "ignored/\n")
  await mkdir(join(root, "ignored"))
  await writeFile(join(root, "ignored", "test-notifications.ts"), "Ignored build output")
  const workspace = new WorkspaceFiles(outer, new WorkspaceGit(outer))
  assert.equal((await workspace.read("test-notifications.ts")).path, "project/scripts/test-notifications.ts", "multi-repository workspaces resolve names through each ignore-aware file index")
  assert.ok(!(await workspace.list()).some((file) => file.path.includes("ignored/")))
  const files = new WorkspaceFiles(root, new WorkspaceGit(root))
  const moved = join(outer, "moved")
  await mkdir(moved)
  await writeFile(join(moved, "owned.md"), "Moved conversation's output")
  await writeFile(join(root, "owned.md"), "Original project output")
  for (const harness of registeredHarnessIds()) {
    const cwd = threadFileWorkspace({ cwd: root, workspace: root, currentCwd: moved })!
    assert.equal((await new WorkspaceFiles(cwd, new WorkspaceGit(cwd)).read("owned.md")).contents, "Moved conversation's output", `${harness} reads the owning conversation's current folder`)
  }
  assert.equal(threadFileWorkspace({}), undefined, "Missing ownership never invents the active project's folder")
  await writeFile(join(root, "src", "owned.md"), "Nested working folder's output")
  assert.equal((await readConversationFile(join(root, "src"), "owned.md")).contents, "Nested working folder's output", "A conversation-relative path uses its cwd even inside a Git repository")
  assert.equal((await readConversationFile(join(root, "src"), "../owned.md")).contents, "Original project output", "Parent-relative paths preserve native working-directory semantics")
  await assert.rejects(readConversationFile(join(root, "src"), "./AGENTS.md"), /No file at \.\/AGENTS\.md/, "Explicit relative paths never silently select the repository-root file")
  // The reported failure: a reply cites an output in its Thread's data folder.
  const dataDir = join(outer, "thread-data", "owner")
  const ownedDataDir = async () => dataDir
  const otherData = join(outer, "thread-data", "other")
  const artifact = "flage-proof/side-by-side.mts"
  for (const folder of [dataDir, otherData]) await mkdir(join(folder, "flage-proof"), { recursive: true })
  await writeFile(join(dataDir, artifact), "Owning Thread's script")
  await writeFile(join(otherData, artifact), "Another Thread's script")
  assert.ok(inlineFileTarget(artifact))
  await assert.rejects(readConversationFile(root, artifact), /No file named/, "A project index cannot find a Thread artifact")
  for (const harness of registeredHarnessIds()) {
    const read = await readConversationFile(root, artifact, ownedDataDir)
    assert.equal(read.contents, "Owning Thread's script", `${harness} uses the same owner-scoped artifact route`)
    assert.equal(read.path, join(dataDir, artifact), "Refresh, Open and copy references carry the actual file location")
  }
  assert.equal((await readConversationFile(root, artifact, async () => otherData)).contents, "Another Thread's script", "Shared workspace caches do not share a data-file owner")
  assert.equal((await readConversationFile(root, artifact, ownedDataDir)).contents, "Owning Thread's script")
  await assert.rejects(readConversationFile(root, "side-by-side.mts", ownedDataDir), /No file named/, "The artifact route does not recursively scan the private data folder")
  await assert.rejects(readConversationFile(root, `./${artifact}`, ownedDataDir), /No file at/, "Explicit cwd paths never become data-folder paths")
  await assert.rejects(readConversationFile(root, "flage-proof/../../other/flage-proof/side-by-side.mts", ownedDataDir), /No file named/, "A data-folder fallback cannot traverse into another Thread")
  await mkdir(join(root, "flage-proof"))
  await writeFile(join(root, artifact), "Project's script")
  assert.equal((await readConversationFile(root, artifact, ownedDataDir)).contents, "Project's script", "A real cwd-relative path keeps precedence")
  let rootLookups = 0
  const lazyRoot = async () => { rootLookups++; return dataDir }
  await readConversationFile(root, artifact, lazyRoot)
  await readConversationFile(root, join(otherData, artifact), lazyRoot)
  await assert.rejects(readConversationFile(root, `./absent.mts`, lazyRoot), /No file at/)
  assert.equal(rootLookups, 0, "Existing project files, absolute paths and explicit cwd paths never look up data ownership")
  assert.equal((await readConversationFile(root, join(otherData, artifact), ownedDataDir)).contents, "Another Thread's script", "An explicitly linked absolute file keeps its meaning")
  await rm(join(root, "flage-proof"), { recursive: true })
  assert.equal((await readConversationFile(root, artifact, lazyRoot)).contents, "Owning Thread's script")
  assert.equal(rootLookups, 1, "Only a missing implicit project path looks up the data folder")
  await rm(join(dataDir, artifact))
  await assert.rejects(readConversationFile(root, artifact, ownedDataDir), /No file named/, "A removed artifact never falls through to another Thread")
  let scans = 0
  const indexGate = Promise.withResolvers<void>()
  class CountedGit extends WorkspaceGit {
    override async listFiles() { scans++; await indexGate.promise; return ["owned.md"] }
  }
  const concurrent = new WorkspaceFiles(root, new CountedGit(root))
  const reads = [concurrent.list(), concurrent.list()]
  indexGate.resolve()
  const indexes = await Promise.all(reads)
  assert.equal(scans, 1, "Simultaneous preview cards share one in-flight index scan")
  assert.equal(indexes[0], indexes[1])
  for (const [name, data, media, mime] of [
    [
      "native-image",
      Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXZkAAAAASUVORK5CYII=", "base64"),
      "image",
      "image/png",
    ],
    ["native-document", Buffer.from("%PDF-1.7\n"), "pdf", "application/pdf"],
    [
      "native-video",
      Buffer.from([0, 0, 0, 20, 102, 116, 121, 112, 105, 115, 111, 109]),
      "video",
      "video/mp4",
    ],
  ] as const) {
    await writeFile(join(root, name), data)
    const read = await files.read(name)
    assert.equal(
      read.media,
      media,
      "native asset signatures survive extensionless filenames"
    )
    assert.equal(read.mimeType, mime)
    assert.ok(read.previewUrl)
    assert.equal(read.contents, "")
  }

  const diagnostic = join(root, "large.har")
  await writeFile(
    diagnostic,
    JSON.stringify({
      log: { entries: [] },
      padding: " ".repeat(3 * 1024 * 1024),
    })
  )
  const diagnosticFile = await files.read("large.har")
  assert.equal(diagnosticFile.diagnostic, "har")
  assert.ok(diagnosticFile.size > 3 * 1024 * 1024)
  assert.ok(
    diagnosticFile.contents.length <= 4096,
    "large diagnostics return only a bounded source excerpt to React"
  )
  assert.ok(
    diagnosticFile.previewUrl,
    "inspection streams the original, not the truncated excerpt"
  )

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
  const homePath = `~/${relative(homedir(), join(root, "AGENTS.md"))}`
  assert.equal((await files.read(homePath)).contents, "// AGENTS.md\n", "home-relative asset paths open the actual file")
  const absentHome = `~/${relative(homedir(), join(root, "absent.ts"))}`
  assert.equal(await refused(absentHome), `No file at ${absentHome}`, "missing home paths never fall back to unrelated project names")
  for (const pattern of ["1-option-a-ledger-*.jpg", "shot?.png", "shot[12].png"]) assert.equal(inlineFileTarget(pattern), null, "file patterns remain literal")
  for (const name of ["report.docx", "measurements.xlsx", "review.pptx", "requests.har", "render.cpuprofile"]) {
    assert.equal(inlineFileTarget(name), null, "A preview format does not supply a file location")
    assert.ok(inlineFileTarget(`./${name}`), "Shared preview formats with a path remain file links")
  }
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
  assert.equal(
    settled,
    disconnected,
    "the error object itself is never replaced"
  )
  assert.equal(settled?.message, "gone")

  console.log(
    "Opening a linked file: named and partial paths resolve, ambiguity and absence read as sentences, and host errors lose Electron's IPC wrapper"
  )
} finally {
  await rm(outer, { recursive: true, force: true })
}
