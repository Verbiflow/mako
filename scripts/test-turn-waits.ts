import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ThreadStore } from "../packages/host/src/threads/store.ts"
import { TurnWaits, type TurnWaitsDeps } from "../packages/host/src/conversations/turn-waits.ts"
import { turnWaitLine, WAIT_HORIZON_MAX_S, type TurnWait, type TurnWaitItem } from "../packages/host/src/contracts/turn-waits.ts"

/*
 * A turn's wait (`conversations/turn-waits.ts`) on a real Thread store and a fake clock: armed, met item by item,
 * timed, fired once, and its note delivered once across a host's restart, a cancel racing the fire, and a sleep.
 * Each "host" is a new `TurnWaits` on the same store file, as a restarted host is.
 */

const T0 = Date.parse("2026-11-15T09:00:00Z")
const CONVERSATION = "conv-1"
const THREAD = "thread-1"
const CI: TurnWaitItem = { kind: "pull", pull: "acme/app#412", until: "checks" }
const DOCS: TurnWaitItem = { kind: "fin", fin: "fin-thread-docs", name: "docs" }

class Clock {
  now = T0
  private timers: { at: number; fire: () => void; on: boolean }[] = []
  timer = (at: number, fire: () => void) => {
    const timer = { at, fire, on: true }
    this.timers.push(timer)
    return () => { timer.on = false }
  }
  /** Moves time on, firing each timer due on the way, as an awake host's timers would. */
  advance(ms: number): void {
    const end = this.now + ms
    for (;;) {
      const due = this.timers.filter((timer) => timer.on && timer.at <= end).sort((a, b) => a.at - b.at)[0]
      if (!due) break
      due.on = false
      this.now = Math.max(this.now, due.at)
      due.fire()
    }
    this.now = end
  }
  /** Moves time on with no timer firing: a host asleep, or off. */
  sleep(ms: number): void {
    this.now += ms
  }
  pending(): number {
    return this.timers.filter((timer) => timer.on).length
  }
}

interface Host {
  waits: TurnWaits
  sent: TurnWait[]
  answer: "taken" | "later" | "hang"
}

function host(store: ThreadStore, clock: Clock, answer: Host["answer"] = "taken"): Host {
  const made: Host = { waits: undefined!, sent: [], answer }
  const deps: TurnWaitsDeps = {
    store: () => store,
    now: () => clock.now,
    timer: clock.timer,
    deliver: async (wait) => {
      made.sent.push(wait)
      if (made.answer === "hang") return new Promise<never>(() => {})
      return made.answer
    },
  }
  made.waits = new TurnWaits(deps)
  return made
}

function refusal(result: ReturnType<TurnWaits["arm"]>): string | undefined {
  return "refused" in result ? result.refused : undefined
}

function armed(result: ReturnType<TurnWaits["arm"]>): TurnWait {
  assert.ok("wait" in result, JSON.stringify(result))
  return result.wait
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

function withStore(name: string, run: (path: string) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "turn-waits-"))
  const path = join(root, "threads.sqlite")
  return run(path).then(
    () => {
      rmSync(root, { recursive: true, force: true })
      process.stdout.write(`ok ${name}\n`)
    },
    (error) => {
      rmSync(root, { recursive: true, force: true })
      throw new Error(`${name}: ${error instanceof Error ? error.stack : String(error)}`)
    },
  )
}

const open = (path: string) => new ThreadStore(path, { realPath: (each) => each })

await withStore("arming refuses what can never end, and past seven days", async (path) => {
  const store = open(path)
  const clock = new Clock()
  const { waits } = host(store, clock)
  const base = { conversation: CONVERSATION, thread: THREAD, clientKey: "k", description: "Waiting" }
  assert.equal(refusal(waits.arm({ ...base })), "never")
  assert.equal(refusal(waits.arm({ ...base, at: T0 - 1 })), "never")
  assert.equal(refusal(waits.arm({ ...base, seconds: WAIT_HORIZON_MAX_S + 1 })), "too-long")
  assert.equal(refusal(waits.arm({ ...base, seconds: 5, at: T0 + 5_000 })), "invalid")
  assert.equal(refusal(waits.arm({ ...base, description: "  ", seconds: 5 })), "invalid")
  assert.equal(refusal(waits.arm({ ...base, items: [CI, CI] })), "invalid")
  const done = waits.arm({ ...base, items: [CI], met: { "pull:acme/app#412": { at: T0, words: "checks settled" } } })
  assert.ok("alreadyDone" in done, "met as it arms: nothing armed")
  assert.equal(store.armedTurnWaits().length, 0)
  assert.ok("wait" in waits.arm({ ...base, seconds: WAIT_HORIZON_MAX_S }), "exactly seven days is allowed")
  store.close()
})

