import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PROTOCOL_VERSION, problem, serveRuntime, type Actor, type ClientSession, type Json, type ServedRuntime } from "@mako/protocol"
import { createFakeGateway, type FakeGateway } from "@mako/protocol/fake-gateway"
import { unwatchedWork } from "@mako/host/base/event-loop"
import type { AccessTier } from "@mako/host/contracts/access"
import { ORCHESTRATION_VERSION, type AgentCaller, type AgentRefused, type AgentsNoticed, type AgentsNoticeInput, type AgentsPlaced, type AgentsPlaceInput, type ThreadParent } from "@mako/host/contracts/agents"
import type { AgentsReadResult, AgentsSendResult, AgentsStarted, AgentsStartResult, AgentsStopResult } from "@mako/host/contracts/agent-tools"
import { gatewayHostCalls, sendWithRepeats } from "@mako/host/contracts/gateway-host-calls"
import { RuntimeDisconnectedError } from "@mako/host/contracts/host-connection"
import { decodeRuntimeValue } from "@mako/host/contracts/runtime-value"
import { OUTBOX_JOB, type PlaceDevice, type PlaceLink } from "@mako/host/conversations/agent-places"
import { declareAgentMethods } from "@mako/host/conversations/agent-tools"
import { FROM_AGENTS } from "@mako/host/conversations/agent-wakes"
import { remoteKey } from "@mako/host/conversations/placed-checkouts"
import { serveHostThroughGateway } from "@mako/host/transport/gateway"
import { HostMethods } from "@mako/host/transport/methods"
import { AgentsWorld, type Script, type WorldOptions } from "./lib/agents-world.ts"
import { ReportedSessionSchema, type ListedSession } from "@mako/protocol/thread-listing"
import { listedFins } from "@mako/host/contracts/children"
import { listedApexOf, listedSummary } from "@mako/host/contracts/listed-conversations"
import { ThreadIdSchema } from "@mako/host/contracts/thread-identity"
import { conversationShown, sessionOrderIn } from "@mako/host/conversations/session-report"
import { acpStore } from "../src/state/acp-state.ts"
import { finOpening, threadChildren } from "../src/state/apex-fins.ts"
import { childStateOf } from "@mako/host/contracts/children"
import { listLive } from "../src/state/live-recovery.ts"

/**
 * Fins placed on another device (`npm run test:fins-placed`): two hosts, each a real Thread store, live conversations
 * and engine with scripted harnesses, reaching each other's host calls through the protocol's gateway as two device
 * runtimes of one account. An Apex on one starts a Fin with `place: device:<name>` on the other: the name resolved, the
 * place asked what it offers, the start settled by its op, the Fin's edge on its own device naming its Apex on the
 * other, and its result waking that Apex once through a notice. Then what can go wrong between two machines: the
 * Apex's device off while the Fin finishes, a host restarted with a notice unsent, a notice sent twice, one from a
 * stale owner, a place that is offline, too old, full, or names nobody, a project with no remote; and the Apex's
 * operations on its Fin routed to the Fin's device.
 */
const root = mkdtempSync(join(tmpdir(), "mako-fins-placed-"))
const REMOTE = "git@github.com:acme/app.git"

interface Device {
  id: string
  name: string
  world: AgentsWorld
  /** Its runtime joins the gateway: its host calls answer. */
  online(): Promise<void>
  /** Its runtime leaves, as a closed lid's does: calls to it find nobody. */
  offline(): void
  close(): Promise<void>
}

/** The account: its gateway and its devices, as each device's link lists them. */
interface Account {
  gateway: FakeGateway
  devices: Device[]
  /** Calls whose answer the network loses once, by channel: the device does what was asked, and its caller never hears. */
  lose: Set<string>
  /** Calls the network loses once on their way, by channel: the device never hears them, and its caller can't tell. */
  drop: Set<string>
  /** Calls held on their way once, by channel, until the promise settles; `held` names those waiting there. */
  delay: Map<string, Promise<void>>
  held: Set<string>
  /** Every call that left, with what it carried, as a replay would find it. */
  sent: { channel: string; args: readonly Json[] }[]
}

function linkOf(account: Account, self: string): PlaceLink {
  let session: Promise<ClientSession> | undefined
  const actor: Actor = { kind: "client", client: "desktop", deviceId: self }
  return {
    self: async () => self,
    devices: async (): Promise<PlaceDevice[]> => account.devices.map((device) => ({ id: device.id, name: device.name, platform: "macOS 26" })),
    call: async (target, channel, args) => {
      assert.equal(target.kind, "device")
      const runtime = `d-${target.kind === "device" ? target.device : ""}`
      session ??= account.gateway.connectClient(actor)
      const delayed = account.delay.get(channel)
      if (delayed) {
        account.delay.delete(channel)
        account.held.add(channel)
        await delayed
        account.held.delete(channel)
      }
      if (account.drop.delete(channel)) throw new RuntimeDisconnectedError(true)
      account.sent.push({ channel, args })
      const send = gatewayHostCalls(await session, { runtimeId: runtime, actor }).call(channel, args)
      const answer = decodeRuntimeValue(await sendWithRepeats(channel, send, { runtime }))
      if (account.lose.delete(channel)) throw new RuntimeDisconnectedError(true)
      return answer
    },
  }
}

async function device(account: Account, name: string, script: Script, options: Partial<WorldOptions> = {}): Promise<Device> {
  const id = randomUUID()
  const world = new AgentsWorld({
    root: join(root, `${name}-${id.slice(0, 8)}`),
    script,
    noRoomWatch: true,
    away: linkOf(account, id),
    remoteOf: async () => REMOTE,
    checkoutOf: async (remote) => (remoteKey(remote) === remoteKey(REMOTE) ? { folder: world.root } : { refused: "git clone failed (not found)" }),
    ...options,
  })
  // The host's own method table, with the schemas a real host checks each call's arguments by.
  const methods = new HostMethods({ fixtureDesk: false, route: async () => ({ handled: false }), presentHistory: (value) => value, breadcrumb: () => {}, declaring: async () => {}, work: unwatchedWork })
  declareAgentMethods(methods, () => world.agents)
  let served: ServedRuntime | undefined
  const made: Device = {
    id,
    name,
    world,
    online: async () => {
      served = await serveHostThroughGateway(await account.gateway.connectRuntime(), { runtimeId: `d-${id}`, build: "test", invoke: (channel, args, client, history, correlationId) => methods.invoke(channel, args, client, history, correlationId) })
    },
    offline: () => {
      served?.close()
      served = undefined
    },
    close: async () => {
      served?.close()
      await world.close()
    },
  }
  account.devices.push(made)
  await made.online()
  return made
}

function account(): Account {
  return { gateway: createFakeGateway(), devices: [], lose: new Set(), drop: new Set(), delay: new Map(), held: new Set(), sent: [] }
}

function started(answer: AgentsStartResult): AgentsStarted {
  assert.ok(!("refused" in answer), JSON.stringify(answer))
  return answer
}

function refused(answer: AgentsStartResult | AgentsNoticed | AgentsPlaced): AgentRefused {
  assert.ok("refused" in answer, JSON.stringify(answer))
  return answer
}

