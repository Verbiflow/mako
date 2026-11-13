import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { GIVE_UP_MS, nextRetry, RETRY_STEPS_MS, transientCause, type RetryCause } from "@mako/host/contracts/delivery-retry"
import { classifyProviderFailure } from "@mako/host/contracts/provider-failure"
import { describeTransferRecovery } from "@mako/host/contracts/operation-recovery"
import type { LiveRequest } from "@mako/host/contracts/live-conversations"
import { FROM_AGENTS } from "@mako/host/conversations/agent-wakes"
import { AgentsWorld, HARNESSES, type Script } from "./lib/agents-world.ts"
import { providerOutageControls } from "./lib/provider-outage-controls.ts"

/**
 * A message that can't reach its harness for a cause that clears by itself
 * waits and goes again by itself (`npm run test:delivery-retry`). The
 * person's Apex, woken for a Fin's report, failed twice in a day with a red
 * "Could not reopen this session" card: once on Cursor's "Server at
 * capacity", once because the session was still open in the process Mako had
 * just put to sleep. Neither needed the person. Covered, on each of the six
 * harnesses with scripted ones: a wake that fails on capacity, the service,
 * the network, a stalled start or a session still open elsewhere holds the
 * message with when it goes next, leaves the session asleep rather than
 * failed, and sends it once when that time comes; an Apex woken for a Fin's
 * report the same; a prompt the harness refuses unsent on a rate limit goes
 * again; a turn its harness fails partway on capacity continues by itself, or
 * gives way to a new message; a failure only the person can fix still fails
 * at once. The waits grow to ten minutes and repeat, so a usage limit is
 * waited out until it resets, and a session open elsewhere is waited for half
 * an hour.
 */
const root = mkdtempSync(join(tmpdir(), "mako-delivery-retry-"))
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const LATER = 11 * 60_000

async function until(what: string, done: () => boolean, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`)
    await pause(10)
  }
}

const CAUSES: { cause: RetryCause; error: string }[] = [
  { cause: "rate-limited", error: "[unavailable] Server at capacity" },
  { cause: "provider-unavailable", error: "503 Service Unavailable" },
  { cause: "provider-unavailable", error: "Failed to authenticate. API Error: 403 Attention Required! | Cloudflare" },
  { cause: "provider-unavailable", error: "Failed to authenticate. API Error: 503 Service Unavailable" },
  { cause: "network", error: "fetch failed" },
  { cause: "launch-stalled", error: "The agent produced no output for 60 s during startup" },
]

interface Faults {
  /** The next start of each conversation throws these words. */
  start: Map<string, string>
  /** The next resume check of each session says another process has it open. */
  busy: Set<string>
  /** The next prompt to each conversation is refused unsent with these words. */
  refuse: Map<string, string>
}

/**
 * A Fin's brief holds its turn until `release`; a turn told to "Stall" fails partway with its harness at capacity, as
 * Cursor's does, its process kept, and one told to "Stall later" does so once released; every other turn ends at once.
 */
const script: Script = async (turn) => {
  if (turn.text.includes("fin:labels")) return turn.world.hold(turn.conversation).then(() => "Labels finished.")
  if (!turn.text.includes("Stall")) return "Done."
  if (turn.text.includes("Stall later.")) await turn.world.hold(turn.conversation)
  const session = turn.world.live.snapshot(turn.conversation)!.session
  turn.world.live.observe({ type: "live-session", session: { ...session, status: "failed", error: "[resource_exhausted] Error" } })
  return new Promise<string>(() => {})
}

interface FaultyWorld {
  world: AgentsWorld
  faults: Faults
}

function worldOf(name: string): FaultyWorld {
  const faults: Faults = { start: new Map(), busy: new Set(), refuse: new Map() }
  const world = new AgentsWorld({
    root: join(root, name),
    script,
    starting: (conversation) => {
      const error = faults.start.get(conversation)
      if (!error) return
      faults.start.delete(conversation)
      throw new Error(error)
    },
    resumeVerdict: async (binding) => {
      if (!faults.busy.delete(binding.id)) return { kind: "resumable", record: "same" }
      return { kind: "held", by: "another process with the native source open" }
    },
    refusePrompt: (conversation) => {
      const error = faults.refuse.get(conversation)
      if (error) faults.refuse.delete(conversation)
      return error
    },
  })
  return { world, faults }
}

function requestOf(world: AgentsWorld, conversation: string, words: string): LiveRequest | undefined {
  return world.live.snapshot(conversation)?.requests.find((request) => request.text.includes(words))
}

function sentTimes(world: AgentsWorld, conversation: string, words: string): number {
  return world.prompts.filter((prompt) => prompt.conversation === conversation && prompt.text.includes(words)).length
}

/** A conversation that took a first turn and went to sleep. */
async function asleep(world: AgentsWorld, harness: string): Promise<string> {
  const { conversation } = await world.apex(harness, "full")
  world.say(conversation, "First.")
  await until("the first turn", () => requestOf(world, conversation, "First.")?.status === "completed")
  assert.equal(world.live.hibernateIfIdle(conversation, "test"), true)
  await until("it to sleep", () => world.live.session(conversation)?.connection === "hibernated")
  return conversation
}

/** The message waits to go again for `cause`: held with its next attempt, the session asleep and not failed, nothing failed. */
function waits(world: AgentsWorld, conversation: string, words: string, cause: RetryCause, label: string): void {
  const request = requestOf(world, conversation, words)
  assert.equal(request?.status, "held", `${label}: held, not ${request?.status} (${request?.error ?? ""})`)
  assert.equal(request.retry?.cause, cause, label)
  assert.ok(request.retry.at > Date.now(), label)
  const session = world.live.session(conversation)
  assert.notEqual(session?.status, "failed", `${label}: the session isn't failed (${session?.error ?? ""})`)
  assert.ok(!world.live.snapshot(conversation)?.requests.some((each) => each.status === "failed"), `${label}: nothing failed`)
}

