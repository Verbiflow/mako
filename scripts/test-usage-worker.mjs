import "./lib/scratch-git.mjs"
import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as pause } from "node:timers/promises"
import { UsageReader } from "../dist-electron/usage-reader.js"
import { UsageLedger } from "../dist-electron/usage-ledger.js"
import { usageSummary } from "../dist-electron/usage.js"
import { providerHost } from "../dist-electron/providers/index.js"
import { usageHarnesses } from "../dist-electron/usage.js"
import { closeRepositories, openRepository, text } from "@mako/git"

const root = await mkdtemp(join(tmpdir(), "mako-usage-worker-"))
const now = Date.now()
const data = {
  ledgerPath: join(root, "ledger.sqlite"), sessionsRoot: join(root, "sessions"),
  homeRoot: join(root, "home"), conversationsRoot: join(root, "conversations"), env: {}, now,
}
const reader = new UsageReader(data)

/** Measures responsiveness through the final synchronous work, not just the I/O before it. */
async function measure(work) {
  let last = performance.now(), gap = 0, ticks = 0
  const timer = setInterval(() => {
    const at = performance.now()
    gap = Math.max(gap, at - last)
    last = at
    ticks++
  }, 5)
  try {
    await pause(10)
    const start = performance.now()
    const value = await work()
    const ms = performance.now() - start
    await pause(10)
    return { value, ms: Math.round(ms), gap: Math.round(gap), ticks }
  } finally { clearInterval(timer) }
}

try {
  // A substantial cached month, including per-call pricing and every grouping.
  const ledger = new UsageLedger(data.ledgerPath)
  const events = Array.from({ length: 100_000 }, (_, index) => ({
    key: `fixture:${index}`, source: "Fixture", session: `session-${index % 100}`,
    timestamp: new Date(now - index).toISOString(), model: "gpt-6.1-sol", cwd: `/fixture/${index % 12}`,
    input: 100, output: 20, cacheRead: 30, cacheWrite: 0,
  }))
  ledger.advanceStore("Fixture", "fixture", 1, events)
  const direct = await measure(() => usageSummary(usageHarnesses(providerHost), data.sessionsRoot, data.homeRoot, data.conversationsRoot, { ledger, now, env: {} }))
  ledger.close()
  let first
  const background = await measure(() => {
    first = reader.read()
    assert.equal(reader.read(), first, "simultaneous views share the same scan")
    return first
  })
  assert.deepEqual(background.value, direct.value, "the worker returns identical totals, rankings and dates")
  assert.ok(background.ticks > 20, "the host keeps handling timers throughout a large summary")
  assert.ok(background.gap < Math.max(150, direct.gap / 2), `worker blocked host ${background.gap}ms; direct scan ${direct.gap}ms`)

  const gitRoot = join(root, "repo")
  await mkdir(gitRoot)
  await text({ cwd: gitRoot, args: ["init", "-q"] })
  await writeFile(join(gitRoot, "change.txt"), "changed\n")
  const repo = await openRepository(gitRoot)
  assert.ok(repo)
  const scan = reader.read()
  let finished = false
  void scan.then(() => { finished = true })
  const start = performance.now()
  assert.equal((await repo.status()).entries.length, 1)
  const gitMs = Math.round(performance.now() - start)
  assert.equal(finished, false, "Git replies while the usage worker is still aggregating")
  assert.deepEqual(await scan, direct.value)
  await reader.close()
  await assert.rejects(reader.read(), /closed/)

  // Constructor failure rejects the waiting call; a subsequent explicit read starts a fresh worker.
  const missing = join(root, "missing")
  const recovery = new UsageReader({ ...data, ledgerPath: join(missing, "ledger.sqlite") })
  try {
    await assert.rejects(recovery.read(), /unable to open database/)
    await mkdir(missing)
    assert.equal((await recovery.read()).total.messages, 0)
  } finally { await recovery.close() }

  const closing = new UsageReader(data)
  const interrupted = closing.read()
  const rejected = assert.rejects(interrupted, /closed/)
  await closing.close()
  await rejected
  console.log(JSON.stringify({ events: events.length, direct: { ms: direct.ms, hostGapMs: direct.gap }, worker: { ms: background.ms, hostGapMs: background.gap }, concurrentGitMs: gitMs }))
  console.log("PASS: usage worker preserves summaries and responsiveness, coalesces reads, recovers from failure and rejects cleanly on shutdown")
} finally {
  await reader.close()
  closeRepositories()
  await rm(root, { recursive: true, force: true })
}
