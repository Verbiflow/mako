import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { after, test } from "node:test"
import type { HostEvent } from "@mako/host/contracts/host-events-boot"
import { STORAGE_LOW_BYTES, type StorageCollection } from "@mako/host/contracts/storage"
import { CursorCheckpointCollector } from "@mako/host/harnesses/cursor/sdk/checkpoint-collector"
import { MakoStorage, type HarnessStorage } from "@mako/host/usage/storage"
import { LeftoverFiles, RecordRepacks } from "@mako/host/usage/storage-collectors"

/**
 * Settings › Storage (`usage/storage.ts`): each folder at the top of Mako's roots, the small ones counted together; a
 * disk under the line warned about once, collected at once, and warned about again only after it had room. The Cursor
 * collector (`checkpoint-collector.ts`) sweeps in a worker, never a store a session holds, and skips a store it
 * already collected that hasn't moved.
 */
const scratch = await mkdtemp(join(tmpdir(), "mako-storage-"))
after(() => rm(scratch, { recursive: true, force: true }))
const GB = 1024 ** 3

test("parts, the warning and the collectors", async () => {
  const events: HostEvent[] = []
  const triggers: StorageCollection["trigger"][] = []
  const collector: HarnessStorage = {
    provider: "cursor",
    part: "cursor-sdk",
    collecting: () => false,
    last: () => undefined,
    async collect(trigger) {
      triggers.push(trigger)
      return { part: "cursor-sdk", at: new Date().toISOString(), trigger, freedBytes: 0, collected: 0, skipped: 0, ms: 0 }
    },
  }
  let free = 40 * GB
  const storage = new MakoStorage({
    roots: ["/user", "/data"],
    collectors: () => [collector],
    emit: (event) => events.push(event),
    measure: async (root) => root === "/user"
      ? new Map([["/user/cursor-sdk", 30 * GB], ["/user/records", 23 * GB], ["/user/views", 10 * 1024 ** 2]])
      : new Map([["/data/conversations", 2 * GB], ["/data/settings.json", 4096]]),
    disk: async () => ({ freeBytes: free, totalBytes: 926 * GB }),
  })
  const report = await storage.measure()
  assert.deepEqual(report.parts.map((part) => [part.id, part.label, part.collected]), [
    ["cursor-sdk", "Cursor agents", true],
    ["records", "Session records", false],
    ["conversations", "Conversation journals", false],
    ["rest", "Everything else", false],
  ], "the biggest first, each named, the small ones together")
  assert.equal(report.parts.at(-1)?.bytes, 10 * 1024 ** 2 + 4096)
  assert.equal(report.disk?.freeBytes, 40 * GB)

  await storage.watch()
  assert.equal(events.length, 0, "a disk with room says nothing")
  free = STORAGE_LOW_BYTES - GB
  await storage.watch()
  await storage.watch()
  assert.equal(events.length, 1, "under the line, Mako says so once")
  assert.match(JSON.stringify(events[0]), /9\.0 GB free.*Settings › Storage/)
  assert.deepEqual(triggers, ["low disk"], "and collects without waiting for the schedule")
  free = STORAGE_LOW_BYTES + GB
  await storage.watch()
  free = STORAGE_LOW_BYTES - GB
  await storage.watch()
  assert.equal(events.length, 1, "climbing just over the line doesn't warn again")
  free = STORAGE_LOW_BYTES + 3 * GB
  await storage.watch()
  free = STORAGE_LOW_BYTES - GB
  await storage.watch()
  assert.equal(events.length, 2, "once the disk had room, running low warns again")

  await storage.free()
  assert.deepEqual(triggers.at(-1), "person")
})

test("copies a process died before renaming go once it's gone and they're an hour old; nothing else does", async () => {
  const root = join(scratch, "leftovers")
  await mkdir(join(root, "folder.41.tmp"), { recursive: true })
  const hourAgo = new Date(Date.now() - 61 * 60_000)
  const write = async (name: string, old: boolean) => {
    await writeFile(join(root, name), "x".repeat(1000))
    if (old) await utimes(join(root, name), hourAgo, hourAgo)
  }
  await write("provider-profiles.json.41.tmp", true)
  await write("runtime-updates.json.42.tmp", true)
  await write("provider-profiles.json.43.tmp", false)
  await write("settings.json.tmp", true)
  await write("settings.json", true)
  const collector = new LeftoverFiles([root, join(scratch, "no-such-root")], (pid) => pid === 42)
  const pass = await collector.collect("scheduled")
  assert.deepEqual(await readdir(root).then((names) => names.sort()), ["folder.41.tmp", "provider-profiles.json.43.tmp", "runtime-updates.json.42.tmp", "settings.json", "settings.json.tmp"],
    "the dead writer's old copy went; a live writer's, a recent one, a folder and files not named for a pid stayed")
  assert.deepEqual([pass.part, pass.collected, pass.skipped, pass.freedBytes], ["rest", 1, 2, 1000])
  assert.equal(collector.last(), pass)

  const measured = await new MakoStorage({ roots: [root], collectors: () => [collector], emit: () => {}, measure: async () => new Map([[join(root, "settings.json"), 1000]]), disk: async () => ({ freeBytes: 40 * GB, totalBytes: 926 * GB }) }).measure()
  assert.deepEqual(measured.parts.map((part) => [part.id, part.collected]), [["rest", true]], "Settings › Storage says Mako collects the rest")
})

