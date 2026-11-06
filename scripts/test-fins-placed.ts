import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PROTOCOL_VERSION, problem, serveRuntime, type Actor, type ClientSession, type ServedRuntime } from "@mako/protocol"
import { createFakeGateway, type FakeGateway } from "@mako/protocol/fake-gateway"
import { unwatchedWork } from "@mako/host/base/event-loop"
import type { AccessTier } from "@mako/host/contracts/access"
import { ORCHESTRATION_VERSION, type AgentRefused, type AgentsNoticed, type AgentsNoticeInput, type ThreadParent } from "@mako/host/contracts/agents"
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
  return { gateway: createFakeGateway(), devices: [], lose: new Set() }
}

function started(answer: AgentsStartResult): AgentsStarted {
  assert.ok(!("refused" in answer), JSON.stringify(answer))
  return answer
}

function refused(answer: AgentsStartResult | AgentsNoticed): AgentRefused {
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
const wakesOf = (apex: Device, conversation: string) => apex.world.prompts.filter((prompt) => prompt.conversation === conversation && prompt.text.startsWith(FROM_AGENTS))
const placedEdge = (apex: Device, child: string | undefined): ThreadParent => {
  const edge = child ? apex.world.store.edges().of(child) : undefined
  assert.ok(edge?.placed, "the Apex's device keeps where it placed the Fin")
  return edge
}
const undelivered = (on: Device) => on.world.store.undeliveredReports().filter(({ report }) => report.status !== "progress").length

/** An Apex on one device starts a Fin on another: it runs there, and its result wakes the Apex here, once. */
async function startsOnAnotherDevice(): Promise<void> {
  const cloud = account()
  const mac = await device(cloud, "MacBook", () => "Noted.")
  const studio = await device(cloud, "Studio", (turn) => (isBrief(turn.text) ? "The sidebar's rows overlap at 320 px. I fixed the grid." : "ok"))
  try {
    assert.deepEqual(studio.world.agents.capabilities().orchestration, { version: ORCHESTRATION_VERSION }, "a place says which placement it speaks")
    const offers = studio.world.agents.capabilities()
    assert.ok(offers.slots.of > 0 && offers.slots.free === offers.slots.of && offers.harnesses.includes("claude"), "and its free slots and harnesses")

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
    assert.deepEqual(studio.world.agents.capabilities().slots, { free: 0, of: 1 }, "a device says when it's full")
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

function remotes(): void {
  const same = ["git@github.com:Acme/App.git", "https://github.com/acme/app", "https://github.com/acme/app.git/", "ssh://git@github.com/acme/app.git"]
  for (const spelling of same) assert.equal(remoteKey(spelling), "github.com/acme/app", spelling)
  assert.notEqual(remoteKey("https://github.com/acme/app"), remoteKey("https://github.com/acme/app2"))
  assert.notEqual(remoteKey("https://gitlab.com/acme/app"), remoteKey("https://github.com/acme/app"))
  assert.equal(remoteKey("/Users/me/repos/app.git"), "file:/Users/me/repos/app")
  assert.equal(remoteKey("file:///Users/me/repos/app.git"), "file:/Users/me/repos/app")
  console.log("remotes: every spelling of one remote is one checkout's")
}

try {
  remotes()
  await startsOnAnotherDevice()
  await operationsAreRouted()
  await apexOfflineThenBack()
  await dedupeAndStaleOwners()
  await refusals()
  await fullPlaceQueues()
  await accessIsCapped()
  await waitsForAPlacedResult()
  await lostAnswerIsFoundAgain()
  console.log("fins placed: ok")
} finally {
  rmSync(root, { recursive: true, force: true })
}
