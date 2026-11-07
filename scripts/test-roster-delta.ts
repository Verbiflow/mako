import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { COMPACT_LIVE_FORM, ROSTER_LIVE_FORM, WHOLE_LIVE_FORM, saidLiveForm, saidWindowForm } from "@mako/protocol/live-form"
import { z } from "zod"
import type { HostEvent } from "@mako/host/contracts/host-events-boot"
import { applyRosterPatch, compactLiveBatch, expandLiveBatch, rosteredLiveBatch, type CompactLiveBatch, type LiveBatch } from "@mako/host/contracts/live-conversations"
import { NativeAgentSchema, type NativeAgent, type NativeAgentRoster } from "@mako/host/contracts/native-agents"
import { decodeRuntimeEvent, encodeRuntimeEvent, payloadFor } from "@mako/host/contracts/runtime-value"
import { AgentsWorld } from "./lib/agents-world.ts"
import { ReplayOpenSchema, ReplayPacketSchema, type ReplayPlan } from "./lib/replay-plan.ts"

/**
 * Whether a window hearing rosters as what changed draws what a window hearing them whole draws (`rosteredLiveBatch`).
 * The same stream goes through the real renderer twice, in a process each, as a window: whole, as every reader but a
 * host's own windows hears it, and rostered. Every store every surface draws from is compared, all along the stream,
 * in windows that open conversations and leave them, attach mid-stream, miss batches, and hold another roster than the
 * host wrote against. `npm run test:roster-delta` makes its stream from a real host with real Fins; `-- --capture
 * <folder>` replays one recorded from a real host, which stays private and isn't in this repository.
 */
const run = promisify(execFile)
const capture = process.argv.includes("--capture") ? process.argv[process.argv.indexOf("--capture") + 1] : undefined

/** Every event for a stream short enough; a recording of thousands, often enough to catch a roster that mends itself. */
const every = capture ? "20" : "1"

const EndSchema = z.object({
  end: z.literal(true),
  asked: z.boolean(), rosterReads: z.number(), rostered: z.number(), whole: z.number(), fullRosters: z.number(), wholeBytes: z.number(), rosteredBytes: z.number(), conversations: z.number(), seq: z.number(),
  full: z.object({ conversations: z.array(z.tuple([z.string(), z.any()])), notifications: z.array(z.any()), children: z.array(z.tuple([z.string(), z.array(z.any())])) }).catchall(z.any()),
})
type End = z.infer<typeof EndSchema>
const DigestSchema = z.object({ at: z.number(), reading: z.boolean() }).catchall(z.string())

async function windowOf(folder: string, mode: "whole" | "rostered", plan: string) {
  const { stdout } = await run(process.execPath, ["--import", "tsx", join(import.meta.dirname, "lib/replay-window.ts"), folder, mode, plan, every], { maxBuffer: 2 ** 30, env: { ...process.env, TSX_TSCONFIG_PATH: join(import.meta.dirname, "../tsconfig.scripts.json") } })
  const lines = stdout.trim().split("\n")
  return { digests: lines.slice(0, -1).map((line) => DigestSchema.parse(JSON.parse(line))), end: EndSchema.parse(JSON.parse(lines.at(-1)!)) }
}

async function sameDrawn(folder: string, plan: ReplayPlan, label: string): Promise<End> {
  const planned = JSON.stringify(plan)
  const [whole, rostered] = await Promise.all([windowOf(folder, "whole", planned), windowOf(folder, "rostered", planned)])
  assert.ok(rostered.end.rostered > 0, `${label}: some rosters went as what changed`)
  assert.equal(rostered.digests.length, whole.digests.length, `${label}: both reached the same points`)
  for (const [at, digest] of rostered.digests.entries()) {
    // A roster being read is behind for as long as the read takes, and no longer.
    if (digest.reading) continue
    const other = whole.digests[at]!
    const differs = Object.keys(digest).filter((surface) => surface !== "reading" && digest[surface] !== other[surface])
    if (!differs.length) continue
    const surface = differs[0]!
    const a = JSON.stringify(whole.end.full[surface]) ?? "", b = JSON.stringify(rostered.end.full[surface]) ?? ""
    let first = 0
    while (first < a.length && a[first] === b[first]) first += 1
    assert.fail(`${label}: at event ${String(digest.at)} ${differs.join(", ")} differ; at the end of the stream ${surface} ${a === b ? "came back the same" : `differs near: whole ${a.slice(Math.max(0, first - 40), first + 160)} rostered ${b.slice(Math.max(0, first - 40), first + 160)}`}`)
  }
  assert.deepEqual(rostered.end.full, whole.end.full, `${label}: every store ends the same`)
  return rostered.end
}

