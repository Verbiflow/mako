import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { appendFile, mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { setTimeout as delay } from "node:timers/promises"
import { SessionCatalog } from "../dist/catalog.js"
import { CodexProvider } from "../dist/providers/codex.js"
import { NativeStores } from "../dist/read-only-sqlite.js"
import { RecordBackfill, backfillProgress } from "../dist/record-backfill.js"
import { RecordCapture } from "../dist/record-capture.js"
import { readStreamOriginal } from "../dist/record-original.js"
import { RecordStore } from "../dist/record-store.js"
import { pruneStreams } from "../dist/record-stream-prune.js"
import { claimStreamWriter, STREAMS_ROOT, streamPath, streamsRoot, streamWriterGone } from "../dist/record-streams.js"

/**
 * The backfill takes every session in the rail into the record store, newest
 * first, once, and then only what moved; continues after a stop where it
 * left off; yields to live captures; refuses what the disk can't hold;
 * forgets what the person deletes and keeps what the harness deletes; and
 * prunes the loose stream files the store holds whole.
 */

const nativeStores = new NativeStores(false)
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex")
const measured = []

async function until(check, what, ms = 10_000) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (await check()) return
    await delay(10)
  }
  assert.fail(`timed out waiting for ${what}`)
}

async function stored(store, harness, key) {
  const parts = []
  for await (const part of store.content(harness, key)) parts.push(part)
  return Buffer.concat(parts)
}

const line = (type, payload) => `${JSON.stringify({ timestamp: new Date().toISOString(), type, payload })}\n`
const message = (role, text) => line("response_item", { type: "message", role, content: [{ type: role === "user" ? "input_text" : "output_text", text }] })

/** A Codex home with `count` threads, the newest last, each a rollout and a state row. */
async function codexHome(home, count) {
  const dated = join(home, ".codex", "sessions", "2026", "10", "14")
  await mkdir(dated, { recursive: true })
  const state = new DatabaseSync(join(home, ".codex", "state_5.sqlite"))
  state.exec("CREATE TABLE IF NOT EXISTS threads (id TEXT PRIMARY KEY, name TEXT, title TEXT, cwd TEXT, updated_at_ms INTEGER, thread_source TEXT, rollout_path TEXT)")
  const threads = []
  for (let index = 0; index < count; index++) {
    const id = `01a0e74f-b716-77a2-8b46-${String(index).padStart(12, "0")}`
    const path = join(dated, `rollout-2026-10-14T02-${String(10 + index).padStart(2, "0")}-00-${id}.jsonl`)
    await writeFile(path, line("session_meta", { id, cwd: home }) + message("user", `Task ${index}`) + message("assistant", `Done ${index}. ${"x".repeat(20_000 * (index + 1))}`))
    const at = new Date(Date.UTC(2026, 9, 14, 2, index))
    await utimes(path, at, at)
    state.prepare("INSERT INTO threads VALUES (?, NULL, ?, ?, ?, 'user', ?)").run(id, `Task ${index}`, home, at.getTime(), path)
    threads.push({ id, path })
  }
  state.close()
  return threads
}

