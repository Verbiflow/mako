import assert from "node:assert/strict"
import { mkdtemp, mkdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { CursorProvider } from "../dist/providers/cursor.js"

// A long agent's store holds a gigabyte of tool output behind the few
// prompts a first page shows. The newest exchanges fold from the end of the
// hash list alone, and read exactly as the whole fold's tail.
const home = await mkdtemp(join(tmpdir(), "mako-cursor-recent-"))
try {
  const directory = join(home, ".cursor", "acp-sessions", "recent-agent")
  await mkdir(directory, { recursive: true })
  const path = join(directory, "store.db")
  const db = new DatabaseSync(path)
  db.exec("CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB); CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)")
  const insert = db.prepare("INSERT INTO blobs VALUES (?, ?)")
  const hashes = []
  const message = (value) => {
    const hash = Buffer.alloc(32, hashes.length + 1)
    insert.run(hash.toString("hex"), Buffer.from(JSON.stringify(value)))
    hashes.push(hash)
  }
  const output = "x".repeat(10_000)
  for (let turn = 1; turn <= 4; turn++) {
    message({ role: "user", content: [{ type: "text", text: `<user_query>prompt ${turn}</user_query>` }] })
    message({ role: "assistant", content: [{ type: "tool-call", toolCallId: `call-${turn}`, toolName: "Shell", args: { command: "ls" } }] })
    message({ role: "tool", content: [{ type: "tool-result", toolCallId: `call-${turn}`, toolName: "Shell", result: output }] })
    message({ role: "assistant", content: [{ type: "text", text: `answer ${turn}` }] })
  }
  insert.run("root", Buffer.concat(hashes.flatMap((hash) => [Buffer.from([10, 32]), hash])))
  db.prepare("INSERT INTO meta VALUES ('0', ?)").run(JSON.stringify({ agentId: "recent-agent", name: "Recent", latestRootBlobId: "root" }))
  db.close()

  const provider = new CursorProvider(home, {})
  const whole = await provider.read(path)
  assert.ok(whole)
  const prompts = (entries) => entries.filter((entry) => entry.kind === "user").map((entry) => entry.text)
  assert.deepEqual(prompts(whole.entries), ["prompt 1", "prompt 2", "prompt 3", "prompt 4"])

  const last = await provider.recent(path, 1)
  assert.deepEqual(prompts(last), ["prompt 4"], "a small budget folds from the last prompt")
  assert.deepEqual(last, whole.entries.slice(-last.length), "the newest exchange reads as the whole fold's tail")

  const two = await provider.recent(path, 25_000)
  assert.deepEqual(prompts(two), ["prompt 3", "prompt 4"], "the budget reaches back to the earliest prompt it covers")
  assert.deepEqual(two, whole.entries.slice(-two.length))

  assert.equal(await provider.recent(path, 1_000_000), null, "a budget reaching the first prompt leaves it to the whole read")
  console.log("cursor-recent: ok")
} finally {
  await rm(home, { recursive: true, force: true })
}