/** What a roster's change says, what form each reader hears it in, and what it won't risk. */
function contract(): void {
  const agent = (nativeId: string, observedAt = 1, state = "working"): NativeAgent => NativeAgentSchema.parse({ bindingId: "b", provider: "claude", nativeId, work: "agent", title: `the ${nativeId} agent, with a title long enough to be worth leaving out`, observedAt, state: { kind: state } })
  const roster = (...agents: NativeAgent[]): NativeAgentRoster => ({ agents, limited: false })
  const whole = (nativeAgents: NativeAgentRoster): LiveBatch => ({ id: "c", revision: 2, updates: [], nativeAgents })
  const batch = (nativeAgents: NativeAgentRoster): CompactLiveBatch => compactLiveBatch(whole(nativeAgents), { blocks: [], requests: [] })
  const patchOf = (held: NativeAgentRoster, next: NativeAgentRoster) => rosteredLiveBatch(batch(next), held)?.rosterPatch
  const held = roster(agent("a"), agent("b"), agent("c"), agent("d"))
  const read = (next: NativeAgentRoster) => { const patch = patchOf(held, next); assert.ok(patch, "goes as what changed"); return applyRosterPatch(held, patch) }

  const moved = roster(agent("a"), agent("b", 2), agent("c"), agent("d"))
  assert.deepEqual(read(moved), moved, "an entry that moved")
  assert.deepEqual(patchOf(held, moved)!.agents, [agent("b", 2)], "and only it")
  const added = roster(...held.agents, agent("e"))
  assert.deepEqual(read(added), added, "an entry that's new lands last")
  const gone = roster(agent("a"), agent("c"), agent("d"))
  assert.deepEqual(read(gone), gone, "an entry that's gone")
  const limited = { ...held, limited: true }
  assert.deepEqual(read(limited), limited, "a roster that reached its limit")
  const rewritten = roster(agent("a"), agent("b", 1, "canceled"), agent("c"), agent("d"))
  assert.deepEqual(read(rewritten), rewritten, "an entry rewritten without being observed")
  assert.equal(patchOf(held, roster(agent("b"), agent("a"), agent("c"), agent("d"))), undefined, "order moved: only whole says that")
  assert.equal(patchOf(held, roster(agent("e"), ...held.agents)), undefined, "a new entry anywhere but last: likewise")
  assert.equal(patchOf(roster(agent("a")), roster(agent("b", 2))), undefined, "more to say than the whole: whole")
  assert.equal(rosteredLiveBatch(batch(held), undefined), undefined, "nothing held to write against: whole")

  const patch = patchOf(held, moved)!
  assert.equal(applyRosterPatch(roster(agent("a"), agent("b"), agent("c")), patch), undefined, "a reader holding another roster reads nothing")
  assert.equal(applyRosterPatch(roster(agent("b"), agent("a"), agent("c"), agent("d")), patch), undefined, "nor one in another order")
  assert.equal(applyRosterPatch(roster(agent("a", 9), agent("b"), agent("c"), agent("d")), patch), undefined, "nor one with an entry at another moment")
  assert.equal(applyRosterPatch(roster(agent("a", 1, "canceled"), agent("b"), agent("c"), agent("d")), patch), undefined, "nor one with an entry standing otherwise")
  const expanded = expandLiveBatch({ ...rosteredLiveBatch(batch(moved), held)! }, { blocks: [] })
  assert.ok(expanded.unread, "a reader with no roster to read it against says so")
  assert.deepEqual(expanded.unreadRoster, patch)
  assert.equal(expanded.batch.nativeAgents, undefined, "and doesn't take a roster it can't read")

  // Only a host's own windows hear this form: a reader of any other gets the roster whole, or goes on showing the old one.
  const compact = batch(moved)
  const event = encodeRuntimeEvent({ type: "live-batch", batch: whole(moved), compact, rostered: rosteredLiveBatch(compact, held)! })
  assert.ok(payloadFor(event, WHOLE_LIVE_FORM)?.includes('"nativeAgents"'), "form 1 hears it whole")
  assert.ok(payloadFor(event, COMPACT_LIVE_FORM)?.includes('"nativeAgents"'), "form 2 hears it whole")
  assert.ok(payloadFor(event, ROSTER_LIVE_FORM)?.includes('"rosterPatch"'), "a window hears what changed")
  assert.ok(!payloadFor(event, ROSTER_LIVE_FORM)?.includes('"nativeAgents"'), "and not the roster too")
  assert.ok(payloadFor(event, ROSTER_LIVE_FORM)!.length < payloadFor(event, COMPACT_LIVE_FORM)!.length)
  assert.equal(saidLiveForm("3"), COMPACT_LIVE_FORM, "the gateway's link has no such form")
  assert.equal(saidWindowForm("3"), ROSTER_LIVE_FORM)
  assert.equal(saidWindowForm("2"), COMPACT_LIVE_FORM, "a window of an older build")
  assert.equal(saidWindowForm(undefined), WHOLE_LIVE_FORM)
}