test("the records' repack shows as the daemon's last pass wrote it", async () => {
  const folder = join(scratch, "records")
  await mkdir(folder, { recursive: true })
  const collector = new RecordRepacks(folder)
  assert.equal((await collector.collect("person")).freedBytes, 0)
  assert.equal(collector.last(), undefined, "nothing until a pass has repacked")
  const pass = { reason: "again", pid: 1, startedAt: Date.parse("2026-11-02T10:00:00.000Z"), endedAt: Date.parse("2026-11-02T10:04:00.000Z"), sessions: 10, done: 10, held: 10, captured: 0, live: 0, gone: 0, refused: 0, failed: 0, newBytes: 0, storedBytes: 0, ms: 1, yieldedMs: 0, longestMs: 0, longestReadMs: 0 }
  const repack = { dropped: 9, droppedBytes: 3 * GB, scrubbedBytes: 0, grouped: 0, alreadyGrouped: 0, copied: 4, copiedBytes: 2 * GB, packsWritten: 2, packsRemoved: 3, packBytesBefore: 20 * GB, packBytesAfter: 19 * GB, ms: 118_000, longestTurnMs: 20, skipped: { group: true, compact: false } }
  await writeFile(join(folder, "backfill.json"), JSON.stringify({ ...pass, repack }))
  const last = await collector.collect("person")
  assert.deepEqual(last, { part: "records", at: "2026-11-02T10:04:00.000Z", trigger: "scheduled", freedBytes: GB, collected: 1, skipped: 0, ms: 118_000 }, "on the daemon's schedule, whoever asked")
  assert.equal(collector.last(), last)
  await writeFile(join(folder, "backfill.json"), JSON.stringify({ ...pass, endedAt: undefined, repack: undefined }))
  assert.equal(await collector.collect("scheduled"), last, "a pass under way leaves the last one shown")
})

const sha = (text: string) => createHash("sha256").update(text).digest("hex")
const field = (number: number, data: Buffer) => Buffer.concat([Buffer.from([(number << 3) | 2, data.length]), data])
const checkpoint = (blobId: string) => JSON.stringify({ blobId, storeKind: "local-agent-store" })

/** An idle agent from a month ago whose one run left `steps` roots behind. */
async function agent(stateRoot: string, id: string, steps: number): Promise<{ path: string; directory: string }> {
  const directory = `agent-${sha(id)}`
  await mkdir(join(stateRoot, "agents", directory), { recursive: true })
  const path = join(stateRoot, "agents", directory, "store.db")
  const store = new DatabaseSync(path)
  store.exec("PRAGMA journal_mode = WAL; CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB); CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)")
  const put = (data: Buffer) => {
    const key = sha(data.toString("hex"))
    store.prepare("INSERT OR REPLACE INTO blobs VALUES (?, ?)").run(key, data)
    return key
  }
  const messages = Array.from({ length: 40 }, (_, at) => put(Buffer.from(JSON.stringify({ role: "user", content: `message ${at}` }))))
  const root = (count: number, step: number) => put(Buffer.concat([...messages.slice(0, count).map((key) => field(1, Buffer.from(key, "hex"))), field(9, Buffer.from(`step ${step}`))]))
  for (let step = 0; step < steps; step++) root(1 + (step % 38), step)
  const latest = root(40, steps)
  store.close()
  // Last written a month ago, as the index says.
  const month = new Date("2026-10-01T00:00:00.000Z")
  await utimes(path, month, month)
  const index = new DatabaseSync(join(stateRoot, "index.db"))
  index.exec(
    "CREATE TABLE IF NOT EXISTS agents (agent_id TEXT PRIMARY KEY, workspace_ref TEXT NOT NULL, status TEXT NOT NULL, latest_checkpoint_ref_json TEXT, name TEXT, metadata_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);" +
      "CREATE TABLE IF NOT EXISTS runs (run_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, turn_number INTEGER NOT NULL, status TEXT NOT NULL, model TEXT, model_params_json TEXT, start_checkpoint_ref_json TEXT, latest_checkpoint_ref_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);"
  )
  index.prepare("INSERT INTO agents VALUES (?, '/tmp', 'IDLE', ?, 'Agent', '{}', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')").run(id, checkpoint(latest))
  index.prepare("INSERT INTO runs VALUES (?, ?, 1, 'FINISHED', 'auto', NULL, NULL, ?, '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')").run(`${id}-run`, id, checkpoint(latest))
  index.close()
  return { path, directory }
}

const rows = (path: string) => {
  const database = new DatabaseSync(path, { readOnly: true })
  try {
    return Number(database.prepare("SELECT count(*) AS n FROM blobs").get()?.["n"])
  } finally {
    database.close()
  }
}

test("the Cursor collector leaves a held store alone and skips one that hasn't moved", async () => {
  const stateRoot = join(scratch, "cursor-sdk")
  const id = "44444444-4444-4444-8444-444444444444"
  const { path, directory } = await agent(stateRoot, id, 600)
  const stampsPath = join(scratch, "cursor-checkpoints.json")
  const collector = new CursorCheckpointCollector({ stateRoot, stampsPath })
  const all = rows(path)

  const release = await collector.hold([id])
  const held = await collector.collect("scheduled")
  assert.deepEqual([held.collected, held.skipped], [0, 1], "a store a session holds is skipped")
  assert.equal(rows(path), all, "and untouched")
  release()

  const pass = collector.collect("scheduled")
  assert.equal(collector.collecting(), true)
  assert.equal(collector.collect("person"), pass, "a pass asked for while one runs is that pass")
  const swept = await pass
  assert.deepEqual([swept.collected, swept.skipped], [1, 0])
  assert.equal(rows(path), all - 600, "every root no run names went, the messages and the run's root stayed")
  assert.ok(JSON.parse(await readFile(stampsPath, "utf8"))[directory], "the store's stamp is kept for the next pass")
  assert.equal(collector.last(), swept)

  const again = await collector.collect("scheduled")
  assert.deepEqual([again.collected, again.skipped], [0, 1], "a store that hasn't moved since is skipped")
})
