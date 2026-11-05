import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"
import type { ThreadRef } from "@mako/sessions"
import { readMessage, writeMessage } from "@mako/sessions/context-wire"
import { threadReferenceId, threadToken, writeReference } from "@mako/sessions/thread-references"
import type { AgentCaller } from "@mako/host/contracts/agents"
import type { AgentMoved, AgentsMoveInput, AgentsMoveResult } from "@mako/host/contracts/agent-tools"
import { SessionIdSchema, ThreadIdSchema } from "@mako/host/contracts/thread-identity"
import { arriving } from "@mako/host/contracts/request-hold"
import { signInPause } from "@mako/host/contracts/sign-in-hold"
import { FROM_AGENTS } from "@mako/host/conversations/agent-wakes"
import { LiveRequestSchema } from "@mako/host/conversations/live-journal"
import { threadHistoryTools } from "@mako/host/conversations/thread-history"
import { HARNESSES, AgentsWorld, type Script, type WorldOptions } from "./lib/agents-world.ts"

/**
 * `agents_move` and the one operation under it (`npm run test:fin-move`). A Thread goes on on another harness through
 * `continueOn`, whoever asks, and nothing it needs comes from the harness it leaves. Every harness moves a Fin to each
 * of the others from idle, from stopped and from out of usage; the Fin keeps its Thread, name, edge and worktree, its
 * waiting message arrives once, a Stop still wins, its report reaches its Apex. A caller that goes around `continueOn`
 * fails here. So do a reference an agent attaches that differs from a person's chip, and a Thread outside the tree
 * that `thread_history` would read.
 */
const root = mkdtempSync(join(tmpdir(), "mako-fin-move-"))
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const repo = join(import.meta.dirname, "..")
let fixtures = 0

