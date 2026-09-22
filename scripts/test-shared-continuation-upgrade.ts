import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { SessionMemory } from "../electron/session-memory.ts"

const root = mkdtempSync(join(tmpdir(), "mako-owner-upgrade-"))
const path = join(root, "memory.sqlite")
try {
  const legacy = new DatabaseSync(path)
  legacy.exec(`CREATE TABLE conversation_routes (conversation_id TEXT PRIMARY KEY,
    provider TEXT NOT NULL, native_id TEXT NOT NULL, socket TEXT NOT NULL);
    INSERT INTO conversation_routes VALUES ('legacy', 'codex', 'native', '/legacy.sock');`)
  legacy.close()
  const source = `import { SessionMemory } from ${JSON.stringify(new URL("../electron/session-memory.ts", import.meta.url).href)};
  const memory = new SessionMemory(process.argv[1], { pid: process.pid, startedAt: Date.now(), label: 'upgrade fixture', socket: process.argv[2] });
    memory.close();`
  await Promise.all(Array.from({ length: 4 }, (_, index) => new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source, path, `/fixture-${index}.sock`], { stdio: ["ignore", "ignore", "pipe"] })
    let errors = ""
    child.stderr.on("data", (chunk: Buffer) => { errors += chunk.toString() })
    child.on("error", reject)
    child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(errors)))
  })))
    let identity: "current" | "reused" | "unavailable" = "current"
  const holder = new SessionMemory(path, { pid: 91001, startedAt: 1, label: "suspended", socket: "/suspended.sock" }, { now: () => 1, alive: () => true })
  const observer = new SessionMemory(path, { pid: 91002, startedAt: 2, label: "observer", socket: "/observer.sock" }, {
    now: () => 1_000_000, alive: () => true,
    identityCurrent: async () => {
      if (identity === "unavailable") throw new Error("OS probe unavailable")
      return identity === "current"
    },
  })
  try {
    holder.hold("fixture", "suspended-native", "suspended-conversation")
    await observer.reconcileHolds()
    assert.ok(observer.heldBy("fixture", "suspended-native"), "sleep cannot expire a live writer")
    identity = "unavailable"
    await observer.reconcileHolds()
    assert.ok(observer.heldBy("fixture", "suspended-native"), "failed process identity probes cannot release a writer")
    identity = "reused"
    await observer.reconcileHolds()
    assert.equal(observer.heldBy("fixture", "suspended-native"), null, "a reused PID does not pin an abandoned native session")
    assert.equal(observer.routeForSession("fixture", "suspended-native")?.conversationId, "suspended-conversation", "reaping a writer preserves its journal route")
  } finally { observer.close(); holder.close() }
  const memory = new SessionMemory(path, { pid: process.pid, startedAt: Date.now(), label: "reader", socket: "/reader.sock" })
  try {
    assert.equal(memory.routeForSession("codex", "native")?.conversationId, "legacy")
    memory.rememberBindings("many-bindings", Array.from({ length: 10_000 }, (_, index) => ({ provider: "fixture", nativeId: `session-${index}` })), 1)
    const began = performance.now()
    for (let index = 0; index < 10_000; index++)
      assert.equal(memory.routeForSession("fixture", `session-${index}`)?.conversationId, "many-bindings")
    console.log(`Shared ownership upgrade: four concurrent processes, legacy schema retained; 10,000 indexed lookups in ${(performance.now() - began).toFixed(1)} ms`)
    const reader = new DatabaseSync(path)
    try {
      assert.deepEqual(reader.prepare("SELECT version FROM session_memory_migrations ORDER BY version").all().map((row) => row.version), [1, 2])
      assert.equal(reader.prepare("PRAGMA integrity_check").get()?.integrity_check, "ok")
    } finally { reader.close() }
  } finally { memory.close() }
} finally { rmSync(root, { recursive: true, force: true }) }