await withStore("a repeat finds the same wait; a newer one replaces it; the line clears by itself", async (path) => {
  const store = open(path)
  const clock = new Clock()
  const { waits } = host(store, clock)
  const first = armed(waits.arm({ conversation: CONVERSATION, thread: THREAD, clientKey: "a", description: "Waiting for CI on #412", items: [CI] }))
  const again = waits.arm({ conversation: CONVERSATION, thread: THREAD, clientKey: "a", description: "Waiting for CI on #412", items: [CI] })
  assert.ok("existed" in again && again.existed && again.wait.id === first.id)
  assert.deepEqual(turnWaitLine(store.armedTurnWaitOf(CONVERSATION)!)?.items, [{ words: "acme/app#412 checks", met: false }])
  const second = waits.arm({ conversation: CONVERSATION, thread: THREAD, clientKey: "b", description: "Waiting an hour", seconds: 3600 })
  assert.ok("replaced" in second && second.replaced.map((wait) => wait.id).join() === first.id)
  assert.equal(store.turnWait(first.id)?.cancelled?.by, "replaced")
  assert.equal(store.armedTurnWaitOf(CONVERSATION)?.id, second.wait.id)
  clock.advance(3600_000)
  await flush()
  assert.equal(store.armedTurnWaitOf(CONVERSATION), undefined, "fired: nothing armed, so no line")
  assert.equal(turnWaitLine(store.turnWait(second.wait.id)!), undefined)
  store.close()
})

