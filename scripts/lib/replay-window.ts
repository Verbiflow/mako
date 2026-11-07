import { createHash } from "node:crypto"
import { createReadStream, readFileSync } from "node:fs"
import { join } from "node:path"
import { mock } from "node:test"
import { createInterface } from "node:readline"
import { setImmediate as turn } from "node:timers/promises"
import type { HostEvent } from "@mako/host/contracts/host-events-boot"
import { isCompactBatch, rosteredLiveBatch, type HeardLiveBatch, type LiveRoster, type LiveSnapshot } from "@mako/host/contracts/live-conversations"
import { decodeRuntimeEvent } from "@mako/host/contracts/runtime-value"
import { LiveHistoryReader } from "@mako/host/conversations/live-history-reader"
import type { LiveHistoryRead } from "@mako/host/contracts/live-history"
import { z } from "zod"
import { ReplayOpenSchema, ReplayPacketSchema, ReplayPlanSchema } from "./replay-plan.ts"

/**
 * One window's renderer, fed a recorded stream: `tsx scripts/lib/replay-window.ts <capture> <whole|rostered> <plan>`.
 *
 * A capture is what a host sent, as `stream.jsonl`, each packet as the stream carried it; `boot.json`, the list a window
 * starts from; and `opens.json`, each conversation a window opened, with the stream's position when it asked and when
 * the answer came, and its snapshot. `plan`, as JSON, is what happens to this window:
 * - `opens`: which of those it opens, by their place in the list; going on to the next unloads the last, as a window does;
 * - `attach`: the event it attaches at, having heard nothing before it;
 * - `gap`: the events it misses of `conversation`;
 * - `drift`: the event from which it holds another roster of `conversation` than the host wrote against;
 * - `restart`: the event from which it holds `conversation` as of a host that has since restarted;
 * - `lag`: how many events a read of the whole roster takes, three unless it says. It answers as of halfway through, so
 *   changes land on both sides of the answer, as with a host that goes on sending while the answer's on its way.
 * In `rostered` it hears a batch as a host's own window does, its roster as what changed. The state of every store a
 * surface draws from goes out as a digest every `every` events, and in full at the end; `reading` marks a digest taken
 * while a roster's read was on its way.
 */
const [capture, mode, planned = "{}", every = "200"] = process.argv.slice(2)
const EVERY = Number(every)
if (!capture || (mode !== "whole" && mode !== "rostered")) throw new Error("Use: replay-window <capture> <whole|rostered> <plan>")
const plan = ReplayPlanSchema.parse(JSON.parse(planned))

Object.defineProperty(globalThis, "window", { value: {}, configurable: true })
Object.assign(globalThis, { requestAnimationFrame: (run: () => void) => setTimeout(run, 16), cancelAnimationFrame: clearTimeout })
const { installMockBridge } = await import("../../src/dev/mock-bridge")
const { getMako } = await import("../../src/lib/bridge")
const { acpStore } = await import("../../src/state/acp-state")
const { acp } = await import("../../src/state/acp")
const { selectAcpPresence } = await import("../../src/state/acp-presence")
const { threadChildren } = await import("../../src/state/apex-fins")
const { inboxModel } = await import("../../src/state/inbox")
const { notificationsStore } = await import("../../src/state/notifications")
const { threadsStore } = await import("../../src/state/thread-store")
const { actions } = await import("../../src/state/session")
const { unloadLive } = await import("../../src/state/live-recovery")
const { AudioFeedback } = await import("../../src/lib/audio-feedback")
installMockBridge()
const bridge = getMako()
// A read the recording can't answer must show, or a window with nothing in it passes for one that matches.
mock.method(console, "warn", (...said: unknown[]) => void process.stderr.write(`${said.join(" ")}\n`))
mock.method(console, "error", (...said: unknown[]) => void process.stderr.write(`${said.join(" ")}\n`))

let clock = 1_800_000_000_000
mock.method(Date, "now", () => clock)
const sounds: string[] = []
mock.method(AudioFeedback.prototype, "play", async (cue: string) => void sounds.push(cue))

