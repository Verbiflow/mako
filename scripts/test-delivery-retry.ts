import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { GIVE_UP_MS, nextRetry, RETRY_STEPS_MS, transientCause, type RetryCause } from "@mako/host/contracts/delivery-retry"
import { classifyProviderFailure } from "@mako/host/contracts/provider-failure"
import type { LiveRequest } from "@mako/host/contracts/live-conversations"
import { FROM_AGENTS } from "@mako/host/conversations/agent-wakes"
import { AgentsWorld, HARNESSES, type Script } from "./lib/agents-world.ts"

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
    for (const { cause, error } of CAUSES) {
      const { world, faults } = worldOf(`${harness}-${cause}`)
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
      await until(`${harness} apex: the wake for the report to wait`, () => requestOf(world, apex.conversation, FROM_AGENTS)?.status === "held", 10_000)
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
    console.log(`${harness}: a wake on capacity, the service, the network, a stalled start or a session open elsewhere waited and went once; an Apex woken for a Fin's report too; a refused prompt went again; a turn failed partway continued by itself or gave way to a new message; a permanent failure failed at once`)
  }
} finally {
  rmSync(root, { recursive: true, force: true })
}
console.log("delivery retry: ok")