async function until(what: string, done: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`)
    await pause(5)
  }
}

function moved(answer: AgentsMoveResult): AgentMoved {
  assert.ok(!("refused" in answer), `refused: ${"refused" in answer ? answer.why : ""}`)
  assert.equal(answer.moved.length, 1)
  return answer.moved[0]!
}

interface Fixture {
  world: AgentsWorld
  apex: { conversation: string; caller: AgentCaller }
  fin(): { child: string; conversation: string; name: string }
  prompts(): { harness: string; text: string }[]
  wakes: string[]
}

/** An Apex on `apex` with one Fin, "labels", on `harness`, whose first turn ends at once, or with `hold` holds until it's stopped. */
async function fixture(harness: string, options: Partial<WorldOptions> & { hold?: boolean; access?: "full" | "auto"; apex?: string } = {}): Promise<Fixture> {
  const wakes: string[] = []
  let turns = 0
  let finConversation = ""
  const script: Script = async (turn) => {
    if (turn.conversation === finConversation || turn.text.includes("You're fin:")) {
      finConversation = turn.conversation
      turns += 1
      if (turns === 1 && options.hold) return turn.world.hold(turn.conversation).then(() => "Cut short.")
      return "Labels finished."
    }
    if (turn.text.startsWith(FROM_AGENTS)) wakes.push(turn.text)
    return "ok"
  }
  const world = new AgentsWorld({ root: join(root, `w${(fixtures += 1)}`), script, ...options })
  const apex = await world.apex(options.apex ?? "claude", options.access ?? "full")
  const started = await world.agents.start(apex.caller, { brief: { objective: "Label everything" }, name: "labels", harness, cwd: world.root, clientKey: "labels" })
  assert.ok(!("refused" in started), JSON.stringify(started))
  const child = started.child!
  await until("its turn to start", () => world.prompts.some((prompt) => prompt.text.includes("You're fin:")))
  const fin = () => {
    const conversation = world.store.thread(ThreadIdSchema.parse(child))?.sessions.flatMap((session) => world.store.conversationsOf(session))[0]
    return { child, name: "labels", conversation: conversation! }
  }
  return {
    world,
    apex,
    fin,
    prompts: () => world.prompts.filter((prompt) => prompt.conversation === fin().conversation),
    wakes,
  }
}

/** Pairs run side by side: each has a world of its own, and one after another they take minutes. */
const AT_ONCE = 6
const TARGETS = HARNESSES.flatMap((from) => HARNESSES.filter((to) => to !== from).map((to) => ({ from, to })))
const sameFin = async ({ world, fin }: Fixture, before: { child: string; conversation: string; name: string; parent?: string; cwd?: string }, to: string) => {
  const now = fin()
  assert.equal(now.child, before.child, "the same Thread")
  assert.equal(now.conversation, before.conversation, "the same conversation")
  const edge = world.store.edges().of(before.child)
  assert.equal(edge?.name, before.name, "the same name")
  assert.equal(edge?.parent, before.parent, "the same edge")
  assert.equal(edge?.asked.harness, to, "the edge says where it runs")
  assert.equal(world.live.session(now.conversation)?.cwd, before.cwd, "the same folder")
  assert.equal(world.live.session(now.conversation)?.harness, to)
}
const snapshotOf = (f: Fixture) => {
  const { child, conversation, name } = f.fin()
  return { child, conversation, name, parent: f.world.store.edges().of(child)?.parent, cwd: f.world.live.session(conversation)?.cwd }
}

const move = (f: Fixture, to: string, key = randomUUID(), extra: Partial<AgentsMoveInput> = {}) => f.world.agents.move(f.apex.caller, { child: "labels", harness: to, clientKey: key, ...extra })

async function idle(from: string, to: string): Promise<void> {
  const f = await fixture(from)
  await f.world.settle(40, 20_000)
  const before = snapshotOf(f)
  const sentBefore = f.prompts().length
  const answer = moved(await move(f, to))
  assert.equal(answer.state, "moved")
  assert.equal(answer.from, from)
  assert.match(answer.hears, /runs nothing until your next message/)
  await sameFin(f, before, to)
  assert.equal(f.prompts().length, sentBefore, "a move with nothing waiting starts no turn")
  const said = await f.world.agents.send(f.apex.caller, { to: "labels", text: "What did you do first?", clientKey: "next" })
  assert.ok(!("refused" in said), JSON.stringify(said))
  await until("the next message", () => f.prompts().length === sentBefore + 1)
  const prompt = f.prompts().at(-1)!
  assert.equal(prompt.harness, to, "the next message goes on the destination")
  assert.ok(prompt.text.includes("What did you do first?"))
  const carried = f.world.live.snapshot(before.conversation)!.requests.filter((request) => request.context?.some((manifest) => manifest.includesBase))
  assert.equal(carried.length, 1, "the history goes with one message, once")
  await f.world.settle(40, 20_000)
  assert.ok(f.world.store.reportsOf(before.child, 0).some((report) => report.summary.includes("Labels finished")), "its turn reports")
  await f.world.close()
}

async function stopped(from: string, to: string): Promise<void> {
  const f = await fixture(from, { hold: true })
  await until("its turn to run", () => f.world.live.session(f.fin().conversation)?.status === "running")
  const before = snapshotOf(f)
  const sent = await f.world.agents.send(f.apex.caller, { to: "labels", text: "paused-message", clientKey: "paused" })
  assert.ok(!("refused" in sent), JSON.stringify(sent))
  const stop = await f.world.agents.stop(f.apex.caller, { child: "labels", reason: "not now" })
  assert.ok(!("refused" in stop), JSON.stringify(stop))
  f.world.release(before.conversation)
  await until("its turn to stop", () => f.world.live.session(before.conversation)?.status !== "running")
  await f.world.settle(40, 20_000, "ignore")
  const sentBefore = f.prompts().length
  const answer = moved(await move(f, to))
  assert.match(answer.hears, /stays stopped/)
  await sameFin(f, before, to)
  await f.world.settle(40, 20_000, "ignore")
  assert.equal(f.prompts().length, sentBefore, "Stop wins: nothing is sent after the move")
  assert.ok(f.world.store.edges().of(before.child)?.closedAt !== undefined, "it stays stopped")
  const held = f.world.live.snapshot(before.conversation)!.requests.find((request) => request.text.includes("paused-message"))
  assert.equal(held?.status, "held", "what the Stop paused stays paused")
  assert.equal(held?.pause, "stop")
  const resumed = await f.world.agents.send(f.apex.caller, { to: "labels", text: "Go on", clientKey: "go" })
  assert.ok(!("refused" in resumed), JSON.stringify(resumed))
  await until("the paused message", () => f.prompts().some((prompt) => prompt.text.includes("paused-message")))
  await f.world.settle(40, 20_000)
  const sends = f.prompts().filter((prompt) => prompt.text.includes("paused-message"))
  assert.equal(sends.length, 1, "it arrives once")
  assert.equal(sends[0]!.harness, to)
  await f.world.close()
}

async function outOfUsage(from: string, to: string): Promise<void> {
  let out = false
  const f = await fixture(from, { apex: from === "claude" ? "codex" : "claude", refusePrompt: (_conversation, harness) => (out && harness === from ? "You've hit your usage limit. Your plan resets on 11/8/2026." : undefined) })
  await f.world.settle(40, 20_000)
  const before = snapshotOf(f)
  out = true
  const said = await f.world.agents.send(f.apex.caller, { to: "labels", text: "queued-message", clientKey: "queued" })
  assert.ok(!("refused" in said), JSON.stringify(said))
  await until("its harness to refuse it", () => f.world.live.snapshot(before.conversation)!.requests.some((request) => request.status === "held" && request.retry?.cause === "rate-limited"))
  const answer = moved(await move(f, to))
  assert.equal(answer.state, "moved")
  assert.match(answer.hears, /takes what waited for it there now/)
  await sameFin(f, before, to)
  await until("the message on its destination", () => f.prompts().some((prompt) => prompt.harness === to && prompt.text.includes("queued-message")))
  await f.world.settle(40, 20_000)
  assert.equal(f.prompts().filter((prompt) => prompt.text.includes("queued-message")).length, 1, "it arrives once")
  assert.ok(f.wakes.length > 0 || f.world.store.reportsOf(before.child, 0).some((report) => report.summary.includes("Labels finished")), "its report reaches its Apex")
  await f.world.close()
}

async function everyPair(): Promise<void> {
  // `PAIRS=0` leaves them out, to run the rest quickly.
  const waiting = process.env.PAIRS === "0" ? [] : [...TARGETS]
  await Promise.all(Array.from({ length: AT_ONCE }, async () => {
    for (let pair = waiting.shift(); pair; pair = waiting.shift()) {
      await idle(pair.from, pair.to)
      await stopped(pair.from, pair.to)
      await outOfUsage(pair.from, pair.to)
    }
  }))
}

/** Cases that only one pair needs: what's refused, a repeat, `all`, a Stop landing as it moves. */
async function refusals(): Promise<void> {
  {
    const f = await fixture("claude", { limits: { codex: { account: "work", until: Date.now() + 3_600_000, instead: "home" } } })
    await f.world.settle(40, 20_000)
    const answer = await move(f, "codex")
    assert.ok("refused" in answer && answer.refused === "limited", JSON.stringify(answer))
    assert.match(answer.why, /at its limit on work until/)
    assert.equal(f.world.live.session(f.fin().conversation)?.harness, "claude")
    const nowhere = await move(f, "nothing")
    assert.ok("refused" in nowhere && nowhere.refused === "unknown-harness")
    await f.world.close()
  }
  {
    // A harness whose every mode is wider than the Apex's own is refused, as a start there is.
    const f = await fixture("codex", { access: "auto", ladders: { cursor: [{ id: "full-access", name: "Full", access: "full" }] } })
    await f.world.settle(40, 20_000)
    const answer = await move(f, "cursor")
    assert.ok("refused" in answer && answer.refused === "access", JSON.stringify(answer))
    await f.world.close()
  }
  {
    const f = await fixture("claude", { hold: true })
    await until("its turn to run", () => f.world.live.session(f.fin().conversation)?.status === "running")
    const answer = await move(f, "codex")
    assert.ok("refused" in answer && answer.refused === "conflict", JSON.stringify(answer))
    assert.match(answer.why, /at work/)
    f.world.release(f.fin().conversation)
    await f.world.settle(40, 20_000)
    const key = randomUUID()
    const first = moved(await move(f, "codex", key))
    const again = await move(f, "codex", key)
    assert.ok(!("refused" in again) && again.deduped, "a repeat of its key is the same move")
    assert.equal(first.state, "moved")
    assert.equal(moved(await move(f, "codex")).state, "here", "a move to where it is does nothing")
    assert.equal(f.world.live.snapshot(f.fin().conversation)?.control?.transfers.filter((transfer) => transfer.state.kind === "accepted").length, 1)
    await f.world.close()
  }
  {
    // A Thread moved twice with nothing sent between carries its history once, from the last move.
    const f = await fixture("grok")
    await f.world.settle(40, 20_000)
    moved(await move(f, "codex"))
    moved(await move(f, "opencode"))
    const { conversation } = f.fin()
    assert.equal(f.world.live.snapshot(conversation)?.control?.merges.filter((merge) => merge.status === "pending").length, 1)
    await f.world.agents.send(f.apex.caller, { to: "labels", text: "Next", clientKey: "n" })
    await until("the message", () => f.prompts().some((prompt) => prompt.text.includes("Next")))
    assert.equal(f.prompts().at(-1)!.harness, "opencode")
    assert.equal(f.world.live.snapshot(conversation)?.requests.at(-1)?.context?.length, 1)
    await f.world.close()
  }
  {
    // `all` moves what can move and says why the rest stayed.
    const f = await fixture("codex")
    await f.world.settle(40, 20_000)
    const second = await f.world.agents.start(f.apex.caller, { brief: { objective: "Hold" }, name: "busy", harness: "codex", cwd: f.world.root, clientKey: "busy" })
    assert.ok(!("refused" in second))
    await f.world.settle(40, 20_000)
    const answer = await f.world.agents.move(f.apex.caller, { all: true, harness: "claude", clientKey: "all" })
    assert.ok(!("refused" in answer), JSON.stringify(answer))
    assert.deepEqual(answer.moved.map((fin) => fin.state).sort(), ["moved", "moved"])
    await f.world.close()
  }
  {
    // A move's destination that won't start leaves the Thread where it was, and says why.
    let refuse = false
    const f = await fixture("codex", { starting: async (_conversation, harness) => {
      if (refuse && harness === "claude") throw new Error("Claude could not start here")
    } })
    await f.world.settle(40, 20_000)
    refuse = true
    const answer = await move(f, "claude")
    assert.ok("refused" in answer && answer.refused === "unavailable", JSON.stringify(answer))
    assert.match(answer.why, /stayed on Codex: Claude could not start here/)
    assert.equal(f.world.live.session(f.fin().conversation)?.harness, "codex")
    await f.world.close()
  }
  {
    // Another Apex's Fin can't be moved.
    const f = await fixture("codex")
    const other = await f.world.apex("claude", "full")
    const answer = await f.world.agents.move(other.caller, { child: "labels", harness: "claude", clientKey: "stranger" })
    assert.ok("refused" in answer && answer.refused === "unknown-child", JSON.stringify(answer))
    await f.world.close()
  }
}

/** What the queue does as a move lands, each hold by what it's about. */
async function landing(): Promise<void> {
  {
    // Every waiting row goes on the target, in order, the transcript with the first, and a digest said to go first does.
    let out = false
    const f = await fixture("codex", { refusePrompt: (_conversation, harness) => (out && harness === "codex" ? "You've hit your usage limit." : undefined) })
    await f.world.settle(40, 20_000)
    const { conversation } = f.fin()
    out = true
    const one = randomUUID()
    f.world.live.submit(conversation, one, "row-one", [])
    await until("it to wait", () => f.world.live.snapshot(conversation)!.requests.some((request) => request.id === one && request.retry))
    const two = randomUUID()
    f.world.live.submit(conversation, two, "row-two", [])
    const digest = randomUUID()
    f.world.live.submit(conversation, digest, "row-digest", [])
    const id = randomUUID()
    await f.world.continueOn(conversation, { kind: "move", move: { id, to: { harness: "claude" }, first: digest } }, { kind: "service", name: "auto-continue" })
    await until("all three", () => ["row-one", "row-two", "row-digest"].every((words) => f.prompts().some((prompt) => prompt.text.includes(words))))
    await f.world.settle(40, 20_000)
    const order = f.prompts().filter((prompt) => prompt.text.includes("row-")).map((prompt) => /row-\w+/.exec(prompt.text.slice(prompt.text.lastIndexOf("row-")))![0])
    assert.deepEqual(order, ["row-digest", "row-one", "row-two"], "the digest first, the rest in their order, each once")
    const requests = f.world.live.snapshot(conversation)!.requests
    assert.equal(requests.find((request) => request.id === digest)?.context?.length, 1, "the hand-over context goes with the first")
    assert.ok(requests.filter((request) => request.id === one || request.id === two).every((request) => !request.context?.length))
    await f.world.close()
  }
  {
    // A Stop while it opens retires it: no binding changes, the caller hears, and it can ask again.
    let open: (() => void) | undefined
    let gated = false
    const f = await fixture("codex", { starting: async (_conversation, harness) => {
      if (gated && harness === "claude") await new Promise<void>((resolve) => { open = resolve })
    } })
    await f.world.settle(40, 20_000)
    const { conversation } = f.fin()
    const active = f.world.live.snapshot(conversation)!.control!.activeBindingId
    gated = true
    const asked = f.world.agents.move(f.apex.caller, { child: "labels", harness: "claude", clientKey: "stopped" })
    await until("it to open", () => open !== undefined)
    await f.world.agents.stop(f.apex.caller, { child: "labels", reason: "not now" })
    open!()
    const answer = await asked
    assert.ok("refused" in answer && answer.refused === "unavailable", JSON.stringify(answer))
    assert.match(answer.why, /stayed on Codex: A Stop reached it before it moved/)
    assert.equal(f.world.live.snapshot(conversation)!.control!.activeBindingId, active, "no binding changes after a Stop")
    assert.equal(f.world.live.session(conversation)?.harness, "codex")
    gated = false
    open = undefined
    assert.equal(moved(await f.world.agents.move(f.apex.caller, { child: "labels", harness: "claude", clientKey: "again" })).state, "moved", "asked again, it moves, and the Fin stays stopped")
    assert.ok(f.world.store.edges().of(f.fin().child)?.closedAt !== undefined)
    await f.world.close()
  }
  {
    // A move left at a restart is retired, and the Apex hears. It stays on the source.
    const f = await fixture("codex", { hold: true })
    await until("its turn", () => f.world.live.session(f.fin().conversation)?.status === "running")
    const { conversation, child } = f.fin()
    const id = randomUUID()
    await f.world.continueOn(conversation, { kind: "move", move: { id, to: { harness: "grok" } } }, { kind: "service", name: "auto-continue" })
    assert.equal(f.world.live.snapshot(conversation)?.control?.transfers.find((transfer) => transfer.input.id === id)?.state.kind, "queued", "it waits for the turn")
    await f.world.restart()
    await f.world.settle(40, 20_000, "ignore")
    const left = f.world.live.snapshot(conversation)?.control?.transfers.find((transfer) => transfer.input.id === id)
    assert.equal(left?.state.kind, "failed", JSON.stringify(left?.state))
    assert.equal(f.world.live.session(conversation)?.harness, "codex")
    assert.ok(f.world.store.reportsOf(child, 0).some((report) => report.summary.includes("Mako restarted before it moved")), "whoever asked hears")
    await f.world.close()
  }
  {
    // A failed close puts everything back: the binding, and the rows it freed, with no manifest left for the source.
    let failing = false
    const f = await fixture("codex", { refusePrompt: (_conversation, harness) => (harness === "codex" && failing ? "You've hit your usage limit." : undefined), closing: async () => {
      if (failing) throw new Error("synthetic close failure")
    } })
    await f.world.settle(40, 20_000)
    const { conversation } = f.fin()
    failing = true
    const row = randomUUID()
    f.world.live.submit(conversation, row, "row-held", [])
    await until("it to wait", () => f.world.live.snapshot(conversation)!.requests.some((request) => request.id === row && request.retry))
    const id = randomUUID()
    const settled = f.world.live.switchSettled(id)
    await f.world.continueOn(conversation, { kind: "move", move: { id, to: { harness: "claude" } } }, { kind: "service", name: "auto-continue" })
    const outcome = await settled
    assert.equal(outcome.state.kind, "failed", JSON.stringify(outcome.state))
    const after = f.world.live.snapshot(conversation)!
    assert.equal(after.session.harness, "codex")
    assert.equal(after.requests.find((request) => request.id === row)?.status, "held", "a failed move leaves its row where it was")
    assert.ok(after.requests.find((request) => request.id === row)?.retry)
    assert.equal(after.control?.merges.filter((merge) => merge.status === "pending").length, 0, "no manifest is left for the source's next message")
    failing = false
    await f.world.close().catch(() => {})
  }
  {
    // Stop's latch declines an automatic move, and an agent's goes.
    const f = await fixture("codex", { hold: true })
    await until("its turn", () => f.world.live.session(f.fin().conversation)?.status === "running")
    const { conversation } = f.fin()
    await f.world.agents.send(f.apex.caller, { to: "labels", text: "paused-row", clientKey: "p" })
    await f.world.agents.stop(f.apex.caller, { child: "labels", reason: "wait" })
    f.world.release(conversation)
    await f.world.settle(40, 20_000, "ignore")
    assert.equal(await f.world.continueOn(conversation, { kind: "move", move: { id: randomUUID(), to: { harness: "claude" }, unlessStopped: true } }, { kind: "service", name: "auto-continue" }), undefined, "an automatic move yields to a Stop")
    assert.equal(f.world.live.session(conversation)?.harness, "codex")
    await f.world.close()
  }
  {
    // What's decided is read again right before the commit: declined there, it never commits.
    let decided = true
    let open: (() => void) | undefined
    let gated = false
    const f = await fixture("codex", { starting: async (_conversation, harness) => {
      if (gated && harness === "claude") await new Promise<void>((resolve) => { open = resolve })
    } })
    await f.world.settle(40, 20_000)
    const { conversation } = f.fin()
    gated = true
    const id = randomUUID()
    const settled = f.world.live.switchSettled(id)
    await f.world.continueOn(conversation, { kind: "move", move: { id, to: { harness: "claude" } } }, { kind: "service", name: "auto-continue" }, () => decided)
    await until("it to open", () => open !== undefined)
    decided = false
    open!()
    assert.equal((await settled).state.kind, "failed")
    assert.equal(f.world.live.session(conversation)?.harness, "codex")
    await f.world.close()
  }
  {
    // The same harness: an account its session goes on under pins it where it is, and another is a hand-over. Both pin.
    const f = await fixture("claude", { resumesUnderAccount: ["claude"], apex: "codex" })
    await f.world.settle(40, 20_000)
    const { conversation } = f.fin()
    const before = f.world.live.snapshot(conversation)!.control!
    await f.world.continueOn(conversation, { kind: "move", move: { id: randomUUID(), to: { harness: "claude", account: "spare" } } }, { kind: "service", name: "auto-continue" })
    const after = f.world.live.snapshot(conversation)!.control!
    assert.equal(after.activeBindingId, before.activeBindingId, "it resumes its own session")
    assert.equal(after.bindings.length, before.bindings.length)
    assert.equal(f.world.live.pinnedAccount(conversation, "claude"), "spare")
    assert.equal(f.world.live.pinnedAccount(conversation, "codex"), undefined)
    await f.world.close()
    const g = await fixture("codex")
    await g.world.settle(40, 20_000)
    const handed = g.fin().conversation
    const was = g.world.live.snapshot(handed)!.control!
    const id = randomUUID()
    const settled = g.world.live.switchSettled(id)
    await g.world.continueOn(handed, { kind: "move", move: { id, to: { harness: "codex", account: "spare" } } }, { kind: "service", name: "auto-continue" })
    assert.equal((await settled).state.kind, "accepted")
    const now = g.world.live.snapshot(handed)!.control!
    assert.notEqual(now.activeBindingId, was.activeBindingId, "a harness that can't go on hands over to a session of its own")
    assert.equal(g.world.live.pinnedAccount(handed, "codex"), "spare")
    assert.equal(now.merges.filter((merge) => merge.status === "pending").length, 1, "with the conversation")
    await g.world.close()
  }
  {
    // A sign-out's hold is about the account it leaves: it goes, and no notice waits for it. Its own account's stays.
    const f = await fixture("claude", { apex: "codex", resumesUnderAccount: ["claude"] })
    await f.world.settle(40, 20_000)
    const hold = { harness: "claude", account: "work", credential: "c", at: Date.now() }
    const held = (text: string, pause?: "stop", editing?: true) => LiveRequestSchema.parse({ id: randomUUID(), createdAt: Date.now(), text, attachments: [], status: "held" as const, signIn: hold, actor: { kind: "agent" as const, session: SessionIdSchema.parse(randomUUID()) }, ...(pause && { pause }), ...(editing && { editing }) })
    const rows = [held("kept-going"), held("stopped-row", "stop"), held("edited-row", undefined, true)]
    const same = arriving(rows, { harness: "claude", account: "work" }, false)
    assert.ok(same.every((row) => row.signIn), "landing on the very account that signed out, the hold stays")
    assert.ok(signInPause(same))
    for (const to of [{ harness: "codex" }, { harness: "claude", account: "spare" }]) {
      const gone = arriving(rows, to, to.harness !== "claude")
      assert.equal(signInPause(gone), undefined, "no notice is left waiting for that sign-in")
      assert.deepEqual(gone.map((row) => row.status), ["queued", "held", "held"], "a hold about the person stays")
      assert.equal(gone[1]!.pause, "stop")
      assert.equal(gone[2]!.editing, true)
    }
    await f.world.close()
  }
}

/** Only `continueOn` reaches a switch to another harness: a new caller of `transfer` fails here. */
function onePath(): void {
  const host = join(repo, "packages/host/src")
  const files: string[] = []
  const walk = (folder: string) => {
    for (const name of readdirSync(folder)) {
      const path = join(folder, name)
      if (statSync(path).isDirectory()) walk(path)
      else if (path.endsWith(".ts")) files.push(path)
    }
  }
  walk(host)
  /** Who may call it, each for what it is: `continueOn` itself, and reconnects, which stay on their own harness. */
  const allowed = new Map([
    ["conversations/continue-on.ts", /live\.transfer\(id, \{ \.\.\.continuation\.input/],
    ["conversations/live-conversations.ts", /this\.transfer\(id, input, actor, continues\)|this\.transfer\(id, \{\s+id: requestId,\s+provider: resident\.snapshot\.session\.harness|this\.transfer\(id, \{ id: requestId, bindingId, provider: binding\.provider/],
    ["conversations/live-auto-continue.ts", /this\.access\.transfer\(id, \{ id: request\.id, provider: reconnect\.provider/],
  ])
  for (const path of files) {
    const text = readFileSync(path, "utf8")
    const file = relative(host, path)
    for (const call of text.matchAll(/(?:live|this|this\.access|this\.deps\.live|access)\.transfer\(/g)) {
      const allow = allowed.get(file)
      assert.ok(allow, `${file} calls transfer: go through continueOn`)
      assert.ok(allow.test(text.slice(call.index, call.index + 200)), `${file} calls transfer with something new: ${text.slice(call.index, call.index + 80)}`)
    }
    for (const call of text.matchAll(/\.moveOn\(/g))
      assert.equal(file, "conversations/continue-on.ts", `${file} moves a Thread beside continueOn: ${text.slice(call.index, call.index + 60)}`)
    if (file !== "conversations/continue-on.ts" && file !== "conversations/live-conversations.ts")
      assert.ok(!/live\.continueBinding\((?!id, bindingId, requestId, text, attachments, selected\))/.test(text), `${file} continues a binding beside continueOn`)
  }
  const agents = readFileSync(join(host, "conversations/agents.ts"), "utf8")
  assert.ok(!/"transfer"/.test(agents.slice(0, agents.indexOf("export interface AgentsDeps"))), "Agents reaches no transfer of its own")
  const methods = readFileSync(join(host, "conversations/index.ts"), "utf8")
  const handler = methods.slice(methods.indexOf('methods.handle("mako:live-transfer"'), methods.indexOf('methods.handle("mako:live-edit-queued"'))
  assert.ok(handler.includes("conversations.continueOn(id,") && !handler.includes("live.transfer"), "The person's switch goes through continueOn")
  assert.ok(handler.indexOf("TransferInputSchema") < handler.indexOf("})"), handler)
}

/** The agent tool and a relaunch reach `continueOn`, each saying who asked. */
async function callersShareIt(): Promise<void> {
  const f = await fixture("codex")
  await f.world.settle(40, 20_000)
  moved(await move(f, "claude"))
  assert.deepEqual(f.world.continued.at(-1), { conversation: f.fin().conversation, to: "claude", kind: "move", by: "agent" })
  await f.world.close()

  // An exit that cut a Fin's launch: its brief goes on a relaunch when the next host looks, once.
  let stall: ((error: Error) => void) | undefined
  let stalling = true
  const cut = new AgentsWorld({ root: join(root, "relaunch"), script: () => "Done", starting: async (_conversation, harness) => {
    if (harness === "codex" && stalling) await new Promise<void>((_resolve, reject) => { stall = reject })
  } })
  const apex = await cut.apex("claude", "full")
  void cut.agents.start(apex.caller, { brief: { objective: "Label the rows" }, name: "cut", harness: "codex", cwd: cut.root, clientKey: "cut" }).catch(() => undefined)
  await until("its launch to stall", () => stall !== undefined)
  stalling = false
  stall!(new Error("the host stopped"))
  await cut.restart()
  await until("its brief", () => cut.prompts.some((prompt) => prompt.text.includes("Label the rows")))
  await cut.settle(40, 20_000, "ignore")
  assert.equal(cut.prompts.filter((prompt) => prompt.text.includes("Label the rows")).length, 1, "its brief goes once")
  assert.ok(cut.continued.some((entry) => entry.kind === "words" && entry.to === "codex" && entry.by === "agent"), JSON.stringify(cut.continued))
  await cut.close()
}

/** An agent's `context` writes what a person's chip writes, and the Fin reads the Thread whole through `thread_history`. */
async function attaching(): Promise<void> {
  const path = join(root, "native-other")
  const row: ThreadRef = { harness: "codex", nativeId: "other-session", path, title: "Fix the login redirect", cwd: root, updatedAt: new Date().toISOString() }
  const artifact = { kind: "file" as const, file: "/tmp/t/transcript.md", note: "Local transcript bundle: /tmp/t/transcript.md", title: "Fix the login redirect", harness: "codex", turns: 1, digest: "d", losses: [] }
  const f = await fixture("claude", { references: { list: () => [row], transcriptArtifact: async () => artifact } })
  await f.world.settle(40, 20_000)
  const raw = threadToken("codex", threadReferenceId(row))
  const said = await f.world.agents.send(f.apex.caller, { to: "labels", text: "Read it", clientKey: "attach", context: [{ thread: raw }] })
  assert.ok(!("refused" in said), JSON.stringify(said))
  await until("the message", () => f.prompts().some((prompt) => prompt.text.includes("Read it")))
  const request = f.world.live.snapshot(f.fin().conversation)!.requests.at(-1)!
  const read = readMessage(request.text)
  const written = writeReference({ raw, harness: "codex", id: "other-session" }, { thread: row, ref: raw.slice(1), context: artifact })
  const chip = writeMessage({ body: "x", items: [{ n: 1, kind: written.kind, attrs: written.attrs, body: written.body }] })
  const person = chip.slice(chip.indexOf("<mako_context"))
  assert.equal(request.text.slice(request.text.indexOf("<mako_context")), person, "the block is byte for byte what a chip writes")
  assert.equal(read.items[0]?.attrs.ref, raw.slice(1))
  const unknown = await f.world.agents.send(f.apex.caller, { to: "labels", text: "No", clientKey: "bad", context: [{ thread: "not-a-thread" }] })
  assert.ok("refused" in unknown && unknown.refused === "unknown-thread", JSON.stringify(unknown))
  const started = await f.world.agents.start(f.apex.caller, { brief: { objective: "Follow up" }, name: "second", harness: "codex", cwd: f.world.root, clientKey: "second", context: [{ thread: "labels" }] })
  assert.ok(!("refused" in started), JSON.stringify(started))
  await f.world.settle(40, 20_000)
  const second = f.world.prompts.find((prompt) => prompt.text.includes("Follow up"))!
  assert.equal(readMessage(second.text.slice(second.text.indexOf("Follow up"))).items[0]?.kind, "conversation", "its first message carries the item")
  const found = await f.world.agents.list(f.apex.caller, { scope: "threads", query: "login" })
  assert.ok("threads" in found && found.threads[0]?.ref === raw.slice(1), JSON.stringify(found))
  const byName = await f.world.agents.list(f.apex.caller, { scope: "threads", query: "labels" })
  assert.ok("threads" in byName && byName.threads[0]?.ref.startsWith("thread:claude:"), JSON.stringify(byName))
  await f.world.close()
}

/** An Apex and a Fin read each other, a Fin its sibling, and a Thread outside the tree stays refused. */
async function reading(): Promise<void> {
  const f = await fixture("claude")
  await f.world.settle(40, 20_000)
  const second = await f.world.agents.start(f.apex.caller, { brief: { objective: "Next" }, name: "second", harness: "codex", cwd: f.world.root, clientKey: "second" })
  assert.ok(!("refused" in second) && second.child)
  await f.world.settle(40, 20_000)
  const stranger = await f.world.apex("grok", "full")
  f.world.say(stranger.conversation, "A private matter")
  await f.world.settle(40, 20_000)
  const tools = threadHistoryTools({
    conversations: () => f.world.live.summaries(),
    snapshot: (id) => f.world.live.historySnapshot(id),
    store: () => f.world.store,
    catalog: { list: () => [], nativePath: () => undefined, ref: () => undefined, open: async () => null, entry: async () => null },
    bundle: { live: (id) => f.world.live.transcriptBundle(id), native: async () => null },
  })
  const apexThread = f.world.store.journalPlacement(f.apex.conversation)!.thread
  const { child, conversation } = f.fin()
  assert.match(await tools.answer(f.apex.conversation, { action: "read", thread: child, turns: "1" }), /Label everything/, "an Apex reads its Fin by Thread ID")
  assert.match(await tools.answer(f.apex.conversation, { action: "read", thread: "fin:labels", turns: "1" }), /Label everything/, "and by name")
  assert.ok((await tools.answer(conversation, { action: "turns", thread: apexThread })).length > 0, "a Fin reads its Apex")
  assert.match(await tools.answer(conversation, { action: "read", thread: "second", turns: "1" }), /Next/, "a Fin reads the Fin beside it")
  await assert.rejects(tools.answer(conversation, { action: "turns", thread: f.world.store.journalPlacement(stranger.conversation)!.thread }), /isn't in this Thread's tree/, "a Thread outside the tree stays refused")
  await assert.rejects(tools.answer(f.apex.conversation, { action: "turns", thread: "thread:grok:native-" + stranger.conversation }), /isn't in this Thread's tree/)
  // A moved Fin's history is one Thread's: its earlier turns on the harness it left read the same.
  moved(await move(f, "codex"))
  assert.match(await tools.answer(f.apex.conversation, { action: "read", thread: child, turns: "1" }), /Label everything/)
  const read = await f.world.agents.read(f.apex.caller, { child: "labels", view: "transcript" })
  assert.ok(!("refused" in read) && read.whole?.includes(child) && read.whole.includes("export"), "agents_read says where the whole is")
  const searched = await tools.answer(f.apex.conversation, { action: "search", thread: "tree", query: "Label everything" })
  assert.match(searched, /fin:labels \(/, "an Apex searches its whole tree, each hit under its Thread")
  assert.match(await tools.answer(f.apex.conversation, { action: "search", thread: "tree", query: "objective: Next|^Next$", regex: true }), /hit|No match/)
  assert.doesNotMatch(await tools.answer(f.apex.conversation, { action: "search", thread: "tree", query: "A private matter" }).catch((error: Error) => error.message), /fin:|hit for/, "its tree, and nothing else")
  assert.match(await tools.answer(conversation, { action: "search", thread: "tree", query: "Next" }), /fin:second/, "a Fin searches the tree it's in too")
  await assert.rejects(tools.answer(f.apex.conversation, { action: "read", thread: "tree" }), /is for search/)
  const exported = await tools.answer(f.apex.conversation, { action: "export", thread: child })
  const file = /: (\/\S+transcript\.md)/.exec(exported)?.[1]
  assert.ok(file, exported)
  assert.match(readFileSync(file, "utf8"), /Label everything/, "its history exports to the bundle a chip hands over")
  await f.world.close()
}

try {
  mkdirSync(root, { recursive: true })
  onePath()
  await refusals()
  await landing()
  await callersShareIt()
  await attaching()
  await reading()
  await everyPair()
  console.log(`moves ok: ${process.env.PAIRS === "0" ? "the rest, without the pairs" : `${TARGETS.length} pairs, each from idle, stopped and out of usage`}`)
} finally {
  rmSync(root, { recursive: true, force: true })
}