const home = await mkdtemp(join(tmpdir(), "mako-record-backfill-"))
try {
  const threads = await codexHome(home, 5)
  const recordsPath = join(home, "mako-records")
  const streams = streamsRoot(recordsPath)
  const logs = []
  const log = (text, fields) => logs.push({ text, fields })

  // A stream of the newest thread, from a writer long gone, and one from this process, which still runs.
  const newest = threads.at(-1)
  await mkdir(join(streams, "codex"), { recursive: true })
  const header = (writer) => `${JSON.stringify({ capture: 1, harness: "codex", conversation: "c", session: { threadId: newest.id }, ...writer && { writer } })}\n`
  const frame = (method) => `${JSON.stringify({ at: new Date().toISOString(), message: { method, params: { threadId: newest.id } } })}\n`
  const finished = streamPath(streams, "codex", "2026-10-14T03-00-00-000Z-c.jsonl", newest.id)
  await writeFile(finished, header({ id: "1-1", pid: 2 ** 22 + 1 }) + frame("turn/started") + frame("turn/completed"))
  const ours = claimStreamWriter(streams)
  assert.ok(ours, "this process claims itself as a writer")
  assert.equal(streamWriterGone(streams, ours), false, "a writer whose process runs isn't gone")
  const running = streamPath(streams, "codex", "2026-10-14T03-10-00-000Z-c.jsonl", newest.id)
  await writeFile(running, header(ours) + frame("turn/started"))
  const legacy = streamPath(streams, "codex", "2026-10-14T02-50-00-000Z-c.jsonl", newest.id)
  await writeFile(legacy, header(null) + frame("turn/started"))
  // A launch this process ran and that ended: its last line says so, and its writer still runs.
  const closedLaunch = streamPath(streams, "codex", "2026-10-14T02-55-00-000Z-c.jsonl", newest.id)
  await writeFile(closedLaunch, header(ours) + frame("turn/started") + `${JSON.stringify({ at: new Date().toISOString(), closed: true })}\n` + frame("thread/closed") + `${JSON.stringify({ at: new Date().toISOString(), ended: true })}\n`)

  // Discovery alone captures nothing; the backfill, once watching starts, takes every session, newest first.
  const catalog = new SessionCatalog([new CodexProvider(nativeStores, home)], { recordsPath, recordsHome: home, backfill: true, log })
  const listed = await catalog.scan()
  catalog.startWatching()
  await until(() => catalog.backfillProgress?.endedAt, "the first pass")
  const first = catalog.backfillProgress
  assert.equal(first.sessions, 5)
  assert.equal(first.captured, 5, "every session in the rail is taken")
  assert.equal(first.refused + first.failed + first.gone, 0)
  const look = new RecordStore(recordsPath, nativeStores)
  const order = look.captures({ limit: 50 }).reverse().map((capture) => capture.nativeId)
  assert.deepEqual(order, listed.map((ref) => ref.nativeId), "newest first, as the rail lists them")
  for (const thread of threads) {
    const [unit] = look.units("codex", thread.id).filter((candidate) => candidate.key.endsWith(".jsonl") && !candidate.key.startsWith(STREAMS_ROOT))
    assert.equal(sha(await stored(look, "codex", unit.key)), sha(await readFile(thread.path)), `${thread.id} is held whole`)
    assert.ok(look.heldStamp("codex", thread.id), "with the stamp it was taken at")
  }
  assert.ok(logs.some((entry) => entry.text === "Session records backfill done" && entry.fields.captured === 5 && entry.fields.newBytes > 0), "the pass logs its counts and bytes")
  const saved = await backfillProgress(recordsPath)
  assert.equal(saved?.captured, 5, "and writes its progress beside the store")

  // Streams: the launch that ended and the one whose writer is gone, held whole, are pruned; the running one and the one naming no writer stay.
  assert.equal(first.prune?.pruned, 2, "two loose streams pruned")
  assert.equal(first.prune?.prunedEnded, 1, "one by its ended line, while its writer still runs")
  assert.equal(first.prune?.restamped, 1, "and the session's held stamp moved with them")
  assert.equal(first.prune?.live, 1)
  assert.equal(first.prune?.unnamed, 1)
  await assert.rejects(stat(finished), { code: "ENOENT" })
  await assert.rejects(stat(closedLaunch), { code: "ENOENT" })
  await stat(running)
  await stat(legacy)
  const finishedKey = `${STREAMS_ROOT}:codex/${encodeURIComponent(newest.id)}@2026-10-14T03-00-00-000Z-c.jsonl`
  const finishedSize = look.units("codex", newest.id).find((unit) => unit.key === finishedKey)?.size
  assert.ok(finishedSize > 0, "the pruned stream is still held")
  // Its lines still read as originals, from the store.
  const firstLine = Buffer.byteLength(header({ id: "1-1", pid: 2 ** 22 + 1 }))
  const [shown] = await readStreamOriginal(streams, { file: finishedKey, ranges: [[firstLine, firstLine + Buffer.byteLength(frame("turn/started"))]] })
  assert.equal(shown.kind, "range", JSON.stringify(shown))
  assert.match(shown.text, /turn\/started/)
  const [byLaunch] = await readStreamOriginal(streams, { file: `${STREAMS_ROOT}:codex/2026-10-14T03-00-00-000Z-c.jsonl`, ranges: [[0, firstLine]] })
  assert.equal(byLaunch.kind, "range", "a line written before the launch knew its session reads from the store too")
  // On macOS a writer is alive while the kernel holds its lock file; elsewhere its pid (and start, on Linux) answers, and there's no file.
  if (process.platform === "darwin") assert.ok((await readdir(join(recordsPath, "stream-writers"))).includes(`${ours.id}.lock`), "the running writer keeps its lock file")
  else assert.equal(streamWriterGone(streams, ours), false, "the running writer is alive by its pid")
  await catalog.stop()

  // A restart: every session is held at its stamp, so the pass reads nothing.
  const again = new SessionCatalog([new CodexProvider(nativeStores, home)], { recordsPath, recordsHome: home, backfill: true, log })
  await again.scan()
  const capturesBefore = look.captures({ limit: 1000 }).length
  const restarted = Date.now()
  again.startWatching()
  await until(() => again.backfillProgress?.endedAt, "the pass after a restart")
  const second = again.backfillProgress
  // Pruning moved the newest's held stamp with its streams, so nothing is checked again.
  assert.equal(second.held, 5, "each held at its stamp, the pruned session too")
  assert.equal(second.captured, 0)
  assert.equal(look.captures({ limit: 1000 }).length, capturesBefore, "no capture took a version")
  measured.push(`a pass over 5 held sessions: ${second.ms} ms (${Date.now() - restarted} ms from watching to done)`)

  // The harness deletes a session: it leaves the rail, and its records stay.
  const harnessDeleted = threads[0]
  const heldBefore = look.units("codex", harnessDeleted.id).length
  await rm(harnessDeleted.path)
  await again.scan({ emitChanges: true })
  await again.stop()
  assert.equal(look.units("codex", harnessDeleted.id).length, heldBefore, "a session its harness deleted keeps its records")
  assert.ok(look.units("codex", harnessDeleted.id).every((unit) => unit.kind !== "delete"), "with nothing recorded as deleted")

  // The person deletes one in Mako: its records and streams go, and no pass brings them back.
  const third = new SessionCatalog([new CodexProvider(nativeStores, home)], { recordsPath, recordsHome: home, backfill: true, log })
  const refs = await third.scan()
  const target = refs.find((ref) => ref.nativeId === newest.id)
  assert.equal(await third.remove(target.path), true)
  assert.deepEqual(look.units("codex", newest.id), [], "the person's deletion drops the session's units")
  assert.equal(look.heldStamp("codex", newest.id), null)
  assert.deepEqual((await readdir(join(streams, "codex"))).filter((name) => name.startsWith(encodeURIComponent(newest.id))), [], "and its streams' files")
  third.startWatching()
  await until(() => third.backfillProgress?.endedAt, "the pass after a deletion")
  assert.deepEqual(look.units("codex", newest.id), [], "a pass doesn't bring it back")
  assert.equal(third.backfillProgress.sessions, 3)
  await third.stop()
  await look.close()

  // A read-only catalog never backfills.
  const readOnlyRecords = join(home, "read-only-records")
  const readOnly = new SessionCatalog([new CodexProvider(new NativeStores(true), home)], { recordsPath: readOnlyRecords, recordsHome: home, readOnly: true, backfill: true })
  await readOnly.scan()
  readOnly.startWatching()
  await readOnly.stop()
  assert.equal(readOnly.backfillProgress, null)
  await assert.rejects(readFile(join(readOnlyRecords, "records.sqlite")), { code: "ENOENT" })
} finally {
  await rm(home, { recursive: true, force: true })
}