/** When its time comes it goes, once, and its turn completes. */
async function goesOnce(world: AgentsWorld, conversation: string, words: string, label: string): Promise<void> {
  world.live.wakeDue(Date.now() + LATER)
  await until(`${label}: it to go again`, () => requestOf(world, conversation, words)?.status === "completed")
  assert.equal(sentTimes(world, conversation, words), 1, `${label}: its harness took it once`)
}

try {
  await providerOutageControls(root)
  // The policy: waits grow and repeat at ten minutes, so a usage limit is waited out; a session open elsewhere, half an hour.
  {
    const now = 1_000_000
    const first = nextRetry(undefined, "rate-limited", "usage limit", now)!
    assert.deepEqual([first.attempt, first.at - now, first.since], [1, RETRY_STEPS_MS[0], now])
    let retry = first
    for (let attempt = 2; attempt <= 40; attempt++) retry = nextRetry(retry, "rate-limited", "usage limit", now)!
    assert.equal(retry.at - now, 600_000, "the fortieth attempt waits ten minutes, as every one past the sixth")
    // Every cause ends: past its bound the message fails with its card, so nothing waits unseen forever.
    for (const cause of ["rate-limited", "provider-unavailable", "network", "launch-stalled", "busy"] as const) {
      const begun = nextRetry(undefined, cause, "why", now)!
      assert.ok(nextRetry(begun, cause, "why", now + GIVE_UP_MS[cause] - 1), cause)
      assert.equal(nextRetry(begun, cause, "why", now + GIVE_UP_MS[cause]), undefined, `${cause} gives up after ${GIVE_UP_MS[cause] / 60_000} minutes`)
    }
    assert.ok(GIVE_UP_MS["rate-limited"] >= 5 * 60 * 60_000, "a usage limit's five-hour window is waited out")
    // A cause the person must fix is never waited out, whatever transient words wrap it.
    for (const words of ["API error: 400 Bad Request: unknown model permanently-retired-model", "503 Service Unavailable: invalid api key", "429 Too Many Requests: your plan does not include this model"])
      assert.equal(transientCause(words, classifyProviderFailure(words).kind, false), undefined, words)
    for (const words of ["[unavailable] Server at capacity", "429 Too Many Requests", "fetch failed", "503 Service Unavailable"])
      assert.ok(transientCause(words, classifyProviderFailure(words).kind, false), words)
  }
  console.log("policy: waits grow to ten minutes and repeat; every cause ends in a failure past its bound; a permanent cause inside transient words is never retried")

  for (const harness of HARNESSES) {
    // A wake that fails for a cause that clears by itself waits, then sends the message once.
    for (const [index, { cause, error }] of CAUSES.entries()) {
      const { world, faults } = worldOf(`${harness}-${cause}-${index}`)
      const conversation = await asleep(world, harness)
      faults.start.set(conversation, error)
      world.say(conversation, "Second.")
      await until(`${harness} ${cause}: the wake to fail`, () => requestOf(world, conversation, "Second.")?.status === "held")
      waits(world, conversation, "Second.", cause, `${harness} ${cause}`)
      assert.equal(sentTimes(world, conversation, "Second."), 0)
      await goesOnce(world, conversation, "Second.", `${harness} ${cause}`)
      await world.close()
    }

    // The session still open in another process (Mako's own, closing): waited for, then resumed.
    {
      const { world, faults } = worldOf(`${harness}-busy`)
      const conversation = await asleep(world, harness)
      faults.busy.add(conversation)
      world.say(conversation, "Second.")
      await until(`${harness} busy: the wake to be refused`, () => requestOf(world, conversation, "Second.")?.status === "held")
      waits(world, conversation, "Second.", "busy", `${harness} busy`)
      await goesOnce(world, conversation, "Second.", `${harness} busy`)
      await world.close()
    }

    // The case of 2026-11-04: an Apex asleep, woken for its Fin's report, its harness at capacity.
    {
      const { world, faults } = worldOf(`${harness}-apex`)
      const apex = await world.apex(harness, "full")
      world.say(apex.conversation, "Start a Fin.")
      await until("the Apex's turn", () => requestOf(world, apex.conversation, "Start a Fin.")?.status === "completed")
      const started = await world.agents.start(apex.caller, { brief: { objective: "Label the snippets" }, harness, name: "labels", clientKey: "labels", cwd: world.root })
      assert.ok(!("refused" in started) && started.conversation, JSON.stringify(started))
      const fin = started.conversation!
      await until("the Fin to work", () => world.live.session(fin)?.status === "running")
      assert.equal(world.live.hibernateIfIdle(apex.conversation, "test"), true, `${harness}: the Apex sleeps while its Fin works`)
      await until("the Apex to sleep", () => world.live.session(apex.conversation)?.connection === "hibernated")
      faults.start.set(apex.conversation, "[unavailable] Server at capacity")
      world.release(fin)
      await until(`${harness} apex: the wake for the report to wait`, () => requestOf(world, apex.conversation, FROM_AGENTS)?.retry?.cause === "rate-limited", 10_000)
      waits(world, apex.conversation, FROM_AGENTS, "rate-limited", `${harness} apex`)
      await goesOnce(world, apex.conversation, FROM_AGENTS, `${harness} apex`)
      await world.close()
    }

    // A prompt its harness refuses unsent on a rate limit goes again.
    {
      const { world, faults } = worldOf(`${harness}-refused`)
      const { conversation } = await world.apex(harness, "full")
      world.say(conversation, "First.")
      await until("the first turn", () => requestOf(world, conversation, "First.")?.status === "completed")
      faults.refuse.set(conversation, "429 Too Many Requests")
      world.say(conversation, "Second.")
      await until(`${harness} refused: it to wait`, () => requestOf(world, conversation, "Second.")?.status === "held")
      waits(world, conversation, "Second.", "rate-limited", `${harness} refused`)
      await goesOnce(world, conversation, "Second.", `${harness} refused`)
      await world.close()
    }

    // A turn its harness fails partway on capacity continues by itself when its time comes, ahead of what was queued after it.
    {
      const { world } = worldOf(`${harness}-midturn`)
      const { conversation } = await world.apex(harness, "full")
      world.say(conversation, "Stall.")
      await until(`${harness} mid-turn: the turn to fail`, () => requestOf(world, conversation, "Stall.")?.status === "failed")
      const failed = requestOf(world, conversation, "Stall.")!
      assert.equal(failed.failure, "rate-limited")
      assert.equal(failed.retry?.cause, "rate-limited", `${harness} mid-turn: the failed turn says when it continues`)
      const continuation = world.live.snapshot(conversation)!.requests.find((request) => request.continues?.requestId === failed.id)
      assert.equal(continuation?.status, "held", `${harness} mid-turn: its continuation waits`)
      assert.equal(continuation.retry?.at, failed.retry.at)
      world.say(conversation, "Then this.")
      assert.equal(world.live.snapshot(conversation)!.requests.find((request) => request.id === continuation.id)?.status, "canceled", "a new message supersedes a continuation, as it does a dropped connection's")
      await until(`${harness} mid-turn: the new message to go`, () => requestOf(world, conversation, "Then this.")?.status === "completed")
      await world.close()
    }
    {
      const { world } = worldOf(`${harness}-midturn-alone`)
      const { conversation } = await world.apex(harness, "full")
      world.say(conversation, "Stall.")
      await until(`${harness} mid-turn alone: the turn to fail`, () => requestOf(world, conversation, "Stall.")?.status === "failed")
      const failed = requestOf(world, conversation, "Stall.")!
      world.live.wakeDue(Date.now() + LATER)
      await until(`${harness} mid-turn alone: it to continue`, () => world.live.snapshot(conversation)!.requests.some((request) => request.continues?.requestId === failed.id && request.status === "completed"))
      await world.close()
    }

    // A first start that fails at capacity, with nothing yet to resume (a Fin's brief): it starts again by itself, once.
    {
      const { world, faults } = worldOf(`${harness}-first-start`)
      const conversation = randomUUID()
      faults.start.set(conversation, "[unavailable] Server at capacity")
      await world.live.start(harness, world.root, { conversationId: conversation, initialRequest: { id: randomUUID(), text: "Brief.", attachments: [] } })
      await until(`${harness} first start: it to wait`, () => requestOf(world, conversation, "Brief.")?.status === "held")
      waits(world, conversation, "Brief.", "rate-limited", `${harness} first start`)
      await goesOnce(world, conversation, "Brief.", `${harness} first start`)
      await world.close()
    }

    // A Stop during a switch to another harness holds the switch alone: the source session stays the conversation's,
    // and a fresh message on it goes and its reply and end are heard, through its driver's own callback.
    {
      const to = HARNESSES[(HARNESSES.indexOf(harness) + 1) % HARNESSES.length]!
      let opened: (() => void) | undefined
      const world = new AgentsWorld({
        root: join(root, `${harness}-switch-stop`),
        script,
        starting: (_conversation, starting) => (starting === to ? new Promise<void>((resolve) => { opened = resolve }) : undefined),
      })
      const label = `${harness} switch Stop`
      const { conversation } = await world.apex(harness, "full")
      world.live.transfer(conversation, { id: randomUUID(), provider: to, text: "Switch.", attachments: [] })
      await until(`${label}: the switch under way`, () => opened !== undefined)
      await world.live.cancel(conversation)
      opened!()
      await pause(200)
      assert.equal(world.live.snapshot(conversation)?.control?.transfers.at(-1)?.state.kind, "queued", label)
      assert.equal(requestOf(world, conversation, "Switch.")?.status, "held", `${label}: its message waits, held`)
      world.say(conversation, "Fresh message.")
      await until(`${label}: the fresh message to complete on the source`, () => requestOf(world, conversation, "Fresh message.")?.status === "completed")
      assert.equal(world.prompts.filter((prompt) => prompt.conversation === conversation && prompt.text.includes("Fresh message.")).map((prompt) => prompt.harness).join(), harness, `${label}: it went on the source, once`)
      assert.equal(sentTimes(world, conversation, "Switch."), 0, `${label}: the switch's message never went`)
      await world.close()
    }

    // A switch whose destination is committed completes, a Stop or not, and what the person does to the queue while
    // its source closes stands: a Stop pauses the switch's message, unsent, with what waited; an edit, a Resume or a
    // removal after it is kept as they did it. The destination is the binding, and the next message goes on it.
    for (const during of ["control", "stop", "stop, edit", "stop, resume", "stop, remove"] as const) {
      const to = HARNESSES[(HARNESSES.indexOf(harness) + 1) % HARNESSES.length]!
      let gate: (() => void) | undefined
      let gating = false
      const world = new AgentsWorld({
        root: join(root, `${harness}-switch-retire-${during.replaceAll(", ", "-")}`),
        script,
        closing: (_binding, closing) => (gating && closing === harness ? new Promise<void>((resolve) => { gate = resolve }) : undefined),
      })
      const label = `${harness} switch retiring its source (${during})`
      const { conversation } = await world.apex(harness, "full")
      // A message waiting for its time, which the switch carries over.
      const later = randomUUID()
      world.live.submit(conversation, later, "Later.", [], undefined, undefined, undefined, undefined, { wake: { at: Date.now() + 60 * 60_000, after: "earlier" } })
      gating = true
      world.live.transfer(conversation, { id: randomUUID(), provider: to, text: "Switch.", attachments: [] })
      await until(`${label}: the source closing`, () => gate !== undefined)
      if (during !== "control") await world.live.cancel(conversation)
      if (during === "stop, edit") world.live.editQueued(conversation, { requestId: later, expectedText: "Later.", change: { kind: "edit", text: "Edited." } })
      if (during === "stop, resume") world.live.editQueued(conversation, { requestId: later, expectedText: "Later.", change: { kind: "resume" } })
      if (during === "stop, remove") world.live.editQueued(conversation, { requestId: later, expectedText: "Later.", change: { kind: "remove" } })
      gate!()
      gating = false
      await until(`${label}: the switch done`, () => world.live.snapshot(conversation)?.control?.transfers.at(-1)?.state.kind === "accepted" && world.live.snapshot(conversation)?.session.harness === to)
      const own = () => requestOf(world, conversation, "Switch.")
      const waiting = () => world.live.snapshot(conversation)?.requests.find((request) => request.id === later)
      if (during === "control") await until(`${label}: its message to go`, () => own()?.status === "completed")
      else {
        await pause(200)
        assert.deepEqual([own()?.status, own()?.pause, sentTimes(world, conversation, "Switch.")], ["held", "stop", 0], `${label}: its message is the Stop's, unsent`)
      }
      if (during === "stop" || during === "control") assert.equal(waiting()?.status, "held", `${label}: what waited still waits`)
      if (during === "stop") assert.equal(waiting()?.pause, "stop", `${label}: paused by the Stop`)
      if (during === "stop, edit") {
        // Saving an edit isn't a resume: the person's words stand, under the Stop's hold, until Resume sends them.
        assert.deepEqual([requestOf(world, conversation, "Edited.")?.status, requestOf(world, conversation, "Edited.")?.pause, sentTimes(world, conversation, "Edited.")], ["held", "stop", 0], `${label}: the edit stands, held`)
        world.live.editQueued(conversation, { requestId: later, expectedText: "Edited.", change: { kind: "resume" } })
        await until(`${label}: Resume to send the edit`, () => requestOf(world, conversation, "Edited.")?.status === "completed")
        assert.deepEqual([sentTimes(world, conversation, "Edited."), sentTimes(world, conversation, "Later.")], [1, 0], `${label}: the person's words went, once, and the old ones never`)
      }
      if (during === "stop, resume") await until(`${label}: the resumed message to go`, () => waiting()?.status === "completed")
      if (during === "stop, remove") {
        await pause(200)
        assert.ok(waiting() === undefined || waiting()?.status === "canceled", `${label}: removed stays removed (${waiting()?.status})`)
        assert.equal(sentTimes(world, conversation, "Later."), 0, `${label}: and never goes`)
      }
      world.say(conversation, "Fresh message.")
      await until(`${label}: the next message to complete`, () => requestOf(world, conversation, "Fresh message.")?.status === "completed")
      assert.equal(world.prompts.filter((prompt) => prompt.conversation === conversation && prompt.text.includes("Fresh message.")).map((prompt) => prompt.harness).join(), to, `${label}: on the destination, once`)
      await world.restart()
      assert.equal(requestOf(world, conversation, "Switch.")?.pause, during === "control" ? undefined : "stop", `${label}: the Stop's mark survives a restart`)
      if (during === "stop, edit") assert.equal(requestOf(world, conversation, "Later."), undefined, `${label}: and the edit does`)
      await world.close()
    }

    // One switch at a time: a second asked for while the first opens is refused; one asked for while the first is
    // committed and closing its source waits behind it, durable and saying so, and runs after it and its message,
    // whether the first completes or its close fails and takes it back, a Stop first or not, and across a restart.
    for (const [when, first] of [["opening", "succeeds"], ["opening", "fails"], ["closing", "succeeds"], ["closing", "fails"], ["closing", "stopped, fails"], ["closing", "restart"]] as const) {
      const one = HARNESSES[(HARNESSES.indexOf(harness) + 1) % HARNESSES.length]!
      const two = HARNESSES[(HARNESSES.indexOf(harness) + 2) % HARNESSES.length]!
      let gate: (() => void) | undefined
      let gating = false
      const fails = first === "fails" || first === "stopped, fails"
      const held = (reason: string) => new Promise<void>((resolve, reject) => { gate = () => (fails ? reject(new Error(reason)) : resolve()) })
      const world = new AgentsWorld({
        root: join(root, `${harness}-second-switch-${when}-${first.replaceAll(", ", "-")}`),
        script: (turn) => (first === "restart" && turn.text.includes("First switch.") ? turn.world.hold(turn.conversation).then(() => "Done.") : script(turn)),
        starting: (_conversation, starting) => (gating && when === "opening" && starting === one ? held("The model API refused the request: encrypted_content could not be verified") : undefined),
        closing: (_binding, closing) => (gating && when === "closing" && closing === harness ? held("The source session did not close") : undefined),
      })
      const label = `${harness} a second switch while the first is ${when} (${first})`
      const { conversation } = await world.apex(harness, "full")
      const transfers = () => world.live.snapshot(conversation)?.control?.transfers ?? []
      const firstId = randomUUID()
      const secondId = randomUUID()
      gating = true
      world.live.transfer(conversation, { id: firstId, provider: one, text: "First switch.", attachments: [] })
      await until(`${label}: the first ${when}`, () => gate !== undefined)
      if (first === "stopped, fails") await world.live.cancel(conversation)
      let refused = ""
      try {
        world.live.transfer(conversation, { id: secondId, provider: two, text: "Second switch.", attachments: [] })
      } catch (error) {
        refused = error instanceof Error ? error.message : String(error)
      }
      const waiting = transfers().find((transfer) => transfer.input.id === secondId)
      if (when === "opening") assert.match(refused, /already pending/, `${label}: refused while the first opens`)
      else {
        assert.deepEqual([refused, waiting?.state.kind, waiting?.behind], ["", "queued", firstId], `${label}: it waits behind the first`)
        assert.equal(describeTransferRecovery(waiting!, two).title, "Waiting for the current switch to finish", label)
      }
      gating = false
      gate!()
      const ends = when === "opening" ? (fails ? harness : one) : two
      if (first === "restart") {
        await until(`${label}: the first's message to run`, () => requestOf(world, conversation, "First switch.")?.status === "dispatching")
        assert.equal(transfers().find((transfer) => transfer.input.id === secondId)?.state.kind, "queued", `${label}: the second waits for the first's message`)
        await world.restart()
      }
      // A switch a Stop reached waits with its message, held, for its Resume; the rest settle.
      const stopped = first === "stopped, fails" ? firstId : undefined
      await until(`${label}: it to settle on ${ends}`, () => world.live.snapshot(conversation)?.session.harness === ends && !transfers().some((transfer) => transfer.input.id !== stopped && (transfer.state.kind === "queued" || transfer.state.kind === "preparing")), 15_000)
      if (when !== "opening") {
        await until(`${label}: the second's message to go`, () => requestOf(world, conversation, "Second switch.")?.status === "completed")
        assert.equal(sentTimes(world, conversation, "Second switch."), 1, `${label}: the second went once`)
        const order = world.prompts.filter((prompt) => prompt.conversation === conversation && /First switch\.|Second switch\./.test(prompt.text)).map((prompt) => `${/First/.test(prompt.text) ? "first" : "second"}@${prompt.harness}`)
        assert.deepEqual(order, fails ? [`second@${two}`] : [`first@${one}`, `second@${two}`], `${label}: in order, each on its own harness`)
      }
      world.say(conversation, "Fresh message.")
      await until(`${label}: the next message to complete`, () => requestOf(world, conversation, "Fresh message.")?.status === "completed")
      assert.equal(world.prompts.filter((prompt) => prompt.conversation === conversation && prompt.text.includes("Fresh message.")).map((prompt) => prompt.harness).join(), ends, `${label}: on ${ends}, once`)
      if (stopped) {
        assert.deepEqual([requestOf(world, conversation, "First switch.")?.status, requestOf(world, conversation, "First switch.")?.pause, sentTimes(world, conversation, "First switch.")], ["held", "stop", 0], `${label}: the first waits for its Resume, unsent`)
        world.live.editQueued(conversation, { requestId: stopped, expectedText: "First switch.", change: { kind: "resume" } })
        await until(`${label}: Resume to send it on its destination`, () => requestOf(world, conversation, "First switch.")?.status === "completed" && world.live.snapshot(conversation)?.session.harness === one, 15_000)
        assert.equal(sentTimes(world, conversation, "First switch."), 1, `${label}: once`)
      }
      await world.close()
    }

    // The person's Stop ends a turn that fails partway on capacity as it lands, and a first start waiting to go again or
    // under way that comes back at capacity: nothing continues, starts or sends after it, nor after a restart.
    for (const under of ["mid-turn", "first start waiting", "first start late"] as const) {
      let fail: ((words: string) => void) | undefined
      const world = new AgentsWorld({
        root: join(root, `${harness}-stop-${under.replaceAll(" ", "-")}`),
        script,
        starting: (conversation) => {
          if (under === "mid-turn" || world.live.snapshot(conversation)?.requests.some((request) => request.pause === "stop")) return
          if (under === "first start waiting") throw new Error("[unavailable] Server at capacity")
          return new Promise<void>((_resolve, reject) => { fail = (words) => reject(new Error(words)) })
        },
      })
      const label = `${harness} Stop (${under})`
      let conversation: string
      if (under === "mid-turn") {
        conversation = (await world.apex(harness, "full")).conversation
        world.say(conversation, "Stall later.")
        await until(`${label}: the turn`, () => world.live.session(conversation)?.status === "running")
      } else {
        conversation = randomUUID()
        void world.live.start(harness, world.root, { conversationId: conversation, initialRequest: { id: randomUUID(), text: "Stall later.", attachments: [] } })
        if (under === "first start waiting") await until(`${label}: it to wait`, () => requestOf(world, conversation, "Stall later.")?.retry !== undefined)
        else await until(`${label}: the start under way`, () => fail !== undefined)
      }
      await world.live.cancel(conversation)
      fail?.("[unavailable] Server at capacity")
      await pause(200)
      const made = () => world.live.snapshot(conversation)!.requests
      assert.ok(!made().some((request) => request.retry !== undefined || (request.continues && request.status !== "canceled")), `${label}: nothing waits to go by itself (${JSON.stringify(made().map((request) => [request.status, request.retry?.cause, request.continues?.reason]))})`)
      world.live.wakeDue(Date.now() + LATER)
      await pause(300)
      const sentAt = sentTimes(world, conversation, "Stall later.")
      const continued = () => world.prompts.filter((prompt) => prompt.conversation === conversation && prompt.text.startsWith("Continue where you left off")).length
      assert.deepEqual([sentAt, continued()], [under === "mid-turn" ? 1 : 0, 0], `${label}: nothing goes after the Stop`)
      await world.restart()
      world.live.wakeDue(Date.now() + LATER)
      await pause(500)
      assert.deepEqual([sentTimes(world, conversation, "Stall later."), continued()], [sentAt, 0], `${label}: nor after a restart`)
      await world.close()
    }

    // A message that starts its session through a transfer (no driver, nothing to wake), at capacity: the transfer goes again by itself, once.
    {
      const { world, faults } = worldOf(`${harness}-transfer`)
      const conversation = randomUUID()
      faults.start.set(conversation, "[unavailable] Server at capacity")
      await world.live.start(harness, world.root, { conversationId: conversation })
      await until("its start to fail", () => world.live.session(conversation)?.status === "failed")
      faults.start.set(conversation, "[unavailable] Server at capacity")
      world.say(conversation, "Hello.")
      await until(`${harness} transfer: it to wait`, () => world.live.snapshot(conversation)?.control?.transfers.some((transfer) => transfer.retry?.cause === "rate-limited") === true)
      const transfers = () => world.live.snapshot(conversation)?.control?.transfers ?? []
      assert.ok(!transfers().some((transfer) => transfer.state.kind === "failed"), `${harness}: no failed transfer`)
      world.live.wakeDue(Date.now() + LATER)
      await until(`${harness} transfer: it to go`, () => requestOf(world, conversation, "Hello.")?.status === "completed")
      assert.equal(sentTimes(world, conversation, "Hello."), 1, `${harness} transfer: once`)
      await world.close()
    }

    // The person's Stop holds a transfer waiting to go again, or one under way whatever its open comes back with: it
    // never goes by itself, nor after a restart, and reads as paused, not failed. Resume sends it once.
    for (const under of ["waiting", "late capacity", "late open"] as const) {
      let opens = 0
      let open: ((fails: boolean) => void) | undefined
      const world = new AgentsWorld({
        root: join(root, `${harness}-transfer-stop-${under}`),
        script,
        starting: (_conversation) => {
          opens += 1
          if (opens === 1 || (opens === 2 && under === "waiting")) throw new Error("[unavailable] Server at capacity")
          if (opens > 2) return
          return new Promise<void>((resolve, reject) => { open = (fails) => (fails ? reject(new Error("[unavailable] Server at capacity")) : resolve()) })
        },
      })
      const label = `${harness} transfer Stop (${under})`
      const conversation = randomUUID()
      await world.live.start(harness, world.root, { conversationId: conversation })
      await until("its start to fail", () => world.live.session(conversation)?.status === "failed")
      world.say(conversation, "Hello.")
      const transfer = () => world.live.snapshot(conversation)?.control?.transfers.at(-1)
      if (under === "waiting") await until(`${label}: it to wait`, () => transfer()?.retry !== undefined)
      else await until(`${label}: it under way`, () => transfer()?.state.kind === "preparing" && open !== undefined)
      await world.live.cancel(conversation)
      open?.(under === "late capacity")
      await pause(200)
      // Held like any message: its words wait in the queue under the Stop, and the switch waits with them.
      const stopped = transfer()
      assert.deepEqual([stopped?.state.kind, stopped?.retry], ["queued", undefined], `${label}: held, not going again by itself`)
      assert.deepEqual([requestOf(world, conversation, "Hello.")?.status, requestOf(world, conversation, "Hello.")?.pause], ["held", "stop"], `${label}: its message is the Stop's`)
      assert.match(describeTransferRecovery(stopped!, harness, requestOf(world, conversation, "Hello.")).title, /is paused$/, label)
      world.live.wakeDue(Date.now() + LATER)
      await pause(300)
      assert.equal(sentTimes(world, conversation, "Hello."), 0, `${label}: nothing sends after the Stop`)
      await world.restart()
      world.live.wakeDue(Date.now() + LATER)
      await pause(500)
      assert.equal(sentTimes(world, conversation, "Hello."), 0, `${label}: nor after a restart`)
      const held = requestOf(world, conversation, "Hello.")
      assert.equal(held?.status, "held", `${label}: still held`)
      world.live.editQueued(conversation, { requestId: held!.id, expectedText: held!.text, change: { kind: "resume" } })
      await until(`${label}: Resume to send it`, () => sentTimes(world, conversation, "Hello.") === 1)
      await world.close()
    }

    // A permanent cause wrapped in a service's words fails at once too.
    {
      const { world, faults } = worldOf(`${harness}-wrapped`)
      const conversation = await asleep(world, harness)
      faults.start.set(conversation, "API error: 400 Bad Request: unknown model permanently-retired-model")
      world.say(conversation, "Second.")
      await until(`${harness} wrapped: it to fail`, () => requestOf(world, conversation, "Second.")?.status === "failed")
      assert.equal(requestOf(world, conversation, "Second.")?.retry, undefined)
      await world.close()
    }

    // The person's order holds: A fails partway with B queued, then C supersedes A's continuation; B goes before C.
    {
      const { world } = worldOf(`${harness}-order`)
      const { conversation } = await world.apex(harness, "full")
      world.say(conversation, "Stall later.")
      await until("A to run", () => world.live.session(conversation)?.status === "running")
      world.say(conversation, "Then B.")
      world.release(conversation)
      await until(`${harness} order: A to fail`, () => requestOf(world, conversation, "Stall later.")?.status === "failed")
      world.say(conversation, "Then C.")
      await until(`${harness} order: C to go`, () => requestOf(world, conversation, "Then C.")?.status === "completed")
      const order = world.prompts.filter((prompt) => prompt.conversation === conversation).map((prompt) => /Stall later\.|Then B\.|Then C\./.exec(prompt.text)?.[0])
      assert.deepEqual(order, ["Stall later.", "Then B.", "Then C."], `${harness}: the person's messages go in the order they sent them`)
      await world.close()
    }

    // The person closes a session right after a restart, before anything read its journal in: what waited to go stays put.
    {
      const { world, faults } = worldOf(`${harness}-close-after-restart`)
      const { conversation } = await world.apex(harness, "full")
      world.say(conversation, "First.")
      await until("the first turn", () => requestOf(world, conversation, "First.")?.status === "completed")
      faults.refuse.set(conversation, "429 Too Many Requests")
      world.say(conversation, "Second.")
      await until(`${harness} close after restart: it to wait`, () => requestOf(world, conversation, "Second.")?.status === "held")
      await world.restart()
      await world.live.close(conversation)
      world.live.wakeDue(Date.now() + LATER)
      await pause(300)
      assert.equal(sentTimes(world, conversation, "Second."), 0, `${harness}: the person's close after a restart stops it waiting to go`)
      assert.equal(requestOf(world, conversation, "Second.")?.retry, undefined)
      await world.close()
    }

    // An Apex's message to a Fin refused on a rate limit keeps its retry across a normal restart: it goes at its time, not before.
    {
      let fin = ""
      const { world, faults } = worldOf(`${harness}-fin-429`)
      const apex = await world.apex("cursor", "full")
      const started = await world.agents.start(apex.caller, { brief: { objective: "Label" }, harness, name: "labels", clientKey: "labels", cwd: world.root })
      assert.ok(!("refused" in started) && started.conversation, JSON.stringify(started))
      fin = started.conversation!
      await until("the Fin to work", () => world.live.session(fin)?.status === "running")
      world.release(fin)
      await until("the Fin's brief", () => requestOf(world, fin, "fin:labels")?.status === "completed")
      faults.refuse.set(fin, "429 Too Many Requests")
      const sent = await world.agents.send(apex.caller, { to: "labels", text: "Carry on.", clientKey: "go" })
      assert.ok(!("refused" in sent), JSON.stringify(sent))
      await until(`${harness} Fin 429: it to wait`, () => requestOf(world, fin, "Carry on.")?.retry?.cause === "rate-limited")
      const due = requestOf(world, fin, "Carry on.")!.retry!.at
      await world.restart()
      await pause(500)
      assert.equal(requestOf(world, fin, "Carry on.")?.retry?.at, due, `${harness}: a restart keeps the retry and its time`)
      assert.equal(sentTimes(world, fin, "Carry on."), 0, `${harness}: nothing sends it before its time`)
      await goesOnce(world, fin, "Carry on.", `${harness} Fin 429`)
      await world.close()
    }

    // A Stop, the Apex's, the person's from the Apex's Fins or the person's own, ends a message's wait to go again: nothing sends after it, nor after a restart.
    // A Stop while a message is still being prepared latches it: its 429, coming back after the Stop, holds it as the
    // Stop's pause, never to go by itself; and a preparation that succeeds after the Stop sends nothing (`handOff`).
    for (const [stop, outcome] of (["apex", "person-fin", "person"] as const).flatMap((stop) => (["429", "prepared"] as const).map((outcome) => [stop, outcome] as const))) {
      let answer: ((words: string | undefined) => void) | undefined
      let late = false
      const world = new AgentsWorld({
        root: join(root, `${harness}-late-${stop}-${outcome}`),
        script,
        refusePrompt: () => (late ? new Promise<string | undefined>((resolve) => { answer = resolve }) : undefined),
      })
      const apex = await world.apex("cursor", "full")
      const started = await world.agents.start(apex.caller, { brief: { objective: "Label" }, harness, name: "labels", clientKey: "labels", cwd: world.root })
      assert.ok(!("refused" in started) && started.conversation, JSON.stringify(started))
      const fin = started.conversation!
      await until("the Fin to work", () => world.live.session(fin)?.status === "running")
      world.release(fin)
      await until("the Fin's brief", () => requestOf(world, fin, "fin:labels")?.status === "completed")
      late = true
      const sent = await world.agents.send(apex.caller, { to: "labels", text: "Carry on.", clientKey: "go" })
      assert.ok(!("refused" in sent), JSON.stringify(sent))
      await until(`${harness} late ${stop}: the send under way`, () => requestOf(world, fin, "Carry on.")?.status === "dispatching" && answer !== undefined)
      if (stop === "apex") await world.agents.stop(apex.caller, { child: "labels", reason: "enough" })
      else if (stop === "person-fin") assert.equal(await world.agents.stopChild(apex.conversation, world.store.journalPlacement(fin)!.thread), true)
      else await world.live.cancel(fin)
      answer!(outcome === "429" ? "429 Too Many Requests" : undefined)
      await until(`${harness} late ${stop} ${outcome}: its outcome`, () => requestOf(world, fin, "Carry on.")?.status === "held")
      assert.equal(requestOf(world, fin, "Carry on.")?.retry, undefined, `${harness} late ${stop} ${outcome}: an outcome after the Stop is no retry`)
      assert.equal(requestOf(world, fin, "Carry on.")?.pause, "stop")
      world.live.wakeDue(Date.now() + LATER)
      await pause(300)
      assert.equal(sentTimes(world, fin, "Carry on."), 0, `${harness} late ${stop} ${outcome}: nothing sends after the Stop`)
      await world.restart()
      world.live.wakeDue(Date.now() + LATER)
      await pause(500)
      assert.equal(sentTimes(world, fin, "Carry on."), 0, `${harness} late ${stop} ${outcome}: nor after a restart`)
      assert.equal(requestOf(world, fin, "Carry on.")?.pause, "stop")
      await world.close()
    }

    for (const stop of ["apex", "person-fin", "person"] as const) {
      const { world, faults } = worldOf(`${harness}-stop-${stop}`)
      const apex = await world.apex("cursor", "full")
      const started = await world.agents.start(apex.caller, { brief: { objective: "Label" }, harness, name: "labels", clientKey: "labels", cwd: world.root })
      assert.ok(!("refused" in started) && started.conversation, JSON.stringify(started))
      const fin = started.conversation!
      await until("the Fin to work", () => world.live.session(fin)?.status === "running")
      world.release(fin)
      await until("the Fin's brief", () => requestOf(world, fin, "fin:labels")?.status === "completed")
      faults.refuse.set(fin, "429 Too Many Requests")
      const sent = await world.agents.send(apex.caller, { to: "labels", text: "Carry on.", clientKey: "go" })
      assert.ok(!("refused" in sent), JSON.stringify(sent))
      await until(`${harness} ${stop}: it to wait`, () => requestOf(world, fin, "Carry on.")?.retry?.cause === "rate-limited")
      if (stop === "apex") await world.agents.stop(apex.caller, { child: "labels", reason: "enough" })
      else if (stop === "person-fin") assert.equal(await world.agents.stopChild(apex.conversation, world.store.journalPlacement(fin)!.thread), true)
      else await world.live.cancel(fin)
      assert.equal(requestOf(world, fin, "Carry on.")?.retry, undefined, `${harness} ${stop}: the Stop ends its wait`)
      assert.equal(requestOf(world, fin, "Carry on.")?.pause, "stop")
      world.live.wakeDue(Date.now() + LATER)
      await pause(300)
      assert.equal(sentTimes(world, fin, "Carry on."), 0, `${harness} ${stop}: nothing sends after a Stop`)
      await world.restart()
      world.live.wakeDue(Date.now() + LATER)
      await pause(500)
      assert.equal(sentTimes(world, fin, "Carry on."), 0, `${harness} ${stop}: nor after a restart`)
      assert.equal(requestOf(world, fin, "Carry on.")?.status, "held")
      await world.close()
    }

    // A message refused unsent on a rate limit goes again after Mako's normal restart; once the person closes the session, nothing waits to go.
    {
      const { world, faults } = worldOf(`${harness}-restart`)
      const { conversation } = await world.apex(harness, "full")
      world.say(conversation, "First.")
      await until("the first turn", () => requestOf(world, conversation, "First.")?.status === "completed")
      faults.refuse.set(conversation, "429 Too Many Requests")
      world.say(conversation, "Second.")
      await until(`${harness} restart: it to wait`, () => requestOf(world, conversation, "Second.")?.status === "held")
      await world.restart()
      assert.equal(requestOf(world, conversation, "Second.")?.retry?.cause, "rate-limited", `${harness}: the next host keeps it waiting to go again`)
      await goesOnce(world, conversation, "Second.", `${harness} restart`)
      faults.refuse.set(conversation, "429 Too Many Requests")
      world.say(conversation, "Third.")
      await until(`${harness} close: it to wait`, () => requestOf(world, conversation, "Third.")?.status === "held")
      await world.live.close(conversation)
      assert.equal(requestOf(world, conversation, "Third.")?.retry, undefined, "the person's close stops it waiting to go")
      world.live.wakeDue(Date.now() + LATER)
      await pause(300)
      assert.equal(sentTimes(world, conversation, "Third."), 0, "nothing sends it after the person closed the session")
      await world.close()
    }

    // A failure only the person can fix fails at once, as before: its card says what to do.
    {
      const { world, faults } = worldOf(`${harness}-permanent`)
      const conversation = await asleep(world, harness)
      faults.start.set(conversation, "The model API refused the request: encrypted_content could not be verified")
      world.say(conversation, "Second.")
      await until(`${harness} permanent: it to fail`, () => requestOf(world, conversation, "Second.")?.status === "failed")
      assert.equal(requestOf(world, conversation, "Second.")?.failure, "transcript-rejected")
      assert.equal(requestOf(world, conversation, "Second.")?.retry, undefined)
      await world.close()
    }
    console.log(`${harness}: a wake on capacity, the service, the network, a stalled start or a session open elsewhere waited and went once; an Apex woken for a Fin's report too; a refused prompt went again; a turn failed partway continued by itself or gave way to a new message; a first start and a transfer at capacity went again once; a permanent failure, wrapped or not, failed at once; the person's order held; a retry survived a restart and stopped at the person's close`)
  }
} finally {
  rmSync(root, { recursive: true, force: true })
}
console.log("delivery retry: ok")
