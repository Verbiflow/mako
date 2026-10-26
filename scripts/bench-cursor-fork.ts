import { execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { performance } from "node:perf_hooks"
import { Agent, Cursor } from "@cursor/sdk"
import { SqliteLocalAgentStore } from "@cursor/sdk/sqlite"
import { cursorSdkDirectoryName } from "@mako/sessions/cursor-sdk-index"
import { cursorSdkIndexPath, cursorSdkStateRoot, cursorSdkStorePath } from "@mako/sessions/cursor-sdk-paths"
import { makoUserRoot } from "@mako/sessions/mako-root"
import { NativeStores } from "@mako/sessions/read-only-sqlite"
import { z } from "zod"
import { cloneCursorForkStore, cursorForkMetadata, cursorForkPoint, readCursorForkRun } from "@mako/host/harnesses/cursor/sdk/fork"

/**
 * What a native Cursor fork costs on this Mac's largest SDK agent, read-only:
 * the real store is only read (strict stores, inside a read transaction), and
 * the fork lands in a fixture state root that is deleted at the end. Times the
 * clone and the meta rewrite, then the index row and the SDK's `Agent.resume`
 * of the fork, with the process's peak memory after each and the disk the
 * clone took. `--vacuum` also times `VACUUM INTO`, the byte copy side
 * questions and imports make, for comparison; it needs the store's size free.
 *
 *   npm run bench:cursor-fork [-- --agent <id>] [-- --vacuum]
 */

const args = process.argv.slice(2)
const named = args.includes("--agent") ? args[args.indexOf("--agent") + 1] : undefined
// The person's agents, read strictly: the bench forks a copy in a scratch root.
const stateRoot = cursorSdkStateRoot(makoUserRoot())
const real = new NativeStores(true)
const megabytes = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`
const peak = () => megabytes(process.resourceUsage().maxRSS * 1024)
const freeBytes = () => Number(execFileSync("/bin/df", ["-k", tmpdir()]).toString().trim().split("\n").at(-1)!.split(/\s+/)[3]) * 1024

/** The agent whose store is largest, unless one is named. */
function largest(): string {
  const agents = join(stateRoot, "agents")
  const sizes = readdirSync(agents).flatMap((name) => {
    try {
      return [{ name, size: statSync(join(agents, name, "store.db")).size }]
    } catch {
      return []
    }
  }).sort((a, b) => b.size - a.size)
  const index = real.open(cursorSdkIndexPath(stateRoot))
  try {
    const ids = index.prepare("SELECT agent_id FROM agents").all().map((row) => String(row["agent_id"]))
    for (const { name } of sizes) {
      const id = ids.find((candidate) => cursorSdkDirectoryName(candidate) === name)
      if (id) return id
    }
  } finally {
    index.close()
  }
  throw new Error("No SDK agent in the index has a store")
}

console.log(`peak RSS once loaded: ${peak()}`)
const source = named ?? largest()
const { runIds, metadata } = (() => {
  const index = real.open(cursorSdkIndexPath(stateRoot))
  try {
    const row = index.prepare("SELECT metadata_json FROM agents WHERE agent_id = ?").get(source)
    if (!row) throw new Error(`The index has no agent ${source}`)
    return {
      runIds: index.prepare("SELECT run_id FROM runs WHERE agent_id = ? ORDER BY turn_number").all(source).map((run) => String(run["run_id"])),
      metadata: z.looseObject({}).parse(JSON.parse(z.string().parse(row["metadata_json"]))),
    }
  } finally {
    index.close()
  }
})()
// A run halfway through the conversation, among those Cursor checkpointed.
const forkable = runIds.filter((runId) => cursorForkPoint(readCursorForkRun(real, stateRoot, source, runId)).kind === "root")
const run = forkable[Math.floor(forkable.length / 2)]
if (!run) throw new Error("No run of that agent checkpointed anything")
const point = cursorForkPoint(readCursorForkRun(real, stateRoot, source, run))
if (point.kind !== "root") throw new Error(point.reason)
const sourceStore = cursorSdkStorePath(stateRoot, source)
const size = statSync(sourceStore).size
console.log(`source: ${megabytes(size)} store, ${runIds.length} runs; forking at run ${runIds.indexOf(run) + 1}; peak RSS before the fork ${peak()}`)

const root = mkdtempSync(join(tmpdir(), "mako-live-test-cursor-fork-bench-"))
const forkRoot = join(root, "state")
const cwd = join(root, "work")
mkdirSync(cwd, { recursive: true })
try {
  const stores = new NativeStores(true, root)
  const fork = randomUUID()
  const target = cursorSdkStorePath(forkRoot, fork)
  const freeBefore = freeBytes()
  let started = performance.now()
  cloneCursorForkStore(stores, { source: sourceStore, target, agentId: fork, rootBlobId: point.rootBlobId })
  console.log(`clone, meta and fold: ${(performance.now() - started).toFixed(0)} ms, peak RSS ${peak()}, disk taken ${megabytes(Math.max(0, freeBefore - freeBytes()))} for a ${megabytes(statSync(target).size)} store`)

  started = performance.now()
  const store = await SqliteLocalAgentStore.open({ workspaceRef: cwd, stateRoot: forkRoot })
  try {
    Cursor.configure({ local: { store } })
    const now = Date.now()
    await store.agents.create({ agent: { agentId: fork, cwd, status: "idle", name: "Fork benchmark", createdAt: now, updatedAt: now, latestCheckpoint: { schemaVersion: 1, rootBlobId: point.rootBlobId }, sdkMetadata: cursorForkMetadata(metadata) } })
    const indexed = performance.now()
    const handle = await Agent.resume(fork, { apiKey: "key_benchmark_offline", local: { cwd, store } })
    console.log(`index row: ${(indexed - started).toFixed(0)} ms; Agent.resume: ${(performance.now() - indexed).toFixed(0)} ms, peak RSS ${peak()}`)
    await handle[Symbol.asyncDispose]?.()
  } finally {
    await store.dispose()
  }

  if (args.includes("--vacuum")) {
    if (freeBytes() < size * 1.5) console.log(`VACUUM INTO skipped: ${megabytes(freeBytes())} free for a ${megabytes(size)} copy`)
    else {
      const copy = join(root, "vacuum.db")
      const reader = real.open(sourceStore)
      started = performance.now()
      try {
        reader.exec(`VACUUM INTO '${copy.replaceAll("'", "''")}'`)
      } finally {
        reader.close()
      }
      console.log(`VACUUM INTO: ${(performance.now() - started).toFixed(0)} ms, peak RSS ${peak()}, ${megabytes(statSync(copy).size)} written`)
    }
  }
} finally {
  rmSync(root, { recursive: true, force: true })
}
