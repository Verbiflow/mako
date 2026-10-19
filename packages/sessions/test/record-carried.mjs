import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"
import { NativeStores } from "../dist/read-only-sqlite.js"
import { RecordCapture } from "../dist/record-capture.js"
import { carriedFiles, carriedFolders, noteCarried, withCarried } from "../dist/record-carried.js"
import { RecordStore } from "../dist/record-store.js"

/**
 * The transcript a session was given is the session's own: noted once the
 * session has its native id, captured with its records under a root of its
 * own, counted in its stamp, and written back where its first turn names it
 * when the session is restored into another home.
 */

const root = await mkdtemp(join(tmpdir(), "mako-record-carried-"))
try {
  const home = join(root, "home")
  const records = join(root, "records")
  const session = join(home, "sessions", "s1.jsonl")
  await mkdir(join(home, "sessions"), { recursive: true })
  await writeFile(session, `{"n":1}\n`)
  const context = join(home, "Library", "Application Support", "mako", "conversations", "context")
  const folder = join(context, "4f2a")
  await mkdir(join(folder, "payloads"), { recursive: true })
  await writeFile(join(folder, "transcript.md"), "# Transcript\n\nTurn 1: remember LANTERN\n")
  await writeFile(join(folder, "payloads", "turn-1-call-1.txt"), "x".repeat(5000))
  const own = { roots: [{ name: "synthetic", path: home }], files: [session], databases: [] }

  assert.deepEqual(await carriedFolders(records, "synthetic", "s1"), [], "a session given nothing has nothing noted")
  await noteCarried(records, "synthetic", "s1", folder)
  await noteCarried(records, "synthetic", "s1", folder)
  assert.deepEqual(await carriedFolders(records, "synthetic", "s1"), [folder], "noting a folder twice notes it once")
  const carried = await carriedFiles(records, "synthetic", "s1")
  assert.deepEqual(carried.flatMap(({ files }) => files.map(({ path }) => relative(folder, path))), ["payloads/turn-1-call-1.txt", "transcript.md"])
  const withTranscript = withCarried(own, carried)
  assert.equal(withTranscript.roots.length, 2, "the folder's parent is a root of its own")
  assert.match(withTranscript.roots[1].name, /^mako-carried@[0-9a-f]{8}$/)

  // Captured with the session through the capture the catalog runs, and counted in its stamp.
  const store = new RecordStore(join(records, "store"), new NativeStores(false))
  const capture = new RecordCapture(store, async () => own, { home, carried: records, stampOf: () => "native" })
  const before = await capture.stamp({ harness: "synthetic", nativeId: "s1", path: session })
  const taken = await capture.backfill({ harness: "synthetic", nativeId: "s1", path: session })
  assert.equal(taken.kind, "captured", JSON.stringify(taken, (key, value) => value instanceof Error ? value.message : value))
  const units = store.units("synthetic", "s1").map((unit) => unit.key).sort()
  assert.ok(units.some((key) => key.endsWith(":4f2a/transcript.md")) && units.some((key) => key.endsWith(":4f2a/payloads/turn-1-call-1.txt")),
    `the transcript and its payload are units of the session: ${units.join(", ")}`)
  await writeFile(join(folder, "payloads", "turn-2-call-1.txt"), "more")
  assert.notEqual(await capture.stamp({ harness: "synthetic", nativeId: "s1", path: session }), before, "a file added to the folder moves the session's stamp")

  // Restored into another home: the transcript is where the session's first turn names it, relative to that home.
  const elsewhere = join(root, "elsewhere")
  const restored = await store.restore({ harness: "synthetic", nativeId: "s1", home: elsewhere })
  assert.ok(restored.written && !restored.diverged.length, JSON.stringify(restored.diverged))
  const back = join(elsewhere, relative(home, folder))
  assert.equal(await readFile(join(back, "transcript.md"), "utf8"), "# Transcript\n\nTurn 1: remember LANTERN\n")
  assert.equal((await readFile(join(back, "payloads", "turn-1-call-1.txt"), "utf8")).length, 5000)
  await capture.stop()
  console.log("PASS: a session's transcript is its own: noted once, captured with it, counted in its stamp, restored where its first turn names it")
} finally {
  await rm(root, { recursive: true, force: true })
}