/** `found`: not an open: what a window reads on first hearing of a conversation, which any window then has to hand. */
const recordedOpens = z.array(ReplayOpenSchema).parse(JSON.parse(readFileSync(join(capture, "opens.json"), "utf8")))
const allOpens = recordedOpens.filter((open) => !open.found)
const found = recordedOpens.filter((open) => open.found)
const opens = (plan.opens ?? []).map((at) => allOpens[at]).filter((open) => open !== undefined)
const boot = z.object({ at: z.number(), live: z.array(z.any()) }).parse(JSON.parse(readFileSync(join(capture, "boot.json"), "utf8")))

const reader = new LiveHistoryReader()
const reading = new Map<string, { snapshot: LiveSnapshot; ready: Promise<void>; go: () => void }>()
let listener: ((event: HostEvent) => void) | undefined
mock.method(bridge, "onEvent", (heard: (event: HostEvent) => void) => {
  listener = heard
  return () => {}
})
const mockBoot = bridge.boot.bind(bridge)
mock.method(bridge, "boot", async () => ({ ...(await mockBoot()), live: boot.live }))
// A read answers when it answered then, over the stream the window had heard by that time.
mock.method(bridge, "liveRead", async (id: string, input: LiveHistoryRead) => {
  const held = reading.get(id)
  if (!held) throw new Error("This conversation isn't in the recording")
  await held.ready
  return reader.read(id, input, async () => held.snapshot)
})

/** What the host has told its windows so far, as it answers `mako:live-roster`. */
const told = new Map<string, LiveRoster>()
const rosterAnswers: { id: string; asOf: number; told?: LiveRoster; at: number; go: (told: LiveRoster | null) => void }[] = []
const lag = plan.lag ?? 3
let rosterReads = 0
let seq = 0
mock.method(bridge, "liveRoster", (id: string) => {
  rosterReads += 1
  return new Promise<LiveRoster | null>((go) => rosterAnswers.push({ id, asOf: seq + Math.floor(lag / 2), at: seq + lag, go }))
})
const settleRosters = async (all = false) => {
  for (const answer of rosterAnswers.filter((each) => all || each.at <= seq)) {
    rosterAnswers.splice(rosterAnswers.indexOf(answer), 1)
    answer.go(answer.told ?? told.get(answer.id) ?? null)
    for (let wait = 0; wait < 3; wait += 1) await turn()
  }
}

/** What a window opened: compared from when its read answered, as any window waits for that. */
const opening = new Set<string>()
const conversationIdsOf = () => Object.keys(acpStore.get().conversations).sort()
function surfaces() {
  const state = acpStore.get()
  const threads = [...new Set(Object.values(state.conversations).map((conversation) => conversation.threadId).filter((thread) => thread !== undefined))].sort()
  return {
    presence: selectAcpPresence(state),
    children: threads.map((thread) => [thread, threadChildren(state, thread)]),
    inbox: inboxModel(),
    // One a whole roster's read raises says when the read landed.
    notifications: notificationsStore.get().items.map(({ at: _at, ...item }) => item),
    threads: threadsStore.get(),
    sounds,
    activeKey: state.activeKey,
    conversations: conversationIdsOf().map((id) => {
      if (opening.has(id)) return [id, "opening"]
      const { projection: _projection, ...held } = state.conversations[id]!
      // A history's token and version are minted for each read, in any window.
      return [id, JSON.parse(JSON.stringify(held, (key, value) => (key === "token" || key === "historyVersion" ? "" : value)))]
    }),
  }
}
const digest = (at: number) => {
  const all = surfaces()
  process.stdout.write(`${JSON.stringify({ at, reading: rosterAnswers.length > 0, ...Object.fromEntries(Object.entries(all).map(([name, value]) => [name, createHash("sha1").update(JSON.stringify(value) ?? "").digest("hex").slice(0, 12)])) })}\n`)
}

await actions.boot()
await turn()
// A window shows what it opens here, not whatever a boot restored.
acpStore.set({ activeKey: null })