async function recorded(folder: string): Promise<void> {
  const lines: string[] = []
  let boot: unknown[] = []
  const heard = (event: HostEvent) => {
    const encoded = encodeRuntimeEvent(event)
    lines.push(JSON.stringify({ channel: "event", type: encoded.type, conversation: encoded.conversation, payload: encoded.compact ?? encoded.payload, rostered: encoded.rostered }))
    if (event.type === "live-batch" && !seen.has(event.batch.id)) {
      seen.add(event.batch.id)
      discover(event.batch.id, lines.length)
    }
  }
  const held: string[] = []
  const seen = new Set<string>()
  const found: { id: string; asked: number; answered: number; file: string; found: true }[] = []
  // What a window reads on first hearing of a conversation: read here as the host would answer it.
  const discover = (id: string, asked: number) => queueMicrotask(() => {
    const file = `found-${found.length}.json`
    writeFileSync(join(folder, file), JSON.stringify(w.live.snapshot(id)))
    // Answered a little later, as a read is: what the stream says meanwhile is newer than it.
    found.push({ id, asked, answered: asked + 3, file, found: true })
  })
  const w: AgentsWorld = new AgentsWorld({
    root: join(folder, "world"),
    events: heard,
    script: (turn) => {
      if (!turn.text.includes("You're fin:")) return "Started them."
      held.push(turn.conversation)
      return turn.world.hold(turn.conversation).then(() => "Done: it's finished.")
    },
  })
  const opens: { id: string; asked: number; answered: number; file: string }[] = []
  try {
    const apex = await w.apex("codex")
    boot = w.live.summaries()
    for (const summary of w.live.listed()) seen.add(summary.session.id)
    const until = async (check: () => boolean) => { while (!check()) await new Promise((resolve) => setTimeout(resolve, 10)) }
    for (const name of ["one", "two", "three"]) {
      const started = await w.agents.start(apex.caller, { brief: { objective: "Work on it." }, harness: "claude", name, clientKey: `k-${name}`, cwd: w.root })
      assert.ok(!("refused" in started), JSON.stringify(started))
    }
    await until(() => held.length === 3)
    const [one, two, three] = held
    assert.ok(one && two && three, "three Fins are held")
    const open = (id: string) => {
      const file = `open-${opens.length}.json`
      const asked = lines.length + 1
      writeFileSync(join(folder, file), JSON.stringify(w.live.snapshot(id)))
      opens.push({ id, asked, answered: lines.length + 3, file })
    }
    // One's window opens it while it works, leaves it for two, and comes back; two asks the person something; three
    // finishes unseen; the Apex is told.
    const stream = (conversation: string, text: string) => w.live.observe({ type: "live-update", id: conversation, update: { kind: "text", text } })
    for (let at = 0; at < 30; at += 1) { stream(one, `one ${at} `); stream(two, `two ${at} `); await new Promise((resolve) => setTimeout(resolve, 5)) }
    open(one)
    for (let at = 30; at < 60; at += 1) { stream(one, `one ${at} `); stream(three, `three ${at} `); await new Promise((resolve) => setTimeout(resolve, 5)) }
    void w.ask(two, "Run the migration?")
    await new Promise((resolve) => setTimeout(resolve, 100))
    open(two)
    for (let at = 60; at < 80; at += 1) { stream(one, `one ${at} `); await new Promise((resolve) => setTimeout(resolve, 5)) }
    open(one)
    for (let at = 80; at < 100; at += 1) { stream(one, `one ${at} `); await new Promise((resolve) => setTimeout(resolve, 5)) }
    w.release(three)
    w.release(one)
    // Two still asks: a stream ends with something waiting, as a real one does.
    await until(() => w.live.held(three)?.session.status === "ready" && w.live.held(one)?.session.status === "ready")
    await new Promise((resolve) => setTimeout(resolve, 300))
    // A window that can't read a change asks: the roster goes whole in a batch of its own, in its place in the stream,
    // to every window; several asking before it goes share it.
    const batchesOf = (id: string, from: number) => lines.slice(from).flatMap((line) => {
      const packet = ReplayPacketSchema.parse(JSON.parse(line))
      const event = packet.conversation === id && packet.payload ? decodeRuntimeEvent<HostEvent>(packet.payload) : undefined
      return event?.type === "live-batch" ? [{ batch: event.batch, rostered: packet.rostered }] : []
    })
    const roster = w.live.held(apex.conversation)?.nativeAgents
    assert.ok(roster?.agents.length, "the Apex has its Fins")
    let from = lines.length
    assert.equal(w.live.sendRosterWhole(apex.conversation), true)
    assert.equal(w.live.sendRosterWhole(apex.conversation), true)
    await until(() => batchesOf(apex.conversation, from).length > 0)
    await new Promise((resolve) => setTimeout(resolve, 100))
    const sent = batchesOf(apex.conversation, from)
    assert.equal(sent.length, 1, "two asks, one batch")
    assert.deepEqual(sent[0]!.batch.nativeAgents, roster, "with the roster whole")
    assert.equal(sent[0]!.rostered, undefined, "to every window alike, a host's own included")
    assert.equal(w.live.sendRosterWhole("no-such-conversation"), false, "there's none of a conversation that isn't one")
    // One let go of since its last change is read back in to say it: its windows may yet need that change.
    await w.live.close(three)
    from = lines.length
    assert.ok(w.live["records"].release(three), "the finished Fin, closed, goes from memory")
    assert.equal(w.live.held(three), undefined)
    assert.equal(w.live.sendRosterWhole(three), true, "and is read back")
    await until(() => batchesOf(three, from).length > 0)
    assert.ok(batchesOf(three, from)[0]!.batch.nativeAgents, "its roster goes whole, an empty one where it has none")
  } finally {
    await w.close()
  }
  writeFileSync(join(folder, "stream.jsonl"), `${lines.join("\n")}\n`)
  writeFileSync(join(folder, "boot.json"), JSON.stringify({ at: 0, live: boot }))
  writeFileSync(join(folder, "opens.json"), JSON.stringify([...opens, ...found]))
}