await withStore("a restart between firing and delivery sends the same note once", async (path) => {
  const clock = new Clock()
  let store = open(path)
  const first = host(store, clock, "hang")
  const wait = armed(first.waits.arm({ conversation: CONVERSATION, thread: THREAD, clientKey: "ci", description: "Waiting for CI on #412", items: [CI] }))
  first.waits.met(wait.id, CI, "checks settled: all 9 passed")
  await flush()
  assert.equal(first.sent.length, 1, "handed over once")
  const request = first.sent[0]!.fired!.request
  // The host dies with the note handed to delivery and nothing confirmed.
  first.waits.stop()
  store.close()
  clock.advance(5_000)
  store = open(path)
  const second = host(store, clock)
  second.waits.met(wait.id, CI, "checks settled again")
  second.waits.start()
  await second.waits.settled()
  assert.equal(second.sent.length, 1, "the next start sends it once")
  assert.equal(second.sent[0]!.fired!.request, request, "under the same request, which the live queue takes once")
  assert.match(second.sent[0]!.fired!.text, /^Mako: the wait "Waiting for CI on #412" is over\.\n- acme\/app#412 checks: checks settled: all 9 passed$/)
  second.waits.stop()
  store.close()
  store = open(path)
  const third = host(store, clock)
  third.waits.start()
  await third.waits.settled()
  assert.equal(third.sent.length, 0, "delivered: never again")
  store.close()
})

await withStore("a host that stops between an item's met and its claim leaves nothing armed and met", async (path) => {
  const clock = new Clock()
  let store = open(path)
  const first = host(store, clock)
  const wait = armed(first.waits.arm({ conversation: CONVERSATION, thread: THREAD, clientKey: "ci", description: "Waiting for CI on #412", items: [CI] }))
  // What a build that wrote the two apart could leave: the item met, the wait still armed.
  store.noteTurnWaitMet(wait.id, "pull:acme/app#412", { at: clock.now, words: "checks settled: all 9 passed" })
  assert.equal(store.turnWait(wait.id)?.state, "armed")
  first.waits.stop()
  store.close()
  store = open(path)
  const second = host(store, clock)
  second.waits.start()
  second.waits.start()
  await second.waits.settled()
  assert.equal(second.sent.length, 1, "the next start fires and sends it, once")
  assert.match(second.sent[0]!.fired!.text, /- acme\/app#412 checks: checks settled: all 9 passed$/)
  second.waits.stop()
  store.close()
  store = open(path)
  const third = host(store, clock)
  third.waits.start()
  await third.waits.settled()
  assert.equal(third.sent.length, 0)
  // And the item that completes a wait claims it in the same write: nothing is left armed and met at any point.
  const met = armed(third.waits.arm({ conversation: "conv-2", thread: THREAD, clientKey: "docs", description: "Waiting for docs", items: [DOCS] }))
  third.waits.met(met.id, DOCS, "reported done")
  assert.equal(store.turnWait(met.id)?.state, "fired")
  store.close()
})

await withStore("a cancel racing the fire never delivers", async (path) => {
  const store = open(path)
  const clock = new Clock()
  // Before the claim: the cancel wins, nothing fires.
  const one = host(store, clock)
  const early = armed(one.waits.arm({ conversation: CONVERSATION, thread: THREAD, clientKey: "early", description: "Waiting for docs", items: [DOCS] }))
  one.waits.cancel(early.id, "person")
  one.waits.met(early.id, DOCS, "reported done")
  await one.waits.settled()
  assert.equal(one.sent.length, 0)
  // After the claim, before the handoff: retired, and its handoff refuses it.
  const two = host(store, clock, "hang")
  const late = armed(two.waits.arm({ conversation: "conv-2", thread: THREAD, clientKey: "late", description: "Waiting for docs", items: [DOCS] }))
  two.waits.met(late.id, DOCS, "reported done")
  await flush()
  assert.equal(two.sent.length, 1)
  const request = two.sent[0]!.fired!.request
  assert.equal(two.waits.admits(request), true, "goes while it holds")
  assert.equal(two.waits.cancel(late.id, "person")?.cancelled?.by, "person")
  assert.equal(two.waits.admits(request), false, "the handoff refuses it once cancelled")
  assert.equal(store.undeliveredTurnWaits().length, 0, "nothing for a start to send")
  two.waits.stop()
  const three = host(store, clock)
  three.waits.start()
  await three.waits.settled()
  assert.equal(three.sent.length, 0, "a restart doesn't send it either")
  // Delivered already: a cancel changes nothing.
  const four = host(store, clock)
  const done = armed(four.waits.arm({ conversation: "conv-3", thread: THREAD, clientKey: "done", description: "Waiting", items: [DOCS] }))
  four.waits.met(done.id, DOCS, "reported done")
  await four.waits.settled()
  assert.equal(four.sent.length, 1)
  assert.equal(four.waits.cancel(done.id, "person")?.cancelled, undefined)
  assert.equal(four.waits.admits(four.sent[0]!.fired!.request), true)
  store.close()
})

await withStore("two hosts on one store fire a wait once", async (path) => {
  const clock = new Clock()
  // An updating host and its successor both hold the store for a moment; each read the wait armed.
  const a = open(path)
  const b = open(path)
  const one = host(a, clock)
  const two = host(b, clock)
  const wait = armed(one.waits.arm({ conversation: CONVERSATION, thread: THREAD, clientKey: "shared", description: "Waiting a minute", seconds: 60 }))
  const stale = b.turnWait(wait.id)!
  const fired = { at: clock.now, why: "time" as const, request: "request-1", text: "Mako: done" }
  assert.equal(a.claimTurnWait(stale.id, fired).claimed, true)
  assert.equal(b.claimTurnWait(stale.id, { ...fired, request: "request-2" }).claimed, false, "the second claim loses")
  assert.equal(b.turnWait(wait.id)?.fired?.request, "request-1")
  two.waits.check()
  one.waits.check()
  await Promise.all([one.waits.settled(), two.waits.settled()])
  assert.equal(one.sent.length + two.sent.length, 0, "a claim made outside a host isn't re-fired by either")
  a.close()
  b.close()
})

await withStore("an all wait keeps its progress across a restart", async (path) => {
  const clock = new Clock()
  let store = open(path)
  const first = host(store, clock)
  const wait = armed(first.waits.arm({ conversation: CONVERSATION, thread: THREAD, clientKey: "both", description: "Waiting for CI and docs", items: [CI, DOCS], returnWhen: "all" }))
  first.waits.met(wait.id, DOCS, "reported done")
  assert.equal(first.sent.length, 0, "one of two: still waiting")
  assert.deepEqual(turnWaitLine(store.armedTurnWaitOf(CONVERSATION)!)?.items.map((item) => item.met), [false, true])
  first.waits.stop()
  store.close()
  store = open(path)
  const second = host(store, clock)
  second.waits.start()
  second.waits.met(wait.id, DOCS, "reported done again")
  assert.equal(second.sent.length, 0, "the same item twice is still one of two")
  second.waits.met(wait.id, CI, "checks settled: all 9 passed")
  await second.waits.settled()
  assert.equal(second.sent.length, 1)
  assert.match(second.sent[0]!.fired!.text, /- acme\/app#412 checks: checks settled: all 9 passed\n- fin:docs: reported done$/)
  second.waits.met(wait.id, CI, "again")
  await second.waits.settled()
  assert.equal(second.sent.length, 1, "fired once")
  store.close()
})

await withStore("a wait that comes due during sleep fires once on wake, saying it's late", async (path) => {
  const clock = new Clock()
  let store = open(path)
  const first = host(store, clock)
  const wait = armed(first.waits.arm({ conversation: CONVERSATION, thread: THREAD, clientKey: "nine", description: "Check the deploy at 9:30", at: T0 + 30 * 60_000 }))
  assert.equal(clock.pending(), 1, "one timer, at its end")
  clock.sleep(70 * 60_000)
  // Woken: the timer fires late, and the backstop job runs too.
  clock.advance(0)
  first.waits.check()
  await first.waits.settled()
  assert.equal(first.sent.length, 1, "once, whichever runs first")
  const fired = store.turnWait(wait.id)!.fired!
  assert.equal(fired.why, "time")
  assert.equal(fired.lateMs, 40 * 60_000)
  assert.match(fired.text, /^Mako: the time you waited for has come: "Check the deploy at 9:30" \(2026-11-15T09:30:00Z\)\.\nIt was due at 2026-11-15T09:30:00Z; this host was asleep or off until 2026-11-15T10:10:00Z, so this comes late\.$/)
  // Off rather than asleep: a new host's start fires what came due while it was down, once.
  const due = armed(first.waits.arm({ conversation: "conv-off", thread: THREAD, clientKey: "off", description: "Waiting ten minutes", seconds: 600 }))
  first.waits.stop()
  store.close()
  clock.sleep(3 * 60 * 60_000)
  store = open(path)
  const second = host(store, clock)
  second.waits.start()
  second.waits.start()
  await second.waits.settled()
  assert.equal(second.sent.filter((each) => each.id === due.id).length, 1)
  assert.match(store.turnWait(due.id)!.fired!.text, /this comes late/)
  // On time: no late line.
  const onTime = armed(second.waits.arm({ conversation: "conv-on", thread: THREAD, clientKey: "on", description: "Waiting a minute", seconds: 60 }))
  clock.advance(60_000)
  await second.waits.settled()
  assert.doesNotMatch(store.turnWait(onTime.id)!.fired!.text, /late/)
  store.close()
})

await withStore("a time with things to wait on is the cap: it fires with what's still pending", async (path) => {
  const store = open(path)
  const clock = new Clock()
  const { waits, sent } = host(store, clock)
  const wait = armed(waits.arm({ conversation: CONVERSATION, thread: THREAD, clientKey: "cap", description: "Waiting for CI and docs", items: [CI, DOCS], returnWhen: "all", seconds: 7200 }))
  waits.met(wait.id, DOCS, "reported done")
  clock.advance(7200_000)
  await waits.settled()
  assert.equal(sent.length, 1)
  assert.match(sent[0]!.fired!.text, /^Mako: stopped waiting for "Waiting for CI and docs": its time ran out at 2026-11-15T11:00:00Z\.\n- fin:docs: reported done\nStill pending: acme\/app#412 checks\.$/)
  // A note the conversation couldn't take waits for the next start, not lost.
  const later = host(store, clock, "later")
  const held = armed(later.waits.arm({ conversation: "conv-held", thread: THREAD, clientKey: "held", description: "Waiting", seconds: 1 }))
  clock.advance(1_000)
  await later.waits.settled()
  assert.equal(store.undeliveredTurnWaits().map((each) => each.id).join(), held.id)
  later.waits.cancelOf("conv-held", "move")
  assert.equal(store.turnWait(held.id)?.cancelled?.by, "move", "a move retires a note not yet delivered")
  store.close()
})
