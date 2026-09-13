import assert from "node:assert/strict"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { SessionCatalog } from "../dist/catalog.js"
import { threadIdentity } from "../dist/format.js"
import { CursorProvider } from "../dist/providers/cursor.js"

async function writeStore(directory, meta, prompt) {
  await mkdir(directory, { recursive: true })
  const path = join(directory, "store.db")
  const db = new DatabaseSync(path)
  try {
    db.exec(
      "CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB); CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)"
    )
    const hash = Buffer.alloc(32, 1)
    db.prepare("INSERT INTO blobs VALUES (?, ?)").run(
      hash.toString("hex"),
      Buffer.from(
        JSON.stringify({
          role: "user",
          content: [{ type: "text", text: `<user_query>${prompt}</user_query>` }],
        })
      )
    )
    db.prepare("INSERT INTO blobs VALUES (?, ?)").run(
      "root",
      Buffer.concat([Buffer.from([10, 32]), hash])
    )
    db.prepare("INSERT INTO meta VALUES (?, ?)").run(
      "0",
      JSON.stringify({ latestRootBlobId: "root", ...meta })
    )
  } finally {
    db.close()
  }
  return path
}

// `cursor-agent -p --resume <id>` on an ACP session writes its new turns to
// a second store under chats/ with the same agent id. Before this the catalog
// collapsed the two by native id and the newer, one-turn fork replaced the
// whole original in the rail.
const home = await mkdtemp(join(tmpdir(), "mako-cursor-fork-"))
try {
  const id = "33333333-3333-4333-8333-333333333333"
  const original = await writeStore(
    join(home, ".cursor", "acp-sessions", id),
    { agentId: id, name: "Mako Relay Investigation" },
    "investigate the relay"
  )
  await writeFile(
    join(home, ".cursor", "acp-sessions", id, "meta.json"),
    JSON.stringify({ cwd: home, title: "Mako Relay Investigation", updatedAtMs: 1_000 })
  )
  const fork = await writeStore(
    join(home, ".cursor", "chats", "workspace", id),
    { agentId: id, name: "New Agent", isRunEverything: true },
    "Q1. Who is the user"
  )
  await writeFile(
    join(home, ".cursor", "chats", "workspace", id, "meta.json"),
    JSON.stringify({ cwd: home, hasConversation: true, updatedAtMs: 2_000 })
  )
  const provider = new CursorProvider(home)
  const files = await provider.discover()
  const originalRef = await provider.peek(files.find((file) => file.path === original))
  const forkRef = await provider.peek(files.find((file) => file.path === fork))
  assert.equal(originalRef.nativeId, id)
  assert.equal(forkRef.nativeId, id, "both stores keep the agent id their CLI resumes by")
  assert.equal(originalRef.identity, undefined)
  assert.equal(originalRef.liveResume, undefined, "the acp-sessions store answers session/load")
  assert.equal(forkRef.identity, `chats:${id}`)
  assert.equal(forkRef.liveResume, false, "a chats store continues only through the CLI")
  assert.notEqual(threadIdentity(originalRef), threadIdentity(forkRef))

  const catalog = new SessionCatalog([provider])
  const refs = await catalog.scan()
  assert.deepEqual(
    refs.map((ref) => [ref.path, ref.title]),
    [
      [fork, "Q1. Who is the user"],
      [original, "Mako Relay Investigation"],
    ],
    "both rows are listed, newest first, and the original is not hidden"
  )
  console.log("Cursor fork: an acp-sessions store and its chats continuation are two rows with one agent id")
} finally {
  await rm(home, { recursive: true, force: true })
}