// A capture proves the windows alone: what's caught there, the replay caught.
if (!capture) contract()
const folder = capture ?? mkdtempSync(join(tmpdir(), `mako-roster-${randomUUID().slice(0, 8)}-`))
try {
  if (!capture) await recorded(folder)
  const opens = z.array(ReplayOpenSchema).parse(JSON.parse(readFileSync(join(folder, "opens.json"), "utf8"))).filter((open) => !open.found)
  const places = opens.map((_, at) => at)
  const first = opens[0]!.id
  // Where the rosters are, for what to do to a window: the conversation that changes its roster most, and when.
  const moves = readFileSync(join(folder, "stream.jsonl"), "utf8").trim().split("\n").flatMap((text, at) => {
    const packet = ReplayPacketSchema.parse(JSON.parse(text))
    return packet.conversation && packet.payload?.includes('"nativeAgents":{') ? [{ conversation: packet.conversation, seq: at + 1, patch: Boolean(capture || packet.rostered) }] : []
  })
  const counts = new Map<string, number>()
  for (const move of moves) counts.set(move.conversation, (counts.get(move.conversation) ?? 0) + 1)
  const busiest = [...counts].sort((a, b) => b[1] - a[1])[0]![0]
  // What happens to a window happens just before a change it could read: one that goes whole would mend it unasked.
  const own = moves.filter((move) => move.conversation === busiest && move.patch)
  assert.ok(own.length > 1, "rosters go as what changed")
  const halfway = Math.floor(own.length / 2)
  const middle = own[halfway]!.seq, later = own[Math.floor((own.length * 3) / 4)]!.seq
  // A read long enough that of the two changes after the one that asks, its answer says the first and not the second.
  const slow = 2 * (own[Math.min(halfway + 2, own.length - 1)]!.seq - middle) - 1
  // A batch that said nothing of its roster, then changes close behind it: the roster it holds is right, and it can't know.
  const batches = readFileSync(join(folder, "stream.jsonl"), "utf8").trim().split("\n").flatMap((text, at) => {
    const packet = ReplayPacketSchema.parse(JSON.parse(text))
    return packet.conversation === busiest ? [{ seq: at + 1, roster: Boolean(packet.payload?.includes('"nativeAgents":{')) }] : []
  })
  const silent = batches.find((batch, at) => !batch.roster && own.filter((move) => move.seq > batch.seq).length > 1 && own.some((move) => move.seq === batches[at + 1]?.seq))
  // Its read goes out with the first change after it and answers as of before the next, which lands while it's on its way.
  const [firstAfter, nextAfter] = own.filter((move) => move.seq > (silent?.seq ?? 0))
  const windows: [string, ReplayPlan, (end: End) => void][] = [
    ["a window with nothing open", {}, (end) => assert.equal(end.rosterReads, 0, "with every change heard, it asks for none whole")],
    ["a window going from conversation to conversation", { opens: places }, () => {}],
    ["a window attaching mid-stream", { attach: middle }, (end) => assert.ok(end.rosterReads > 0, "attaching asks for the roster whole")],
    ["a window that misses batches", { gap: { conversation: busiest, from: middle, to: later } }, (end) => assert.ok(end.rosterReads > 0, "a gap asks for the roster whole")],
    ["a window holding another roster", { drift: { conversation: busiest, at: middle } }, (end) => assert.ok(end.rosterReads > 0, "the seal asks for the roster whole")],
    ["a window holding one from before a restart", { restart: { conversation: busiest, at: middle } }, (end) => assert.ok(end.rosterReads > 0, "another start's asks for it whole")],
    // Changes that land while the ask is on its way can't be read either, and the roster that goes whole mends them all.
    ["a window whose ask for a roster is slow", { attach: middle, lag: slow }, () => {}],
    ["one of two windows", { opens: places.filter((at) => opens[at]!.id === first) }, () => {}],
    ["the other of two windows", { opens: places.filter((at) => opens[at]!.id !== first) }, () => {}],
  ]
  if (silent) windows.push(["a window that misses a batch saying nothing of its roster", { gap: { conversation: busiest, from: silent.seq, to: silent.seq + 1 }, lag: Math.max(1, nextAfter!.seq - firstAfter!.seq) }, (end) => assert.ok(end.rosterReads > 0, "it can't know that, so it asks")])
  for (const [label, plan, check] of windows) {
    const end = await sameDrawn(folder, plan, label)
    check(end)
    // Two empty windows match too: this has to have drawn what it's meant to prove.
    if (!capture && !("attach" in plan)) {
      assert.ok(end.full.conversations.length >= 4, `${label}: the Fins were found (${end.full.conversations.length})`)
      assert.ok(end.full.notifications.length > 0, `${label}: a notification was raised`)
      assert.ok(end.full.children.some(([, children]) => children.length), `${label}: a Thread's Fins are drawn`)
    }
    console.log(`${label}: every store the same; ${end.rostered} of ${end.fullRosters} rosters as what changed, ${end.rosterReads} asked for whole, ${(end.wholeBytes / 1048576).toFixed(1)} MB to ${(end.rosteredBytes / 1048576).toFixed(1)} MB`)
  }
  console.log("Roster delta: a window draws the same from what changed as from whole rosters, opening conversations, attaching mid-stream, missing batches and holding another roster")
} finally {
  if (!capture) rmSync(folder, { recursive: true, force: true })
}
process.exit(0)
