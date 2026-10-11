import assert from "node:assert/strict"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { SessionCatalog } from "../dist/catalog.js"
import { CursorProvider } from "../dist/providers/cursor.js"
import { NativeStores } from "../dist/read-only-sqlite.js"

const nativeStores = new NativeStores(false)

async function writeStore(directory, meta) {
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
          content: [{ type: "text", text: "<user_query>hello</user_query>" }],
        })
      )
    )
    db.prepare("INSERT INTO blobs VALUES (?, ?)").run(
      "root",
      Buffer.concat([Buffer.from([10, 32]), hash])
    )
    db.prepare("INSERT INTO meta VALUES (?, ?)").run(
      "0",
      JSON.stringify({
        agentId: meta.agentId,
        name: meta.name,
        latestRootBlobId: "root",
        ...meta.extra,
      })
    )
  } finally {
    db.close()
  }
  return path
}

const home = await mkdtemp(join(tmpdir(), "mako-cursor-subagent-"))
try {
  const parentId = "11111111-1111-4111-8111-111111111111"
  const childId = "22222222-2222-4222-8222-222222222222"
  const parentPath = await writeStore(
    join(home, ".cursor", "acp-sessions", parentId),
    { agentId: parentId, name: "Sales Opps CSV" }
  )
  const childPath = await writeStore(
    join(home, ".cursor", "chats", "workspace", childId),
    {
      agentId: childId,
      name: "New Agent",
      extra: {
        subagentInfo: {
          parentAgentId: parentId,
          rootParentAgentId: parentId,
          toolCallId: "call_child",
          typeName: "generalPurpose",
        },
      },
    }
  )
  const provider = new CursorProvider(nativeStores, home)
  const files = await provider.discover()
  const parentFile = files.find((file) => file.path === parentPath)
  const childFile = files.find((file) => file.path === childPath)
  assert.ok(parentFile)
  assert.ok(childFile, "subagent stores are still on disk")
  assert.equal((await provider.peek(parentFile)).title, "Sales Opps CSV")
  assert.equal(await provider.peek(childFile), null)

  const catalog = new SessionCatalog([provider])
  const refs = await catalog.scan()
  assert.deepEqual(
    refs.map((ref) => ref.nativeId),
    [parentId]
  )

  const removed = []
  catalog.onEvent((event) => {
    if (event.type === "removed") removed.push(event.path)
  })
  const db = new DatabaseSync(parentPath)
  try {
    db.prepare("UPDATE meta SET value = ? WHERE key = '0'").run(
      JSON.stringify({
        agentId: parentId,
        name: "Sales Opps CSV",
        latestRootBlobId: "root",
        subagentInfo: {
          parentAgentId: "other",
          rootParentAgentId: "other",
          toolCallId: "late",
          typeName: "generalPurpose",
        },
      })
    )
  } finally {
    db.close()
  }
  await writeFile(
    join(home, ".cursor", "acp-sessions", parentId, "meta.json"),
    JSON.stringify({ cwd: home, title: "Sales Opps CSV" })
  )
  await catalog.scan({ emitChanges: true })
  assert.deepEqual(removed, [parentPath])
  assert.deepEqual(await catalog.scan(), [])
  console.log(
    "Cursor subagent stores stay on disk and out of the catalog; a later subagentInfo drop removes the row"
  )
} finally {
  await rm(home, { recursive: true, force: true })
}