/** A backfill over `threads` straight on a store, as the catalog makes one. */
function rig(folder, threads, options = {}) {
  const store = new RecordStore(join(folder, "records"), nativeStores)
  const provider = new CodexProvider(nativeStores, folder)
  const refs = threads.map((thread, index) => ({ harness: "codex", nativeId: thread.id, path: thread.path, updatedAt: String(index) })).reverse()
  const stamps = new Map()
  const capture = new RecordCapture(store, options.recordsOf ?? ((ref) => provider.records(ref.path)), {
    home: folder,
    streams: streamsRoot(store.folder),
    stampOf: (ref) => stamps.get(ref.path) ?? null,
    holdKeepsFree: options.holdKeepsFree,
    onCaptured: options.onCaptured,
  })
  const backfill = new RecordBackfill(capture, store, { sessions: () => refs, listed: () => true, streams: streamsRoot(store.folder), log: () => {} })
  return {
    store, capture, backfill, refs,
    async stamp() {
      for (const ref of refs) {
        const info = await stat(ref.path)
        stamps.set(ref.path, `n:${info.size}:${info.mtimeMs}:`)
      }
    },
    async close() {
      await backfill.stop()
      await capture.stop()
    },
  }
}

// Stopped mid-pass, the next pass continues where it left off without taking anything again.
{
  const folder = await mkdtemp(join(tmpdir(), "mako-record-backfill-resume-"))
  try {
    const threads = await codexHome(folder, 6)
    let taken = 0
    let first
    first = rig(folder, threads, { onCaptured: () => { if (++taken === 2) void first.backfill.stop() } })
    await first.stamp()
    await first.backfill.wake("start")
    const cut = first.backfill.progress
    assert.equal(cut.captured, 2, "stopped after two")
    assert.equal(cut.endedAt, undefined, "a pass cut short has no end")
    await first.close()
    const second = rig(folder, threads)
    await second.stamp()
    await second.backfill.wake("start")
    assert.equal(second.backfill.progress.held, 2, "the two it took are held")
    assert.equal(second.backfill.progress.captured, 4, "and the rest are taken")
    assert.equal(second.store.captures({ limit: 100 }).length, 6, "each session captured once in all")
    // A write after the pass moves the stamp: the next pass takes only that session, by an append.
    const grown = threads[2]
    await appendFile(grown.path, message("user", "One more thing"))
    await second.stamp()
    await second.backfill.wake("start")
    assert.equal(second.backfill.progress.captured, 1)
    assert.equal(second.backfill.progress.held, 5)
    const [unit] = second.store.units("codex", grown.id).filter((candidate) => candidate.key.endsWith(".jsonl"))
    assert.deepEqual(second.store.versions("codex", unit.key).map((version) => version.kind), ["replace", "append"], "the grown session is appended to")
    await second.close()
  } finally {
    await rm(folder, { recursive: true, force: true })
  }
}

