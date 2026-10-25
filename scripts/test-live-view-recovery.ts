// A window keeps reading a conversation's history through views the host lets go, while the conversation streams:
// one refused read renews the view and is read again, never a "history view expired" for the person; and a host that
// keeps answering behind the window is asked again less and less often, never in a loop.
import assert from "node:assert/strict"
import { mock } from "node:test"
import { setTimeout as sleep } from "node:timers/promises"
import { toast } from "sonner"
import { LiveHistoryReader } from "@mako/host/conversations/live-history-reader"
import type { LiveSnapshot } from "@mako/host/contracts/live-conversations"
import type { LiveHistoryRead } from "@mako/host/contracts/live-history"
import { auditId, auditSnapshot } from "./performance-audit-fixtures"

Object.defineProperty(globalThis, "window", { value: {}, configurable: true })
Object.assign(globalThis, { requestAnimationFrame: (run: () => void) => setTimeout(run, 16), cancelAnimationFrame: clearTimeout })
const { installMockBridge } = await import("../src/dev/mock-bridge")
const { getMako } = await import("../src/lib/bridge")
const { acpStore } = await import("../src/state/acp-state")
const { applyLiveSnapshot, applyLiveBatch, hydrateLive, loadEarlierLive } = await import("../src/state/live-recovery")
const { loadLiveHistoryDetail } = await import("../src/state/live-history")
installMockBridge()
mock.method(toast, "error", () => "fixture")
mock.method(console, "warn", () => {})

function conversation(n: number, turns: number): LiveSnapshot {
  const snapshot = auditSnapshot(turns, "claude", 2048, 4096)
  snapshot.session = { ...snapshot.session, id: auditId(9000 + n), status: "ready" }
  snapshot.epoch = "recovery"
  snapshot.requests.forEach((request) => { request.status = "completed" })
  return snapshot
}
const window = (id: string) => {
  const held = acpStore.get().conversations[id]
  assert.ok(held?.kind === "live" && held.history)
  return held
}

{
  // The conversation being read streams while the host lets its view go (here, a host that started again and holds
  // none); the reader scrolls up, then opens a full output.
  let reader = new LiveHistoryReader()
  const source = new Map<string, LiveSnapshot>()
  const refused: string[] = []
  mock.method(getMako(), "liveRead", async (id: string, input: LiveHistoryRead) => {
    try {
      const chunk = await reader.read(id, input, async () => source.get(id) ?? null)
      await sleep(5)
      return chunk
    } catch (error) {
      refused.push(input.kind)
      throw error
    }
  })
  const read = conversation(1, 400)
  const id = read.session.id
  source.set(id, read)
  await hydrateLive(id)
  const first = window(id).history!.token
  reader = new LiveHistoryReader()
  let streaming = true
  const stream = (async () => {
    while (streaming) {
      const next = { ...source.get(id)!, revision: source.get(id)!.revision + 1 }
      source.set(id, next)
      applyLiveBatch({ id, revision: next.revision, epoch: "recovery", updates: [] })
      await sleep(2)
    }
  })()
  await loadEarlierLive(id)
  streaming = false
  await stream
  assert.deepEqual(refused, ["earlier"], "one refused read, then the renewed view answers")
  assert.notEqual(window(id).history!.token, first, "the window took a view the host holds")
  assert.ok(window(id).history!.blockStart < source.get(id)!.blocks.length - 80, "the earlier page is on screen")

  const tool = window(id).blocks.find((block) => block.type === "tool" && block.historyRest)
  assert.ok(tool?.type === "tool" && tool.historyRest)
  const shown = window(id).history!.token
  reader = new LiveHistoryReader()
  refused.length = 0
  await loadLiveHistoryDetail(id, shown, { kind: "live", index: tool.historyRest.index })
  assert.deepEqual(refused, ["detail"], "a full output read against a view let go is read again from a renewed one")
  console.log("PASS: a streaming conversation's history reads renew a view the host let go, once, without a refusal reaching the reader")
}

{
  // A host answering behind what the window holds, with a batch past it waiting: asked again less and less often.
  const behind = conversation(2, 20)
  let reads = 0
  mock.method(getMako(), "liveRead", async () => {
    reads++
    await sleep(20)
    const data = JSON.stringify({ ...behind, revision: 3, history: { token: "behind", ranges: true, blockStart: 0, blockEnd: behind.blocks.length, turnStart: 0, earlierRequests: [], before: null } })
    return { record: crypto.randomUUID(), offset: 0, total: data.length, data, next: null }
  })
  applyLiveSnapshot({ ...behind, revision: 5, history: { token: "held", ranges: true, blockStart: 0, blockEnd: behind.blocks.length, turnStart: 0, earlierRequests: [], before: null } })
  applyLiveBatch({ id: behind.session.id, revision: 7, epoch: "recovery", updates: [] })
  await sleep(3000)
  assert.ok(reads <= 5, `a host answering behind is asked again with backoff, not in a loop (${reads} reads in 3 s)`)
  console.log(`PASS: a host answering behind is read ${reads} times in 3 s, backing off`)
}
{
  // A batch the host that quit sent last, buffered as its reread failed, from another epoch than the host that started:
  // dropped once that host's snapshot lands, not replayed against it forever (one reread every 280 ms for hours).
  const quitting = conversation(3, 5)
  const id = quitting.session.id
  let epoch = "host-1", up = true, reads = 0
  mock.method(getMako(), "liveRead", async (asked: string) => {
    if (asked === id) reads++
    await sleep(50)
    if (!up) throw new Error("The connection to Mako's shared host was interrupted.")
    const data = JSON.stringify({ ...quitting, epoch, history: { token: `t-${epoch}`, ranges: true, blockStart: 0, blockEnd: quitting.blocks.length, turnStart: 0, earlierRequests: [], before: null } })
    return { record: crypto.randomUUID(), offset: 0, total: data.length, data, next: null }
  })
  await hydrateLive(id)
  up = false
  applyLiveBatch({ id, revision: 9, epoch: "host-1", historyChanged: true, updates: [] })
  await sleep(150)
  epoch = "host-2"
  up = true
  reads = 0
  assert.ok(await hydrateLive(id))
  await sleep(2000)
  assert.equal(window(id).epoch, "host-2")
  assert.equal(reads, 1, `the gone host's batch asks nothing more of the new one (${reads} reads)`)
  console.log("PASS: a batch from a host that quit is dropped once the host that started answers")
}

{
  // A stream whose every batch needs a snapshot keeps up: new batches read at once, never behind a backoff.
  const busy = conversation(4, 5)
  const id = busy.session.id
  let revision = busy.revision, reads = 0
  mock.method(getMako(), "liveRead", async (asked: string) => {
    if (asked === id) reads++
    await sleep(20)
    const data = JSON.stringify({ ...busy, revision, epoch: "busy", history: { token: `t-${revision}`, ranges: true, blockStart: 0, blockEnd: busy.blocks.length, turnStart: 0, earlierRequests: [], before: null } })
    return { record: crypto.randomUUID(), offset: 0, total: data.length, data, next: null }
  })
  await hydrateLive(id)
  for (let n = 0; n < 40; n++) {
    revision++
    applyLiveBatch({ id, revision, epoch: "busy", historyChanged: true, updates: [] })
    await sleep(15)
  }
  await sleep(150)
  assert.equal(window(id).revision, revision, `the window caught up with the stream (${window(id).revision} of ${revision}, ${reads} reads)`)
  console.log(`PASS: a stream needing snapshots keeps up (${reads} reads for 40 batches)`)
}
process.exit(0)