const attach = plan.attach ?? 0
let asked = false, showing: string | undefined, drifted = false, restarted = false
let rostered = 0, whole = 0, wholeBytes = 0, rosteredBytes = 0, fullRosters = 0
for await (const text of createInterface({ input: createReadStream(join(capture, "stream.jsonl")) })) {
  seq += 1
  clock += 25
  for (const open of seq < attach ? [] : [...found, ...opens]) {
    if (open.asked === seq) {
      let go = () => {}
      const ready = new Promise<void>((resolve) => { go = resolve })
      reading.set(open.id, { snapshot: JSON.parse(readFileSync(join(capture, open.file), "utf8")), ready, go })
      if (!open.found) {
        if (showing && showing !== open.id) {
          acpStore.set({ activeKey: null })
          unloadLive(showing)
        }
        showing = open.id
        opening.add(open.id)
        acp.activate(open.id)
        await turn()
      }
    }
    if (open.answered === seq) {
      reading.get(open.id)?.go()
      for (let wait = 0; wait < 5; wait += 1) await turn()
      opening.delete(open.id)
    }
  }
  if (plan.drift && !drifted && seq >= plan.drift.at) {
    const held = acpStore.get().conversations[plan.drift.conversation]
    if (held?.kind === "live" && (held.nativeAgents?.agents.length ?? 0) > 1) {
      drifted = true
      acpStore.set({ conversations: { ...acpStore.get().conversations, [held.key]: { ...held, nativeAgents: { ...held.nativeAgents!, agents: held.nativeAgents!.agents.slice(1) } } } })
    }
  }
  if (plan.restart && !restarted && seq >= plan.restart.at) {
    const held = acpStore.get().conversations[plan.restart.conversation]
    if (held?.kind === "live") {
      restarted = true
      acpStore.set({ conversations: { ...acpStore.get().conversations, [held.key]: { ...held, epoch: "before-its-restart" } } })
    }
  }
  const packet = ReplayPacketSchema.parse(JSON.parse(text))
  if (packet.channel !== "event" || !packet.payload) continue
  let event = decodeRuntimeEvent<HostEvent>(packet.payload)
  if (event.type === "live-batch") {
    const batch: HeardLiveBatch = event.batch
    const before = told.get(batch.id)
    // A recorded stream says how its host wrote it; a capture of an older host, how this one would.
    const rewritten = !packet.rostered && isCompactBatch(batch) && before?.roster ? rosteredLiveBatch(batch, before.roster) : undefined
    const roster = packet.rostered ?? (rewritten && JSON.stringify({ type: "live-batch", batch: rewritten }))
    told.set(batch.id, { roster: batch.nativeAgents ?? before?.roster, revision: batch.revision, ...(batch.epoch && { epoch: batch.epoch }) })
    for (const answer of rosterAnswers) if (answer.asOf <= seq) answer.told ??= told.get(answer.id)
    wholeBytes += packet.payload.length
    if (batch.nativeAgents) fullRosters += 1
    if (mode === "rostered" && roster) {
      event = decodeRuntimeEvent<HostEvent>(roster)
      rostered += 1
      rosteredBytes += roster.length
    } else {
      whole += 1
      rosteredBytes += packet.payload.length
    }
    if (plan.gap?.conversation === batch.id && seq >= plan.gap.from && seq < plan.gap.to) continue
  }
  if (seq < attach) continue
  listener?.(event)
  await settleRosters()
  if (seq % EVERY === 0) {
    await turn()
    asked ||= Object.values(acpStore.get().conversations).some((held) => held.kind === "live" && held.permission)
    digest(seq)
  }
}
await settleRosters(true)
for (let wait = 0; wait < 10; wait += 1) await turn()
digest(seq)
// A pipe takes what it can at once; leaving now would cut this line off.
await new Promise((written) => process.stdout.write(`${JSON.stringify({ end: true, seq, asked, rosterReads, rostered, whole, fullRosters, wholeBytes, rosteredBytes, conversations: conversationIdsOf().length, full: surfaces() })}\n`, written))
process.exit(0)