// A disk without room for a session at its full size refuses it, logs it, and stores nothing.
{
  const folder = await mkdtemp(join(tmpdir(), "mako-record-backfill-disk-"))
  try {
    const threads = await codexHome(folder, 2)
    const full = rig(folder, threads, { holdKeepsFree: Number.MAX_SAFE_INTEGER })
    await full.stamp()
    await full.backfill.wake("start")
    assert.equal(full.backfill.progress.refused, 2)
    assert.match(full.backfill.progress.firstRefusal ?? "", /Not held: the disk has [\d.]+ GiB free/)
    assert.deepEqual(full.store.sessions(), [], "nothing stored")
    await full.close()
  } finally {
    await rm(folder, { recursive: true, force: true })
  }
}

// The backfill waits for a live capture before it takes a session, and doesn't set a session's pace.
{
  const folder = await mkdtemp(join(tmpdir(), "mako-record-backfill-yield-"))
  try {
    const threads = await codexHome(folder, 3)
    const provider = new CodexProvider(nativeStores, folder)
    let release
    const held = new Promise((resolve) => { release = resolve })
    const order = []
    const yielding = rig(folder, threads, {
      recordsOf: async (ref) => {
        if (ref.nativeId === "live") {
          order.push("live")
          await held
          return { roots: [], files: [], databases: [] }
        }
        order.push(ref.nativeId)
        return provider.records(ref.path)
      },
    })
    await yielding.stamp()
    yielding.capture.wrote({ harness: "codex", nativeId: "live", path: join(folder, "live.jsonl") })
    await until(() => order.includes("live"), "the live capture to start")
    const pass = yielding.backfill.wake("start")
    await delay(100)
    assert.deepEqual(order, ["live"], "no backfill capture while the live one runs")
    release()
    await pass
    assert.equal(yielding.backfill.progress.captured, 3)
    assert.ok(yielding.backfill.progress.yieldedMs >= 50, `the pass counts the time it yielded (${yielding.backfill.progress.yieldedMs} ms)`)
    await yielding.close()
  } finally {
    await rm(folder, { recursive: true, force: true })
  }
}

// A stream the store holds at its size but whose bytes differ is kept, and reported.
{
  const folder = await mkdtemp(join(tmpdir(), "mako-record-backfill-differs-"))
  try {
    const threads = await codexHome(folder, 1)
    const differs = rig(folder, threads)
    const streams = streamsRoot(differs.store.folder)
    await mkdir(join(streams, "codex"), { recursive: true })
    const file = streamPath(streams, "codex", "2026-10-14T04-00-00-000Z-c.jsonl", threads[0].id)
    const body = `${JSON.stringify({ capture: 1, harness: "codex", writer: { id: "2-2", pid: 2 ** 22 + 2 } })}\n{"at":"x","message":"aaaa"}\n`
    await writeFile(file, body)
    await differs.stamp()
    await differs.backfill.wake("start")
    assert.equal(differs.backfill.progress.prune?.pruned, 1, "held whole: pruned")
    // Again, with the file rewritten in place at its size after the store took it.
    await writeFile(file, body)
    await differs.stamp()
    await differs.store.capture({ harness: "codex", nativeId: threads[0].id, home: folder, records: { roots: [{ name: STREAMS_ROOT, path: streams }], files: [file], databases: [] } })
    const info = await stat(file)
    await writeFile(file, body.replace("aaaa", "bbbb"))
    await utimes(file, info.atime, info.mtime)
    const report = await pruneStreams(differs.store, streams)
    assert.equal(report.pruned, 0)
    assert.deepEqual(report.differs, [file], "a stream the store doesn't hold byte for byte stays")
    await differs.close()
  } finally {
    await rm(folder, { recursive: true, force: true })
  }
}

for (const line of measured) console.log(`  ${line}`)
console.log("record-backfill: ok")