async function until(what: string, done: () => boolean, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

const isBrief = (text: string) => text.includes("You're fin:")
const spoken = (text: string) => text.replace(/^<mako-local-control>[\s\S]*?<\/mako-local-control>\n\n/, "")
const wakesOf = (apex: Device, conversation: string) => apex.world.prompts.filter((prompt) => prompt.conversation === conversation && spoken(prompt.text).startsWith(FROM_AGENTS)).map((prompt) => ({ ...prompt, text: spoken(prompt.text) }))
const placedEdge = (apex: Device, child: string | undefined): ThreadParent => {
  const edge = child ? apex.world.store.edges().of(child) : undefined
  assert.ok(edge?.placed, "the Apex's device keeps where it placed the Fin")
  return edge
}
const conversationOf = (on: Device, child: string) => on.world.store.conversationsOf(on.world.store.thread(on.world.store.edges().of(child)!.child)!.sessions[0]!).at(-1)!
/** The Fins a device runs that are at work on it now. */
const atWorkOn = (on: Device) => on.world.store.edges().all.filter((edge) => !edge.placed && on.world.live.atWork(conversationOf(on, edge.child))).length
const stateOn = (apex: Device, conversation: string, name: string) => apex.world.agents.roster(conversation).find((entry) => entry.child?.name === name)?.child?.state?.kind
const undelivered = (on: Device) => on.world.store.undeliveredReports().filter(({ report }) => report.status !== "progress").length

/** An Apex on one device starts a Fin on another: it runs there, and its result wakes the Apex here, once. */
async function startsOnAnotherDevice(): Promise<void> {
  const cloud = account()
  const mac = await device(cloud, "MacBook", () => "Noted.")
  const studio = await device(cloud, "Studio", (turn) => (isBrief(turn.text) ? "The sidebar's rows overlap at 320 px. I fixed the grid." : "ok"))
  try {
    assert.deepEqual(studio.world.agents.capabilities().orchestration, { version: ORCHESTRATION_VERSION }, "a place says which placement it speaks")
    const offers = studio.world.agents.capabilities()
    assert.ok(offers.slots.of > 0 && offers.slots.used === 0 && offers.harnesses.includes("claude"), "and its slots, none used, and harnesses")

    const apex = await mac.world.apex("codex", "full")
    const began = Date.now()
    const answer = started(await mac.world.agents.start(apex.caller, { brief: { objective: "Fix the sidebar's rows." }, harness: "claude", name: "sidebar", place: "device:studio", clientKey: "k1", cwd: mac.world.root }))
    assert.equal(answer.place, "device:Studio", "a name is taken whatever its case, and kept as the device's own")
    assert.equal(answer.name, "sidebar")
    assert.equal(answer.conversation, undefined, "its conversation isn't on the Apex's device")

    const there = studio.world.store.edges().of(answer.child!)
    assert.ok(there, "the Fin's device wrote its edge")
    assert.deepEqual(there.remote, { device: mac.id, conversation: apex.conversation, access: "auto" }, "naming its Apex on the other device, at this device's ceiling for Fins started elsewhere")
    assert.equal(there.parent, mac.world.store.journalPlacement(apex.conversation)?.thread)
    assert.equal(there.op, `start:${apex.caller.kind === "agent" ? apex.caller.session : ""}:k1`, "under the Apex's own op")
    assert.equal(there.asked.access, "auto", "a full-access Apex's Fin is capped by the device it runs on")
    assert.equal(there.placed, undefined)
    const here = placedEdge(mac, answer.child)
    assert.deepEqual(here.placed?.target, { kind: "device", device: studio.id, name: "Studio" })
    assert.equal(here.asked.place, "device:Studio")
    assert.equal(here.asked.access, "auto", "and the Apex's record says what it runs at")
    assert.match(answer.note ?? "", /runs on auto here/, "with why, in the start's answer")
    assert.equal(mac.world.store.thread(here.child)?.sessions.length, 0, "the Fin's Thread has no Session on the Apex's device")

    await until("the Fin's turn on Studio", () => studio.world.prompts.some((prompt) => isBrief(prompt.text)))
    const brief = studio.world.prompts.find((prompt) => isBrief(prompt.text))!
    assert.ok(brief.text.startsWith("[mako · from your Apex (agent), not the person]"), "its brief is its Apex's words, there")
    assert.equal(mac.world.prompts.filter((prompt) => isBrief(prompt.text)).length, 0, "and nothing of it ran on the Apex's device")

    await until("the Apex's wake", () => wakesOf(mac, apex.conversation).length > 0)
    const wokenMs = Date.now() - began
    await mac.world.settle()
    await studio.world.settle()
    const wakes = wakesOf(mac, apex.conversation)
    assert.equal(wakes.length, 1, "the Fin's result wakes its Apex once")
    assert.ok(wokenMs < 5_000, `a Fin that finishes at once is heard at once, not by a retry (${wokenMs} ms)`)
    assert.match(wakes[0]!.text, /1 finished:/)
    assert.match(wakes[0]!.text, /"sidebar" \(Claude\) done: The sidebar's rows overlap at 320 px\./, "as a local Fin's does, in the same digest")
    assert.equal(mac.world.live.snapshot(apex.conversation)?.requests.at(-1)?.digest?.notices.length, 1, "through the Apex's own queue")
    assert.equal(undelivered(studio), 0, "the Fin's device's outbox is empty once the Apex's device took the notice")
    assert.equal(mac.world.store.reportsOf(here.child).length, 1, "and the Apex's device keeps the report")
    assert.equal(mac.world.agents.roster(apex.conversation).length, 1, "the Fin is in its Apex's roster")
    assert.equal(mac.world.agents.roster(apex.conversation)[0]?.state.kind, "completed")

    // The same key again: the same Fin, from the Apex's record, with no second start anywhere.
    const again = started(await mac.world.agents.start(apex.caller, { brief: { objective: "Fix the sidebar's rows." }, harness: "claude", name: "sidebar", place: "device:Studio", clientKey: "k1", cwd: mac.world.root }))
    assert.ok(again.deduped && again.child === answer.child)
    // And the place itself, asked again under the op (an answer the network lost): the Fin it started, never another.
    const op = there.op
    const placedAgain = await studio.world.agents.place({ version: ORCHESTRATION_VERSION, op, clientKey: "k1", parent: { device: mac.id, thread: there.parent, session: there.parentSession, access: "full" }, brief: { objective: "Fix the sidebar's rows." }, name: "sidebar", harness: "claude", access: "full", workspace: { remote: REMOTE } })
    assert.ok(!("refused" in placedAgain) && placedAgain.deduped && placedAgain.child === answer.child, "a repeat of the op answers the same Fin")
    assert.equal(studio.world.store.edges().all.length, 1)
    assert.equal(studio.world.prompts.filter((prompt) => isBrief(prompt.text)).length, 1, "its brief was sent once")
    // Where it runs it's a Thread of its own, since its Apex's Thread isn't there: that row is where the person reads
    // it and answers what it asks them, on that device, on the web or from another device.
    const where = studio.world.live.summaries().find((summary) => summary.threadId === answer.child)
    assert.ok(where, "its conversation is live on Studio")
    assert.equal(where.parent, undefined, "a Fin whose Apex is elsewhere is listed as a Thread where it runs")
    console.log(`placed start: a Fin on Studio for an Apex on MacBook, its result heard there in ${wokenMs} ms, once; a repeat of its key and of its op answer the same Fin`)
  } finally {
    await mac.close()
    await studio.close()
  }
}

/** The Apex's operations on a Fin it placed go to the Fin's device. */
async function operationsAreRouted(): Promise<void> {
  const cloud = account()
  const mac = await device(cloud, "MacBook", () => "Noted.")
  let asks = 0
  const studio = await device(cloud, "Studio", async (turn) => {
    if (turn.text.includes("Which grid")) return "Using the eight-column grid."
    if (isBrief(turn.text) && turn.text.includes("Ask first")) {
      asks += 1
      const told = await turn.world.agents.report(turn.caller, { status: "needs-input", summary: "Two grids fit.", question: "Which grid, eight or twelve columns?", options: [{ label: "Eight" }, { label: "Twelve" }], clientKey: "q1" })
      assert.ok(!("refused" in told), JSON.stringify(told))
      return "I asked my Apex."
    }
    if (turn.text.includes("Also check the README")) return "The README is right."
    if (isBrief(turn.text) && turn.text.includes("Hold")) {
      await turn.world.hold(turn.conversation)
      return "Held work done."
    }
    return "Reviewed the header: nothing to change."
  })
  try {
    const apex = await mac.world.apex("codex", "auto")
    const header = started(await mac.world.agents.start(apex.caller, { brief: { objective: "Review the header." }, harness: "grok", name: "header", place: "device:Studio", clientKey: "h", cwd: mac.world.root }))
    await until("the header Fin's wake", () => wakesOf(mac, apex.conversation).length === 1)
    await mac.world.settle()

    const listed = await mac.world.agents.list(apex.caller, {})
    assert.ok("tree" in listed, JSON.stringify(listed))
    const strip = listed.children.find((each) => each.child === header.child)
    assert.equal(strip?.place, "device:Studio", "a placed Fin's strip says where it runs")
    assert.equal(strip?.state.kind, "ended")
    assert.equal(strip?.harness, "grok", "as its own device reads it")
    assert.ok(strip?.title !== undefined || strip?.report !== undefined)

    const read: AgentsReadResult = await mac.world.agents.read(apex.caller, { child: "header" })
    assert.ok("text" in read && /Reviewed the header: nothing to change\./.test(read.text), "its report is read from its device")

    // A message to it: delivered there under the same key, once, as its Apex's words; its result wakes the Apex again.
    const sent: AgentsSendResult = await mac.world.agents.send(apex.caller, { to: "header", text: "Also check the README's install steps.", clientKey: "s1" })
    assert.ok(!("refused" in sent) && sent.delivery === "turn", JSON.stringify(sent))
    const resent = await mac.world.agents.send(apex.caller, { to: "header", text: "Also check the README's install steps.", clientKey: "s1" })
    assert.ok(!("refused" in resent) && resent.deduped)
    await until("the header Fin's second wake", () => wakesOf(mac, apex.conversation).length === 2)
    await studio.world.settle()
    const followUps = studio.world.prompts.filter((prompt) => prompt.text.includes("Also check the README"))
    assert.equal(followUps.length, 1, "the message reached the Fin once")
    assert.ok(followUps[0]!.text.startsWith("[mako · from your Apex (agent), not the person]"))
    assert.match(wakesOf(mac, apex.conversation)[1]!.text, /The README is right\./)

    // A question: the Fin asks on its device, its Apex hears it here and answers it there.
    const asker = started(await mac.world.agents.start(apex.caller, { brief: { objective: "Lay out the footer. Ask first which grid." }, harness: "claude", name: "footer", place: "device:Studio", clientKey: "f", cwd: mac.world.root }))
    await until("the question's wake", () => wakesOf(mac, apex.conversation).some((wake) => /Which grid, eight or twelve columns\?/.test(wake.text)))
    await mac.world.settle()
    assert.equal(asks, 1)
    assert.equal(mac.world.agents.roster(apex.conversation).find((entry) => entry.child?.thread === asker.child)?.child?.state?.kind, "blocked", "it reads as blocked on its Apex, here")
    const answered = await mac.world.agents.answer(apex.caller, { to: "footer", answer: "Eight", clientKey: "a1" })
    assert.ok(!("refused" in answered) && answered.answered === "report", JSON.stringify(answered))
    await until("the answer on Studio", () => studio.world.prompts.some((prompt) => prompt.text.includes("Answer: Eight")))
    await until("the footer Fin's result", () => wakesOf(mac, apex.conversation).some((wake) => /Using the eight-column grid\./.test(wake.text)))

    // A move: its device moves it through its own continueOn.
    await studio.world.settle()
    const moved = await mac.world.agents.move(apex.caller, { child: "footer", harness: "opencode", clientKey: "m1" })
    assert.ok("moved" in moved && moved.moved[0]?.harness === "opencode", JSON.stringify(moved))
    assert.ok(studio.world.continued.some((move) => move.to === "opencode" && move.kind === "move"), "a move of a placed Fin runs on its device")
    assert.equal(mac.world.continued.length, 0)
    assert.equal(mac.world.store.edges().of(asker.child!)?.asked.harness, "opencode", "and the Apex's record of it follows")

    // A stop: its turn stops there, and the delegation closes on both.
    const held = started(await mac.world.agents.start(apex.caller, { brief: { objective: "Hold this work." }, harness: "claude", name: "held", place: "device:Studio", clientKey: "x", cwd: mac.world.root }))
    await until("the held Fin's turn", () => studio.world.prompts.some((prompt) => prompt.text.includes("Hold this work")))
    assert.equal(mac.world.agents.roster(apex.conversation).find((entry) => entry.child?.thread === held.child)?.state.kind, "working")
    const stopped: AgentsStopResult = await mac.world.agents.stop(apex.caller, { child: "held", reason: "not needed" })
    assert.deepEqual(stopped, { stopped: ["held"] })
    assert.ok(studio.world.store.edges().of(held.child!)?.closedAt, "stopped on its own device")
    assert.equal(mac.world.store.edges().of(held.child!)?.closedReason, "not needed", "and on its Apex's")
    await studio.world.settle()
    const before = wakesOf(mac, apex.conversation).length
    await mac.world.settle()
    assert.equal(wakesOf(mac, apex.conversation).length, before, "a stopped Fin's cut turn wakes nobody")
    console.log("placed operations: list, read, send, answer, move and stop of a Fin on another device each ran on that device, settled by the Apex's own keys")
  } finally {
    await mac.close()
    await studio.close()
  }
}

/** Exact question IDs never cross to a receiver whose support for that selection is unknown. */
async function retainedQuestionCapability(): Promise<void> {
  const cloud = account()
  const mac = await device(cloud, "MacBook", () => "Noted.")
  const studio = await device(cloud, "Studio", () => "ok")
  try {
    const apex = await mac.world.apex("codex", "full")
    const fin = started(await mac.world.agents.start(apex.caller, { brief: { objective: "Prepare a review." }, harness: "claude", name: "review", place: "device:Studio", clientKey: "review", cwd: mac.world.root }))
    await until("the placed Fin's first report", () => mac.world.store.reportsOf(fin.child!).length > 0)
    await studio.world.settle()
    const conversation = conversationOf(studio, fin.child!)
    const caller = studio.world.caller(conversation)
    const report = await studio.world.agents.report(caller, { status: "done", summary: "Review ready.", question: "Route this review?", clientKey: "ready" })
    assert.ok(!("refused" in report), JSON.stringify(report))
    await until("the retained question on the Apex's device", () => mac.world.store.openReportAsks(fin.child!).some((ask) => ask.id === report.id))
    const calls = () => cloud.sent.filter((call) => ["mako:agents-read", "mako:agents-answer", "mako:agents-respond", "mako:agents-send"].includes(call.channel)).length
    let before = calls()
    const exact = await mac.world.agents.read(apex.caller, { child: fin.name, report: report.id })
    assert.ok("refused" in exact && exact.refused === "unsupported")
    const page = await mac.world.agents.read(apex.caller, { child: fin.name, afterAsk: report.id })
    assert.ok("refused" in page && page.refused === "unsupported")
    const answer = await mac.world.agents.answer(apex.caller, { to: fin.name, ask: report.id, answer: "Review", clientKey: "exact" })
    assert.ok("refused" in answer && answer.refused === "unsupported")
    const person = await mac.world.agents.respond(apex.conversation, { fin: fin.child!, ask: report.id, answer: "Review", request: randomUUID() })
    assert.ok("refused" in person && person.refused === "unsupported", "person responses cannot bypass the unknown receiver capability")
    assert.equal(calls(), before, "no exact request was silently downgraded and sent to the receiver")
    assert.equal(studio.world.store.answerOf(report.id), undefined)
    assert.equal(mac.world.store.answerOf(report.id), undefined)
    const second = await studio.world.agents.report(caller, { status: "done", summary: "Another review ready.", question: "Route the second review?", clientKey: "second" })
    assert.ok(!("refused" in second), JSON.stringify(second))
    await until("both placed questions", () => mac.world.store.openReportAsks(fin.child!).length === 2)
    before = calls()
    const ambiguous = await mac.world.agents.answer(apex.caller, { to: fin.name, answer: "Review", clientKey: "ambiguous" })
    assert.ok("refused" in ambiguous && ambiguous.refused === "unsupported")
    assert.equal(calls(), before)
    const ordinary = await mac.world.agents.read(apex.caller, { child: fin.name })
    assert.ok("text" in ordinary && ordinary.pending?.asks.length === 2, "ordinary reads still reach a modern receiver")
    console.log("placed questions: unknown exact-selection capability refuses reads, paging and both answer paths without a receiver call")
  } finally { await mac.close(); await studio.close() }
}

/** The Apex's device is off while its Fin finishes: the notice waits on the Fin's device and is taken once when it's back. */
async function apexOfflineThenBack(): Promise<void> {
  const cloud = account()
  const mac = await device(cloud, "MacBook", () => "Noted.")
  const studio = await device(cloud, "Studio", async (turn) => {
    if (!isBrief(turn.text)) return "ok"
    await turn.world.hold(turn.conversation)
    return "Migrated the schema. 14 tables moved."
  })
  try {
    const apex = await mac.world.apex("claude")
    const fin = started(await mac.world.agents.start(apex.caller, { brief: { objective: "Migrate the schema." }, harness: "codex", name: "migrate", place: "device:Studio", clientKey: "m", cwd: mac.world.root }))
    await until("the Fin's turn", () => studio.world.prompts.some((prompt) => isBrief(prompt.text)))
    const finConversation = studio.world.store.conversationsOf(studio.world.store.thread(placedEdge(mac, fin.child).child)!.sessions[0]!).at(-1)!

    mac.offline()
    studio.world.release(finConversation)
    await until("the report on Studio", () => studio.world.store.reportsOf(fin.child!).length === 1)
    await studio.world.settle(600, 20_000, "ignore")
    assert.equal(undelivered(studio), 1, "the notice stays in the Fin's device's outbox while the Apex's device is off")
    assert.equal(studio.world.agents.diagnostics().notices >= 0, true)
    assert.equal(wakesOf(mac, apex.conversation).length, 0)
    assert.equal(mac.world.store.reportsOf(fin.child!).length, 0)

    // The Fin's host restarts with the notice unsent: it's still there, and still unsent.
    await studio.world.restart()
    await new Promise((resolve) => setTimeout(resolve, 200))
    assert.equal(undelivered(studio), 1, "the outbox is the store's: a restart keeps it")

    // Back: the Apex's device asks its places how its Fins stand, which tells them it hears again.
    const back = Date.now()
    await mac.online()
    mac.world.agents.knock()
    await until("the Apex's wake after it's back", () => wakesOf(mac, apex.conversation).length > 0)
    const ms = Date.now() - back
    await mac.world.settle()
    assert.equal(wakesOf(mac, apex.conversation).length, 1, "the notice is taken once")
    assert.match(wakesOf(mac, apex.conversation)[0]!.text, /Migrated the schema\./)
    await until("the outbox to empty", () => undelivered(studio) === 0)

    // Without any word from the Apex's device, the outbox tries again by itself.
    const second = started(await mac.world.agents.start(apex.caller, { brief: { objective: "Migrate the indexes." }, harness: "codex", name: "indexes", place: "device:Studio", clientKey: "i", cwd: mac.world.root }))
    await until("the second Fin's turn", () => studio.world.prompts.filter((prompt) => isBrief(prompt.text)).length === 2)
    mac.offline()
    studio.world.release(studio.world.store.conversationsOf(studio.world.store.thread(placedEdge(mac, second.child).child)!.sessions[0]!).at(-1)!)
    await until("the second report on Studio", () => studio.world.store.reportsOf(second.child!).length === 1)
    await mac.online()
    await until("the outbox's own retry", () => wakesOf(mac, apex.conversation).length === 2, 30_000)
    assert.ok(studio.world.jobs.list().some((job) => job.name === OUTBOX_JOB), "on a job that runs only while a notice waits")
    await mac.world.settle()
    assert.equal(wakesOf(mac, apex.conversation).length, 2)
    console.log(`offline Apex: a notice waited on the Fin's device through that host's restart and was taken once ${ms} ms after the Apex's device was back; another went by the outbox's own retry`)
  } finally {
    await mac.close()
    await studio.close()
  }
}

/** A notice sent twice is heard once; one from an owner older than the newest heard is refused. */
async function dedupeAndStaleOwners(): Promise<void> {
  const cloud = account()
  const mac = await device(cloud, "MacBook", () => "Noted.")
  const studio = await device(cloud, "Studio", (turn) => (isBrief(turn.text) ? "Done with the audit." : "ok"))
  try {
    const apex = await mac.world.apex("claude")
    const fin = started(await mac.world.agents.start(apex.caller, { brief: { objective: "Audit the logs." }, harness: "devin", name: "audit", place: "device:Studio", clientKey: "a", cwd: mac.world.root }))
    await until("the Apex's wake", () => wakesOf(mac, apex.conversation).length === 1)
    await mac.world.settle()
    const edge = studio.world.store.edges().of(fin.child!)!
    const report = studio.world.store.reportsOf(fin.child!)[0]!
    const notice: AgentsNoticeInput = { id: `notice:${edge.child}:${report.id}`, op: edge.op, parent: { thread: edge.parent, session: edge.parentSession }, child: edge.child, report }
    assert.deepEqual(await mac.world.agents.notice(notice), { heard: true, deduped: true }, "the same notice again is the same notice")
    assert.deepEqual(await mac.world.agents.notice(notice), { heard: true, deduped: true })
    await mac.world.settle()
    assert.equal(wakesOf(mac, apex.conversation).length, 1, "and wakes nobody a second time")
    assert.equal(mac.world.store.reportsOf(fin.child!).length, 1)

    const stale = { ...report, id: `report:${edge.child}:late`, summary: "A report from before the Thread changed hands.", ownerGeneration: report.ownerGeneration - 1, at: report.at + 1 }
    const refusedStale = refused(await mac.world.agents.notice({ ...notice, id: `notice:${edge.child}:${stale.id}`, report: stale }))
    assert.equal(refusedStale.refused, "stale-owner", "a report from an older owner is refused")
    await mac.world.settle()
    assert.equal(wakesOf(mac, apex.conversation).length, 1)
    assert.equal(mac.world.store.reportsOf(fin.child!).length, 1, "and never kept")

    assert.equal(refused(await mac.world.agents.notice({ ...notice, id: "notice:other" })).refused, "conflict", "a notice names its own child and report")
    assert.equal(refused(await mac.world.agents.notice({ ...notice, parent: { ...notice.parent, thread: randomUUID() } })).refused, "unknown-child", "and a Fin this device placed under that Apex")
    assert.equal(refused(await studio.world.agents.notice(notice)).refused, "unknown-child", "a device that didn't place the Fin takes no notice of it")
    console.log("notices: one sent again is deduped by its report's ID, one from a stale owner generation is refused, and neither wakes the Apex again")
  } finally {
    await mac.close()
    await studio.close()
  }
}

/** A place that can't take a Fin says why, before anything is started. */
async function refusals(): Promise<void> {
  const cloud = account()
  const mac = await device(cloud, "MacBook", () => "Noted.")
  const studio = await device(cloud, "Studio", () => "Done.")
  const twin = await device(cloud, "studio", () => "Done.")
  try {
    const apex = await mac.world.apex("codex", "ask")
    const ask = (place: string, more: Partial<Parameters<AgentsWorld["agents"]["start"]>[1]> = {}) =>
      mac.world.agents.start(apex.caller, { brief: { objective: "Look at the logs." }, harness: "claude", place, clientKey: randomUUID(), cwd: mac.world.root, ...more })

    const ambiguous = refused(await ask("device:Studio"))
    assert.equal(ambiguous.refused, "place-unavailable")
    assert.match(ambiguous.why, /2 devices of this account are named Studio \(Studio, macOS 26; studio, macOS 26\)/, "an ambiguous name is refused, listing them")
    await twin.close()
    cloud.devices.splice(cloud.devices.indexOf(twin), 1)

    const nobody = refused(await ask("device:Attic"))
    assert.match(nobody.why, /No device of this account is named Attic\. Its other devices: Studio\./, "an unknown name lists the devices there are")

    const here = started(await ask("device:macbook"))
    assert.ok(here.conversation && here.place === undefined, "this device's own name is here")
    await mac.world.settle()

    assert.equal(refused(await ask("device:Studio", { access: "full" })).refused, "access", "a Fin never runs above its Apex, wherever it runs")
    assert.match(refused(await ask("device:Studio", { harness: "aider" })).why, /Studio runs no harness named aider: it has claude, codex/)
    assert.match(refused(await ask("device:Studio", { context: [{ thread: randomUUID() }] })).why, /can't be attached to a Fin on another device yet/)
    assert.equal(refused(await ask("cloud")).refused, "place-unavailable")

    studio.offline()
    const off = refused(await ask("device:Studio"))
    assert.equal(off.refused, "place-unavailable")
    assert.match(off.why, /Studio isn't online/, "an offline device is refused with why")
    await studio.online()

    // A device whose Mako is from before placement: it has no such call.
    const old = randomUUID()
    cloud.devices.push({ id: old, name: "Loft", world: studio.world, online: async () => {}, offline: () => {}, close: async () => {} })
    const loft = await serveRuntime(await cloud.gateway.connectRuntime(), {
      runtimeId: `d-${old}`,
      build: "old",
      handle: async (operation) => ({ v: PROTOCOL_VERSION, id: operation.id, ok: false, problem: problem("not-found", "This host has no such call", operation.correlationId, "not-applied", { status: 404, detail: operation.op }) }),
    })
    const tooOld = refused(await ask("device:Loft"))
    assert.equal(tooOld.refused, "unsupported", "a device too old for placement answers unsupported")
    assert.match(tooOld.why, /Update Mako there/)
    loft.close()
    assert.equal(studio.world.store.edges().all.length, 0, "and nothing was started anywhere")

    // A project with no Git remote has nothing for another device to check out.
    const bare = await device(cloud, "Shed", () => "Noted.", { remoteOf: async () => undefined })
    try {
      const shedApex = await bare.world.apex("codex")
      const noRemote = refused(await bare.world.agents.start(shedApex.caller, { brief: { objective: "Look." }, harness: "claude", place: "device:Studio", clientKey: "n", cwd: bare.world.root }))
      assert.equal(noRemote.refused, "place-unavailable")
      assert.match(noRemote.why, /has none \(no origin\)\. Push the project to a remote/, "a project with no remote is refused with why")
    } finally {
      await bare.close()
    }

    // A device that can't get the project (its clone fails) says so, and starts nothing.
    const other = await device(cloud, "Barn", () => "Noted.", { remoteOf: async () => "git@github.com:acme/private.git" })
    try {
      const barnApex = await other.world.apex("codex")
      const noClone = refused(await other.world.agents.start(barnApex.caller, { brief: { objective: "Look." }, harness: "claude", place: "device:Studio", clientKey: "c", cwd: other.world.root }))
      assert.match(noClone.why, /This device has no checkout of git@github\.com:acme\/private\.git and couldn't make one: git clone failed/)
    } finally {
      await other.close()
    }
    assert.equal(studio.world.store.edges().all.length, 0)
    console.log("refusals: an ambiguous, unknown, offline or too-old device, an access above the Apex's, a harness the device lacks, a project with no remote and a clone that fails each say why, and start nothing")
  } finally {
    await mac.close()
    await studio.close()
  }
}

/** A device at its limit takes no more: a start is refused with its count, or with `queue` waits here and goes when it has room. */
async function fullPlaceQueues(): Promise<void> {
  const cloud = account()
  const mac = await device(cloud, "MacBook", () => "Noted.")
  const studio = await device(cloud, "Studio", async (turn) => {
    if (!isBrief(turn.text)) return "ok"
    if (turn.text.includes("first")) await turn.world.hold(turn.conversation)
    return "Done."
  }, { finLimit: () => 1 })
  try {
    const apex = await mac.world.apex("claude")
    const first = started(await mac.world.agents.start(apex.caller, { brief: { objective: "The first job." }, harness: "codex", name: "first", place: "device:Studio", clientKey: "1", cwd: mac.world.root }))
    await until("the first Fin's turn", () => studio.world.prompts.some((prompt) => isBrief(prompt.text)))
    assert.deepEqual(studio.world.agents.capabilities().slots, { used: 1, of: 1 }, "a device says when it's full")
    const full = refused(await mac.world.agents.start(apex.caller, { brief: { objective: "The second job." }, harness: "codex", name: "second", place: "device:Studio", clientKey: "2", cwd: mac.world.root }))
    assert.equal(full.refused, "budget")
    assert.match(full.why, /The 1 Fins Studio runs at once are at work\..*Pass queue: true to start it when Studio has room/, "a full device refuses with its count")
    const queued = started(await mac.world.agents.start(apex.caller, { brief: { objective: "The second job." }, harness: "codex", name: "second", place: "device:Studio", queue: true, clientKey: "2", cwd: mac.world.root }))
    assert.equal(queued.state, "queued")
    assert.equal(studio.world.store.edges().all.length, 1, "what waits for a device waits on its Apex's, and nothing of it is there yet")

    studio.world.release(studio.world.store.conversationsOf(studio.world.store.thread(placedEdge(mac, first.child).child)!.sessions[0]!).at(-1)!)
    await until("the second Fin on Studio", () => studio.world.store.edges().all.length === 2)
    await until("both results", () => wakesOf(mac, apex.conversation).reduce((count, wake) => count + (wake.text.match(/done:/g)?.length ?? 0), 0) === 2)
    await mac.world.settle()
    assert.equal(mac.world.store.queuedSpawns().length, 0)
    console.log("capacity: a device at its limit refuses a start with its count; one that asked to queue waited on its Apex's device and started when the first Fin's notice came")
  } finally {
    await mac.close()
    await studio.close()
  }
}

/** A Fin's access is at most its Apex's and at most what its device allows Fins started from elsewhere. */
async function accessIsCapped(): Promise<void> {
  const cloud = account()
  const mac = await device(cloud, "MacBook", () => "Noted.")
  let ceiling: AccessTier = "full"
  const studio = await device(cloud, "Studio", () => "Done.", { placedCeiling: () => ceiling })
  try {
    const apex = await mac.world.apex("claude", "full")
    const full = started(await mac.world.agents.start(apex.caller, { brief: { objective: "Ship it." }, harness: "claude", name: "ship", place: "device:Studio", clientKey: "f", cwd: mac.world.root }))
    assert.equal(studio.world.store.edges().of(full.child!)?.asked.access, "full", "a device whose ceiling is full runs a full-access Apex's Fin at full")
    assert.equal(full.note, undefined)
    ceiling = "edits"
    const capped = started(await mac.world.agents.start(apex.caller, { brief: { objective: "Ship it again." }, harness: "claude", name: "again", place: "device:Studio", clientKey: "g", cwd: mac.world.root }))
    assert.equal(studio.world.store.edges().of(capped.child!)?.asked.access, "edits", "and one whose ceiling is edits holds it to edits")
    const asked = started(await mac.world.agents.start(apex.caller, { brief: { objective: "Read it." }, harness: "claude", name: "read", access: "plan", place: "device:Studio", clientKey: "p", cwd: mac.world.root }))
    assert.equal(studio.world.store.edges().of(asked.child!)?.asked.access, "plan", "a tier below both is the one asked")
    await studio.world.settle()
    await mac.world.settle()
    console.log("access: a placed Fin runs at the least of what was asked, its Apex's tier and its device's ceiling")
  } finally {
    await mac.close()
    await studio.close()
  }
}

/**
 * A start is recorded on its Apex's device before it's sent, so one whose answer is lost, or whose host dies with the
 * call under way, is never a Fin running somewhere with nobody's record of it: asked again under its op, it's found.
 */
async function lostAnswerIsFoundAgain(): Promise<void> {
  const cloud = account()
  const mac = await device(cloud, "MacBook", () => "Noted.")
  const studio = await device(cloud, "Studio", async (turn) => {
    if (!isBrief(turn.text)) return "ok"
    await turn.world.hold(turn.conversation)
    return "Indexed 40 files."
  })
  try {
    const apex = await mac.world.apex("claude")
    cloud.lose.add("mako:agents-place")
    const answer = started(await mac.world.agents.start(apex.caller, { brief: { objective: "Index the files." }, harness: "codex", name: "index", place: "device:Studio", clientKey: "x", cwd: mac.world.root }))
    assert.equal(answer.state, "queued", "a start whose answer never came isn't called started, nor refused")
    assert.match(answer.why ?? "", /Studio didn't answer, so whether it started there isn't known/)
    assert.equal(studio.world.store.edges().all.length, 1, "the Fin did start there")
    assert.equal(mac.world.store.edges().all.length, 0)
    const kept = mac.world.store.queuedSpawns()
    assert.ok(kept.length === 1 && kept[0]?.away, "and its Apex's device still holds the start it sent")
    assert.equal(mac.world.agents.roster(apex.conversation)[0]?.state.kind, "waiting", "which shows in the Apex's Thread")

    // The Apex's host dies and comes back: the start is still there, in its store.
    await mac.world.restart()
    assert.equal(mac.world.store.queuedSpawns().length, 1)

    // The Fin reports: its device's notice is the first word of it here, and its start, asked again, answers that Fin.
    const child = studio.world.store.edges().all[0]!.child
    studio.world.release(studio.world.store.conversationsOf(studio.world.store.thread(child)!.sessions[0]!).at(-1)!)
    await until("the Apex's wake", () => wakesOf(mac, apex.conversation).length === 1)
    await mac.world.settle()
    assert.equal(placedEdge(mac, child).name, "index", "the Apex's device has its record of the Fin")
    assert.equal(mac.world.store.queuedSpawns().length, 0)
    assert.equal(studio.world.store.edges().all.length, 1, "and no second Fin was started")
    assert.equal(studio.world.prompts.filter((prompt) => isBrief(prompt.text)).length, 1)
    assert.match(wakesOf(mac, apex.conversation)[0]!.text, /Indexed 40 files\./)
    assert.equal(undelivered(studio), 0)
    console.log("lost answer: a start recorded before it was sent survived its lost answer and its host's restart, and was found again under its op")
  } finally {
    await mac.close()
    await studio.close()
  }
}

/** A `wait` start holds for a placed Fin's result as for a local one's, and a result it answered wakes nobody after. */
async function waitsForAPlacedResult(): Promise<void> {
  const cloud = account()
  const mac = await device(cloud, "MacBook", () => "Noted.")
  const studio = await device(cloud, "Studio", (turn) => (isBrief(turn.text) ? "There are 14 migrations." : "ok"))
  try {
    const apex = await mac.world.apex("claude")
    const answer = started(await mac.world.agents.start(apex.caller, { brief: { objective: "Count the migrations." }, harness: "codex", name: "count", place: "device:Studio", mode: "wait", clientKey: "w", cwd: mac.world.root }))
    assert.ok(answer.waited?.outcome === "result", JSON.stringify(answer.waited))
    assert.equal(answer.waited.report.summary, "There are 14 migrations.", "the result comes in the start's own answer, from the other device")
    await mac.world.settle()
    assert.equal(wakesOf(mac, apex.conversation).length, 0, "and wakes nobody after")
    assert.equal(undelivered(studio), 0)
    console.log("wait: a start that waits gets a placed Fin's result in its own answer")
  } finally {
    await mac.close()
    await studio.close()
  }
}

/** A Fin on Studio whose brief's turn holds until it's released or stopped. */
const holdsItsBrief: Script = async (turn) => {
  if (isBrief(turn.text)) await turn.world.hold(turn.conversation)
  return "Done."
}
const PROBE = { brief: { objective: "probe" }, name: "probe", harness: "codex", place: "device:Studio", clientKey: "probe" }

/**
 * Stop wins over a start whose answer was lost. The Fin did start on the other device: the Stop ends it there, by its
 * name and by `all`, and what the Apex's device keeps is the stopped Fin, through its own restart.
 */
async function stopEndsAStartWhoseAnswerWasLost(which: "probe" | "all"): Promise<void> {
  const cloud = account()
  const mac = await device(cloud, "MacBook", () => "Noted.")
  const studio = await device(cloud, "Studio", holdsItsBrief)
  try {
    const apex = await mac.world.apex("claude")
    cloud.lose.add("mako:agents-place")
    assert.equal(started(await mac.world.agents.start(apex.caller, { ...PROBE, cwd: mac.world.root })).state, "queued")
    await until("the Fin at work on Studio", () => atWorkOn(studio) === 1)
    assert.deepEqual(await mac.world.agents.stop(apex.caller, { child: which }), { stopped: ["probe"] })
    await until("the Fin stopped on Studio", () => atWorkOn(studio) === 0)
    assert.ok(studio.world.store.edges().all[0]?.closedAt !== undefined, "its delegation is closed where it ran")
    assert.equal(mac.world.store.queuedSpawns().length, 0, "the start's record went once Studio said how it ended")
    const kept = mac.world.store.edges().all[0]
    assert.ok(kept?.placed && kept.closedAt !== undefined, "and the Apex's device keeps the Fin, stopped")
    await mac.world.restart()
    assert.equal(atWorkOn(studio), 0, "nothing runs there after the Apex's host restarts")
    assert.equal(mac.world.store.queuedSpawns().length, 0)
    assert.equal(stateOn(mac, apex.conversation, "probe"), "ended")
    console.log(`stop, lost answer (${which}): the Fin that started on Studio was stopped there, and its Apex's device keeps it as stopped through a restart`)
  } finally {
    await mac.close()
    await studio.close()
  }
}

/**
 * The other device can't be reached when the Stop comes: the Stop isn't called done, it's kept with the start through
 * the Apex's restart, and it ends the Fin once that device answers.
 */
async function stopWaitsForAnUnreachableDevice(which: "probe" | "all"): Promise<void> {
  const cloud = account()
  const mac = await device(cloud, "MacBook", () => "Noted.")
  const studio = await device(cloud, "Studio", holdsItsBrief)
  try {
    const apex = await mac.world.apex("claude")
    cloud.lose.add("mako:agents-place")
    assert.equal(started(await mac.world.agents.start(apex.caller, { ...PROBE, cwd: mac.world.root })).state, "queued")
    await until("the Fin at work on Studio", () => atWorkOn(studio) === 1)
    studio.offline()
    const answer = await mac.world.agents.stop(apex.caller, { child: which })
    assert.ok(!("refused" in answer), JSON.stringify(answer))
    assert.deepEqual(answer.stopped, [], "a stop nobody confirmed isn't reported as stopped")
    assert.equal(answer.pending?.[0]?.name, "probe")
    assert.match(answer.pending?.[0]?.why ?? "", /Studio/)
    assert.equal(mac.world.store.queuedSpawns().length, 1, "the stop is kept with the start")
    assert.equal(atWorkOn(studio), 1)
    // The same start asked again starts nothing, and the Stop asked again is the same Stop.
    const again = await mac.world.agents.start(apex.caller, { ...PROBE, cwd: mac.world.root })
    assert.ok("refused" in again || again.state === "queued", JSON.stringify(again))
    const repeat = await mac.world.agents.stop(apex.caller, { child: which })
    assert.ok(!("refused" in repeat) && repeat.stopped.length === 0 && repeat.pending?.[0]?.name === "probe", JSON.stringify(repeat))
    await mac.world.restart()
    assert.equal(mac.world.store.queuedSpawns().length, 1, "through the Apex's restart")
    assert.equal(atWorkOn(studio), 1)
    await studio.online()
    // The Apex's device is told its link is back, as its runtime's link opening tells it.
    mac.world.agents.knock()
    await until("the Fin stopped on Studio", () => atWorkOn(studio) === 0)
    await until("the start's record retired", () => mac.world.store.queuedSpawns().length === 0)
    assert.ok(studio.world.store.edges().all[0]?.closedAt !== undefined)
    const kept = mac.world.store.edges().all[0]
    assert.ok(kept?.placed && kept.closedAt !== undefined, "the Apex's device keeps the Fin, stopped")
    assert.equal(studio.world.prompts.filter((prompt) => isBrief(prompt.text)).length, 1, "and it was never started again")
    console.log(`stop, device unreachable (${which}): the Stop said Studio couldn't be reached, was kept through a restart, and ended the Fin once Studio answered`)
  } finally {
    await mac.close()
    await studio.close()
  }
}

/**
 * A Fin its Apex's device has a record of, stopped while its device can't be reached: the same rule. Nothing says it
 * stopped, the stop is kept on its record through a restart, and it ends the Fin once its device answers.
 */
async function stopOfAPlacedFinWaitsForItsDevice(): Promise<void> {
  const cloud = account()
  const mac = await device(cloud, "MacBook", () => "Noted.")
  const studio = await device(cloud, "Studio", holdsItsBrief)
  try {
    const apex = await mac.world.apex("claude")
    const fin = started(await mac.world.agents.start(apex.caller, { ...PROBE, cwd: mac.world.root }))
    await until("the Fin at work on Studio", () => atWorkOn(studio) === 1)
    studio.offline()
    const answer = await mac.world.agents.stop(apex.caller, { child: "probe" })
    assert.ok(!("refused" in answer) && answer.stopped.length === 0 && answer.pending?.[0]?.name === "probe", JSON.stringify(answer))
    assert.ok(placedEdge(mac, fin.child).placed?.stop, "the stop is kept on the Apex's record of the Fin")
    assert.equal(placedEdge(mac, fin.child).closedAt, undefined, "and its delegation isn't closed on a guess")
    assert.equal(stateOn(mac, apex.conversation, "probe"), "working")
    await mac.world.restart()
    assert.ok(placedEdge(mac, fin.child).placed?.stop)
    await studio.online()
    mac.world.agents.knock()
    await until("the Fin stopped on Studio", () => atWorkOn(studio) === 0)
    await until("the stop settled", () => placedEdge(mac, fin.child).closedAt !== undefined)
    assert.equal(placedEdge(mac, fin.child).placed?.stop, undefined)
    assert.equal(stateOn(mac, apex.conversation, "probe"), "ended")
    console.log("stop, placed Fin unreachable: the Stop was kept on the Fin's record through a restart and ended it once Studio answered")
  } finally {
    await mac.close()
    await studio.close()
  }
}

/** The start as it reaches Studio late, after its Apex stopped it: the same call the Apex's device sent. */
function lateStart(mac: Device, apex: { conversation: string; caller: AgentCaller }): AgentsPlaceInput {
  assert.ok(apex.caller.kind === "agent")
  const thread = mac.world.store.journalPlacement(apex.conversation)?.thread
  assert.ok(thread)
  return { version: ORCHESTRATION_VERSION, op: `start:${apex.caller.session}:probe`, clientKey: "probe", parent: { device: mac.id, thread, session: apex.caller.session, conversation: apex.conversation, access: "auto" }, brief: PROBE.brief, name: "probe", harness: "codex", access: "auto", workspace: { remote: REMOTE } }
}

/**
 * The other order: the start hadn't reached Studio when its Apex stopped it. Lost on its way, or still on its way, a
 * start that arrives after the Stop is refused there and never runs.
 */
async function stopBeatsAStartStillOnItsWay(how: "lost" | "slow"): Promise<void> {
  const cloud = account()
  const mac = await device(cloud, "MacBook", () => "Noted.")
  const studio = await device(cloud, "Studio", holdsItsBrief)
  try {
    const apex = await mac.world.apex("claude")
    let arrive = () => {}
    if (how === "lost") cloud.drop.add("mako:agents-place")
    else cloud.delay.set("mako:agents-place", new Promise<void>((resolve) => { arrive = resolve }))
    const starting = mac.world.agents.start(apex.caller, { ...PROBE, cwd: mac.world.root })
    if (how === "lost") assert.equal(started(await starting).state, "queued")
    else await until("the start on its way", () => cloud.held.has("mako:agents-place"))
    assert.equal(studio.world.store.edges().all.length, 0)
    assert.deepEqual(await mac.world.agents.stop(apex.caller, { child: "probe" }), { stopped: ["probe"] }, "Studio said nothing of it had started, and holds the Stop")
    assert.equal(mac.world.store.queuedSpawns().length, 0)
    if (how === "slow") {
      arrive()
      assert.equal(refused(await starting).refused, "conflict", "the start's own answer says its Apex stopped it")
    } else assert.equal(refused(await studio.world.agents.place(lateStart(mac, apex))).refused, "conflict", "the start, arriving after the Stop, is refused")
    await mac.world.settle(200)
    assert.equal(studio.world.store.edges().all.length, 0, "no Fin was made there")
    assert.equal(studio.world.prompts.filter((prompt) => isBrief(prompt.text)).length, 0, "and nothing ran")
    assert.equal(mac.world.store.edges().all.length, 0)
    assert.equal(mac.world.store.queuedSpawns().length, 0)
    await mac.world.restart()
    assert.equal(mac.world.store.queuedSpawns().length, 0)
    assert.equal(atWorkOn(studio), 0)
    console.log(`stop, start ${how === "lost" ? "lost on its way" : "still on its way"}: the start that reached Studio after the Stop was refused there and never ran`)
  } finally {
    await mac.close()
    await studio.close()
  }
}

/**
 * What a placed Fin is doing is the Apex's device's own record, so its tree's running budget holds through a restart:
 * a Fin sent more work is at work after its Apex's host restarts, an earlier turn's report can't say a later turn
 * ended, and work its Apex didn't send (the person writing to it on its own device) is counted before a start is
 * admitted.
 */
async function activitySurvivesTheApexRestart(): Promise<void> {
  const cloud = account()
  const mac = await device(cloud, "MacBook", () => "Noted.", { budget: { running: 1, started: 100 } })
  const studio = await device(cloud, "Studio", async (turn) => {
    if (turn.text.includes("extra work")) await turn.world.hold(turn.conversation)
    return "Done."
  })
  const second = (key: string) => mac.world.agents.start(apex.caller, { brief: { objective: "another" }, name: key, harness: "codex", place: "device:Studio", clientKey: key, cwd: mac.world.root })
  const apex = await mac.world.apex("claude")
  try {
    const fin = started(await mac.world.agents.start(apex.caller, { ...PROBE, cwd: mac.world.root }))
    await until("its first result", () => wakesOf(mac, apex.conversation).length === 1)
    await mac.world.settle(40)
    assert.equal(stateOn(mac, apex.conversation, "probe"), "ended")
    const conversation = conversationOf(studio, fin.child!)
    const sent = await mac.world.agents.send(apex.caller, { to: "probe", text: "extra work", clientKey: "extra" })
    assert.ok(!("refused" in sent), JSON.stringify(sent))
    await until("its second turn at work", () => studio.world.live.atWork(conversation))
    assert.equal(stateOn(mac, apex.conversation, "probe"), "working")

    // Its first turn's report again, and a late report from before the message reached it: neither ends its second turn.
    const edge = studio.world.store.edges().of(fin.child!)!
    const first = studio.world.store.reportsOf(fin.child!)[0]!
    const notice: AgentsNoticeInput = { id: `notice:${edge.child}:${first.id}`, op: edge.op, parent: { thread: edge.parent, session: edge.parentSession }, child: edge.child, report: first, standing: { heard: 1, working: false, owner: first.ownerGeneration, seq: 1_000_000 } }
    assert.deepEqual(await mac.world.agents.notice(notice), { heard: true, deduped: true })
    assert.equal(stateOn(mac, apex.conversation, "probe"), "working", "a repeat of its first turn's report doesn't end its second")
    const late = { ...first, id: `report:${edge.child}:late`, summary: "Done, again.", at: first.at + 1 }
    assert.deepEqual(await mac.world.agents.notice({ ...notice, id: `notice:${edge.child}:${late.id}`, report: late }), { heard: true })
    assert.equal(stateOn(mac, apex.conversation, "probe"), "working", "nor does a report its device sent before the message reached it")

    await mac.world.restart()
    assert.equal(studio.world.live.atWork(conversation), true)
    assert.equal(stateOn(mac, apex.conversation, "probe"), "working", "it's at work after its Apex's host restarts")
    const listed = await mac.world.agents.list(apex.caller, {})
    assert.ok("tree" in listed && listed.tree.running === 1, JSON.stringify(listed))
    const over = await second("second")
    assert.ok("refused" in over && over.refused === "budget", `a tree running its one Thread takes no second: ${JSON.stringify(over)}`)
    assert.equal(atWorkOn(studio), 1)

    // Its second turn ends: the report its device sends for it is the one that says so.
    studio.world.release(conversation)
    await until("its second result", () => stateOn(mac, apex.conversation, "probe") === "ended")
    await mac.world.settle(40)
    await mac.world.restart()
    assert.equal(stateOn(mac, apex.conversation, "probe"), "ended", "and it's ended after a restart too")

    // The person writes to it on its own device: its Apex's device hears nothing, and asks before it admits a start.
    studio.world.say(conversation, "extra work, from the person")
    await until("the person's turn at work", () => studio.world.live.atWork(conversation))
    const third = await second("third")
    assert.ok("refused" in third && third.refused === "budget", `work its Apex didn't send is counted too: ${JSON.stringify(third)}`)
    assert.equal(stateOn(mac, apex.conversation, "probe"), "working")
    assert.equal(atWorkOn(studio), 1)
    console.log("activity: a placed Fin sent more work is at work through its Apex's restart and holds its tree's budget; an earlier turn's report didn't end it, and work the person gave it there was counted at admission")
  } finally {
    studio.world.release(conversationOf(studio, studio.world.store.edges().all[0]!.child))
    await mac.close()
    await studio.close()
  }
}

/**
 * Nothing old lowers the running count. The person gives a placed Fin more work on its own device, which the Apex's
 * device learns by asking; then the Fin's device can't be reached and the Apex's host restarts; then the Fin's first
 * notice, from before that work, is replayed. The Fin still reads working, the tree still runs one, and a second start
 * is refused: the newest word of the Fin's device is kept on the edge, so an older one changes nothing.
 */
/**
 * A placed Fin with two Sessions on its device: the person opened a second one there (`+`), newer, waiting on an
 * approval, while the older sits idle. The Apex's device holds no group of the Fin's Thread, only its device does; so
 * a window on the Apex's device, given the rows that device writes, in either order, must open and stand by the newer
 * Session's row: it carries the creation time its owner wrote, which `newestSaid` orders a Thread it holds no group of by.
 */
async function aPlacedFinsNewestSessionOnItsDevice(): Promise<void> {
  const cloud = account()
  const mac = await device(cloud, "MacBook", () => "Noted.")
  const studio = await device(cloud, "Studio", () => "Done.")
  try {
    const apex = await mac.world.apex("claude")
    const fin = started(await mac.world.agents.start(apex.caller, { ...PROBE, cwd: mac.world.root }))
    await until("its first result", () => wakesOf(mac, apex.conversation).length === 1)
    await mac.world.settle(40)
    const child = ThreadIdSchema.parse(fin.child!)
    const thread = studio.world.store.thread(child)!
    // A second Session of the Fin's Thread on its own device, as the person's `+` makes one: a conversation of its own, newer.
    const placement = studio.world.store.createSession({ operationId: randomUUID(), thread: child, actor: studio.world.store.person() })
    const newer = randomUUID()
    await studio.world.live.start("codex", studio.world.root, { conversationId: newer, session: placement.session, title: "a second Session" })
    assert.equal(studio.world.store.thread(child)?.sessions.length, 2, "the Fin's device holds its Thread's two Sessions")
    assert.equal(mac.world.store.group(child), undefined, "the Apex's device holds no group of the Fin's Thread: its device does")
    // And the person goes on in the older Session there: a conversation newer than any, in the Session that isn't.
    const continued = randomUUID()
    await studio.world.live.start("codex", studio.world.root, { conversationId: continued, session: thread.sessions[0]!, title: "the older Session, continued" })
    // The rows as each device writes them: the Apex's from the Mac, the Fin's two from Studio, each with the creation
    // time its owner's live engine gave the conversation.
    const mock = { deviceId: "6f1d2c3b-4a59-4e68-8a7b-9c0d1e2f3a4b" }
    const iso = (at: number) => new Date(at).toISOString()
    const rowOf = (session: string, conversation: string, snapshotOf: AgentsWorld, shown: Parameters<typeof conversationShown>[0], extra: Partial<ListedSession> = {}): ListedSession => {
      const snapshot = snapshotOf.live.snapshot(conversation)
      assert.ok(snapshot, `${conversation} is held live on its device`)
      // Its Session's place in its Thread, as the owner's store keeps it: what the owner's row says as `order`.
      const order = sessionOrderIn(studio.world.store.thread(child)?.sessions, session)
      const row = ReportedSessionSchema.parse({ session, thread: snapshot.threadId ?? child, conversation, harness: snapshot.session.harness, ...conversationShown(shown), createdAt: iso(snapshot.createdAt), activityAt: iso(Date.now()), generation: 1, ...(snapshotOf === studio.world && order !== undefined && { order }) })
      return { ...row, runsOn: { kind: "device", deviceId: mock.deviceId }, listedAt: iso(Date.now()), ...extra }
    }
    const apexSession = mac.world.store.journalPlacement(apex.conversation)!.session
    const apexRow = rowOf(apexSession, apex.conversation, mac.world, { session: { ...mac.world.live.snapshot(apex.conversation)!.session, title: "Placed Fins" }, working: undefined, waitingOn: () => undefined, fins: () => listedFins(mac.world.agents.roster(apex.conversation)) })
    // The older Session's row is its newest conversation's, the one the person continued in: made after the newer Session's.
    const olderRow = rowOf(thread.sessions[0]!, continued, studio.world, { session: { ...studio.world.live.snapshot(continued)!.session, title: "probe" }, working: undefined, waitingOn: () => undefined })
    const newerRow = rowOf(placement.session, newer, studio.world, { session: { ...studio.world.live.snapshot(newer)!.session, title: "probe" }, working: "waiting", waitingOn: () => ({ line: "Approve: echo HOTEL", for: "approval" }) })
    assert.ok(Date.parse(olderRow.createdAt) > Date.parse(newerRow.createdAt), "the older Session's row is the newer conversation's: creation time says nothing of Session order")
    assert.deepEqual([olderRow.order, newerRow.order], [0, 1], "each row says its Session's place as Studio's store keeps it")
    const listedOn = (rows: ListedSession[]) => {
      acpStore.set({ activeKey: null, conversations: {}, threadSessions: {} })
      listLive([listedSummary(apexRow, "MacBook", undefined), ...rows.map((row) => listedSummary(row, "Studio", undefined, undefined, listedApexOf(row, [apexRow, olderRow, newerRow])))])
      return threadChildren(acpStore.get(), apexRow.thread)
    }
    for (const order of ["older first", "newest first"] as const) {
      const children = listedOn(order === "older first" ? [olderRow, newerRow] : [newerRow, olderRow])
      assert.equal(children.length, 1, `${order}: the Apex's one Fin`)
      assert.equal(children[0]?.child?.conversation, newer, `${order}: the roster's entry opens the newer Session's conversation`)
      assert.deepEqual(childStateOf(children[0]!), { kind: "blocked", question: "Approve: echo HOTEL", on: "approval" }, `${order}: and stands as it does there`)
      assert.deepEqual(finOpening(acpStore.get(), children[0]!), { kind: "conversation", key: newer }, `${order}: from under the Apex it opens the approval`)
    }
    // An open ask always surfaces: the older Session asking while the newer sits idle, in either order, is what opens.
    const askingOlder = rowOf(thread.sessions[0]!, continued, studio.world, { session: { ...studio.world.live.snapshot(continued)!.session, title: "probe" }, working: "waiting", waitingOn: () => ({ line: "Approve: echo INDIA", for: "approval" }) })
    const idleNewer = rowOf(placement.session, newer, studio.world, { session: { ...studio.world.live.snapshot(newer)!.session, title: "probe" }, working: undefined, waitingOn: () => undefined })
    for (const order of ["older first", "newest first"] as const) {
      const children = listedOn(order === "older first" ? [askingOlder, idleNewer] : [idleNewer, askingOlder])
      assert.equal(children[0]?.child?.conversation, continued, `${order}: the asking Session's conversation, though older`)
      assert.deepEqual(childStateOf(children[0]!), { kind: "blocked", question: "Approve: echo INDIA", on: "approval" }, `${order}: standing on its ask`)
      assert.deepEqual(finOpening(acpStore.get(), children[0]!), { kind: "conversation", key: continued }, `${order}: from under the Apex it opens the ask`)
    }
    // The older Session waiting on the person for something else, by the owner's own fallback (`conversationShown`
    // with work waiting and nothing more specific to say): needs-you, which surfaces as an approval or a question would.
    const needingOlder = rowOf(thread.sessions[0]!, continued, studio.world, { session: { ...studio.world.live.snapshot(continued)!.session, title: "probe" }, working: "waiting", waitingOn: () => undefined })
    assert.equal(needingOlder.waitingFor, "needs-you", "the owner's fallback says needs-you")
    for (const order of ["older first", "newest first"] as const) {
      const children = listedOn(order === "older first" ? [needingOlder, idleNewer] : [idleNewer, needingOlder])
      assert.equal(children[0]?.child?.conversation, continued, `${order}: the waiting Session's conversation, though older`)
      assert.deepEqual(childStateOf(children[0]!), { kind: "blocked", question: needingOlder.waitingOn, on: "person" }, `${order}: standing on its wait`)
      assert.deepEqual(finOpening(acpStore.get(), children[0]!), { kind: "conversation", key: continued }, `${order}: from under the Apex it opens the wait`)
    }
    // Rows from a host before link version 22 say no order: they rank as they arrive, as every device did before.
    // Neither row asks anything, so nothing but arrival ranks them.
    const without = (row: ListedSession): ListedSession => ({ ...row, order: undefined, state: "idle", waitingOn: undefined, waitingFor: undefined })
    assert.equal(listedOn([without(olderRow), without(newerRow)])[0]?.child?.conversation, continued, "without the field, the first listed stands")
    assert.equal(listedOn([without(newerRow), without(olderRow)])[0]?.child?.conversation, newer, "whichever it is")
    console.log("two sessions: a placed Fin's newer Session on its device, its rows written by that device in either order and the older Session continued after it, is the one a window on the Apex's device opens and stands by, with no group of that Thread held there; rows from a host before the field rank as they arrive")
  } finally {
    await mac.close()
    await studio.close()
  }
}

async function anOldNoticeLowersNothing(): Promise<void> {
  const cloud = account()
  const mac = await device(cloud, "MacBook", () => "Noted.", { budget: { running: 1, started: 100 } })
  const studio = await device(cloud, "Studio", async (turn) => {
    if (turn.text.includes("from the person")) await turn.world.hold(turn.conversation)
    return "Done."
  })
  const spare = await device(cloud, "Spare", () => "Done.")
  try {
    const apex = await mac.world.apex("claude")
    const fin = started(await mac.world.agents.start(apex.caller, { ...PROBE, cwd: mac.world.root }))
    await until("its first result", () => wakesOf(mac, apex.conversation).length === 1)
    await mac.world.settle(40)
    assert.equal(stateOn(mac, apex.conversation, "probe"), "ended")
    // The notice that said so, as Studio sent it: what a replay would carry.
    const old = cloud.sent.filter((call) => call.channel === "mako:agents-notice").at(-1)?.args[0]
    assert.ok(old !== undefined, "Studio's notice of the first result")
    const conversation = conversationOf(studio, fin.child!)
    // The person, on Studio, gives it more work: the Apex's device hears nothing of that until it asks.
    studio.world.say(conversation, "extra work, from the person")
    await until("the person's turn at work on Studio", () => studio.world.live.atWork(conversation))
    const listed = await mac.world.agents.list(apex.caller, {})
    assert.ok("tree" in listed && listed.tree.running === 1, `asked, the Apex's device counts it: ${JSON.stringify(listed)}`)
    assert.equal(stateOn(mac, apex.conversation, "probe"), "working")
    // Studio out of reach, the Apex's host restarted: what it keeps is what it knows.
    studio.offline()
    await mac.world.restart()
    assert.equal(stateOn(mac, apex.conversation, "probe"), "working", "its work on Studio survives the restart")
    // SAFETY: the call's first argument is the notice input Studio built, as the host's schema took it, crossed as JSON.
    const replay = await mac.world.agents.notice(JSON.parse(JSON.stringify(old)) as AgentsNoticeInput)
    assert.deepEqual(replay, { heard: true, deduped: true }, "the old notice is the same notice")
    assert.equal(stateOn(mac, apex.conversation, "probe"), "working", "and changes nothing: it's older than Studio's last word")
    const again = await mac.world.agents.list(apex.caller, {})
    assert.ok("tree" in again && again.tree.running === 1, `the tree still runs one: ${JSON.stringify(again)}`)
    const second = await mac.world.agents.start(apex.caller, { brief: { objective: "another" }, name: "second", harness: "codex", place: "device:Spare", clientKey: "second", cwd: mac.world.root })
    assert.ok("refused" in second && second.refused === "budget", `a second start is refused on the budget of one: ${JSON.stringify(second)}`)
    assert.equal(spare.world.store.edges().all.length, 0, "nothing started on Spare")
    assert.equal(atWorkOn(studio), 1)
    console.log("old notice: the person's work on Studio, counted when the Apex's device asked, survived the Apex's restart with Studio unreachable, and a replay of the Fin's earlier notice lowered nothing: the tree ran one, and a second start was refused")
  } finally {
    studio.world.release(conversationOf(studio, studio.world.store.edges().all[0]!.child))
    await mac.close()
    await studio.close()
    await spare.close()
  }
}

function remotes(): void {
  const same = ["git@github.com:Acme/App.git", "https://github.com/acme/app", "https://github.com/acme/app.git/", "ssh://git@github.com/acme/app.git"]
  for (const spelling of same) assert.equal(remoteKey(spelling), "github.com/acme/app", spelling)
  assert.notEqual(remoteKey("https://github.com/acme/app"), remoteKey("https://github.com/acme/app2"))
  assert.notEqual(remoteKey("https://gitlab.com/acme/app"), remoteKey("https://github.com/acme/app"))
  assert.equal(remoteKey("/Users/me/repos/app.git"), "file:/Users/me/repos/app")
  assert.equal(remoteKey("file:///Users/me/repos/app.git"), "file:/Users/me/repos/app")
  console.log("remotes: every spelling of one remote is one checkout's")
}

/** Every case by its name; naming some after the script runs those alone. */
const CASES = {
  "retained-questions": retainedQuestionCapability,
  remotes,
  starts: startsOnAnotherDevice,
  routed: operationsAreRouted,
  "apex-offline": apexOfflineThenBack,
  notices: dedupeAndStaleOwners,
  refusals,
  "full-place": fullPlaceQueues,
  access: accessIsCapped,
  wait: waitsForAPlacedResult,
  "lost-answer": lostAnswerIsFoundAgain,
  "stop-lost-answer": () => stopEndsAStartWhoseAnswerWasLost("probe"),
  "stop-lost-answer-all": () => stopEndsAStartWhoseAnswerWasLost("all"),
  "stop-unreachable": () => stopWaitsForAnUnreachableDevice("probe"),
  "stop-unreachable-all": () => stopWaitsForAnUnreachableDevice("all"),
  "stop-placed-unreachable": stopOfAPlacedFinWaitsForItsDevice,
  "stop-start-lost": () => stopBeatsAStartStillOnItsWay("lost"),
  "stop-start-slow": () => stopBeatsAStartStillOnItsWay("slow"),
  activity: activitySurvivesTheApexRestart,
  "old-notice": anOldNoticeLowersNothing,
  "two-sessions": aPlacedFinsNewestSessionOnItsDevice,
} satisfies Record<string, () => Promise<void> | void>

try {
  const only = process.argv.slice(2)
  for (const name of only) assert.ok(name in CASES, `no case named ${name}: ${Object.keys(CASES).join(", ")}`)
  for (const [name, run] of Object.entries(CASES)) if (!only.length || only.includes(name)) await run()
  console.log(only.length ? `fins placed: ok (${only.join(", ")})` : "fins placed: ok")
} finally {
  rmSync(root, { recursive: true, force: true })
}
