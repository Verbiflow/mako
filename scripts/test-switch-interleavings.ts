import assert from "node:assert/strict"
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import type { LiveRequest, LiveSnapshot } from "@mako/host/contracts/live-conversations"
import type { ContextTransfer } from "@mako/host/contracts/conversation-control"
import { ActorSchema } from "@mako/host/contracts/thread-identity"
import { AgentsWorld, type WorldOptions } from "./lib/agents-world.ts"

/**
 * Switches against the queue, generated (`npm run test:switch-interleavings`): seeded schedules over a switch opening,
 * committing, its source closing or refusing to, a second switch, Stop, Resume, an edit, a removal, Clear Queue, a row
 * carried to the cloud, a remote cancel, a new message, a crash, a restart and an agent's quiet move, with the rules of
 * `docs/delivery-queue.md` checked after every step: nothing sends after a Stop until it's resumed, no binding comes
 * after a Stop that nobody asked for since, no acknowledged edit or accepted message is lost, at most one switch is in
 * flight, and the conversation always has a binding it can use. `SEED=n` runs one schedule, `PINNED=n` one pinned one; a schedule a
 * review or a failure found is pinned in `PINNED`, with what it found, and runs first.
 */
const HOUR = 3_600_000
const SCHEDULES = Number(process.env.SCHEDULES ?? 160)
const SEED = process.env.SEED === undefined ? undefined : Number(process.env.SEED)
const ONLY_PINNED = process.env.PINNED === undefined ? undefined : Number(process.env.PINNED)

type Step =
  | { kind: "switch"; to: string }
  | { kind: "move"; to: string }
  | { kind: "open" }
  | { kind: "open-fail" }
  | { kind: "close-ok" }
  | { kind: "close-fail"; forNow?: true }
  | { kind: "later" }
  | { kind: "stop" }
  | { kind: "resume" }
  | { kind: "edit" }
  | { kind: "pause-edit" }
  | { kind: "delete" }
  | { kind: "clear" }
  | { kind: "carried" }
  | { kind: "remote-cancel" }
  | { kind: "message" }
  | { kind: "crash" }
  | { kind: "restart" }

const steps = (...kinds: Step[]): Step[] => kinds
const PINNED: { name: string; steps: Step[] }[] = [
  {
    name: "pr-review round 7: a second switch accepted while the first closes, Stop, the first close fails",
    steps: steps({ kind: "switch", to: "cursor" }, { kind: "open" }, { kind: "switch", to: "grok" }, { kind: "stop" }, { kind: "close-fail" }),
  },
  {
    name: "pr-review round 7: Stop, an edit of the first switch's own message, its close fails",
    steps: steps({ kind: "switch", to: "cursor" }, { kind: "open" }, { kind: "stop" }, { kind: "edit" }, { kind: "close-fail" }, { kind: "restart" }),
  },
  {
    name: "a message removed while its source closes stays removed when the close fails",
    steps: steps({ kind: "switch", to: "cursor" }, { kind: "open" }, { kind: "delete" }, { kind: "close-fail" }, { kind: "close-ok" }),
  },
  {
    name: "a message being edited across a failed close stays the person's",
    steps: steps({ kind: "switch", to: "cursor" }, { kind: "open" }, { kind: "pause-edit" }, { kind: "close-fail" }, { kind: "edit" }),
  },
  {
    name: "a switch whose close failed for now goes again with the person's edit, its row adopted and sent once",
    steps: steps({ kind: "switch", to: "cursor" }, { kind: "open" }, { kind: "edit" }, { kind: "close-fail", forNow: true }, { kind: "later" }, { kind: "open" }, { kind: "close-ok" }),
  },
  {
    name: "a message removed while its source closes doesn't go when the close failed for now",
    steps: steps({ kind: "switch", to: "cursor" }, { kind: "open" }, { kind: "delete" }, { kind: "close-fail", forNow: true }, { kind: "later" }),
  },
  {
    name: "a Stop while a move opens retires it: no binding comes after the Stop",
    steps: steps({ kind: "move", to: "cursor" }, { kind: "stop" }, { kind: "open" }, { kind: "close-ok" }),
  },
  {
    name: "a Stop while a move closes its source: committed, it completes",
    steps: steps({ kind: "move", to: "cursor" }, { kind: "open" }, { kind: "stop" }, { kind: "close-ok" }),
  },
  {
    name: "a Stop, then a move's close fails: it's put back and doesn't go again",
    steps: steps({ kind: "message" }, { kind: "move", to: "cursor" }, { kind: "open" }, { kind: "stop" }, { kind: "close-fail" }, { kind: "later" }),
  },
  {
    name: "a move ahead of a queued message, which goes on its destination once",
    steps: steps({ kind: "message" }, { kind: "move", to: "grok" }, { kind: "open" }, { kind: "close-ok" }),
  },
  {
    name: "a move behind a switch that's closing its source",
    steps: steps({ kind: "switch", to: "cursor" }, { kind: "open" }, { kind: "move", to: "grok" }, { kind: "close-ok" }, { kind: "open" }, { kind: "close-ok" }),
  },
  {
    name: "a crash under a move",
    steps: steps({ kind: "move", to: "cursor" }, { kind: "crash" }, { kind: "message" }),
  },
  {
    name: "pr-review round 10: Clear Queue takes a stopped switch's row, and the switch with it, so the next message goes",
    steps: steps({ kind: "switch", to: "cursor" }, { kind: "stop" }, { kind: "open" }, { kind: "clear" }, { kind: "message" }),
  },
  {
    name: "pr-review round 10: a row carried to the cloud takes its switch with it, so the next message goes",
    steps: steps({ kind: "switch", to: "cursor" }, { kind: "stop" }, { kind: "open" }, { kind: "carried" }, { kind: "message" }),
  },
  {
    name: "a remote cancel of a stopped switch's row takes the switch with it, so the next message goes",
    steps: steps({ kind: "switch", to: "cursor" }, { kind: "stop" }, { kind: "open" }, { kind: "remote-cancel" }, { kind: "message" }),
  },
  {
    name: "seed 24, as generated then: a resume releases a held switch ahead of the one under way, which stays next, one at a time",
    steps: steps({ kind: "switch", to: "cursor" }, { kind: "stop" }, { kind: "open-fail" }, { kind: "switch", to: "grok" }, { kind: "resume" }, { kind: "open" }, { kind: "close-ok" }),
  },
  {
    name: "a crash while a stopped switch's message waits in the queue",
    steps: steps({ kind: "switch", to: "cursor" }, { kind: "stop" }, { kind: "open" }, { kind: "edit" }, { kind: "crash" }, { kind: "resume" }),
  },
]

function random(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
  }
}

function schedule(next: () => number): Step[] {
  const pick = <T,>(items: readonly T[]) => items[Math.floor(next() * items.length)]!
  const made: Step[] = [next() < 0.3 ? { kind: "move", to: pick(["cursor", "grok", "codex"]) } : { kind: "switch", to: pick(["cursor", "grok", "codex"]) }]
  for (let at = 1; at < 14; at += 1) {
    const roll = next()
    if (roll < 0.09) made.push({ kind: "switch", to: pick(["cursor", "grok", "codex", "claude"]) })
    else if (roll < 0.14) made.push({ kind: "move", to: pick(["cursor", "grok", "codex", "claude"]) })
    else if (roll < 0.3) made.push({ kind: "open" })
    else if (roll < 0.33) made.push({ kind: "open-fail" })
    else if (roll < 0.43) made.push({ kind: "close-ok" })
    else if (roll < 0.5) made.push({ kind: "close-fail" })
    else if (roll < 0.53) made.push({ kind: "close-fail", forNow: true })
    else if (roll < 0.55) made.push({ kind: "later" })
    else if (roll < 0.66) made.push({ kind: "stop" })
    else if (roll < 0.75) made.push({ kind: "resume" })
    else if (roll < 0.84) made.push({ kind: "edit" })
    else if (roll < 0.87) made.push({ kind: "pause-edit" })
    else if (roll < 0.89) made.push({ kind: "delete" })
    else if (roll < 0.9) made.push({ kind: "clear" })
    else if (roll < 0.91) made.push({ kind: "carried" })
    else if (roll < 0.92) made.push({ kind: "remote-cancel" })
    else if (roll < 0.95) made.push({ kind: "message" })
    else if (roll < 0.98) made.push({ kind: "crash" })
    else made.push({ kind: "restart" })
  }
  return made
}

interface Gate {
  resolve(): void
  reject(error: Error): void
}

/** A switch's destination opening and its source closing, each until a step lets it. */
interface Gates {
  open: Gate[]
  close: Gate[]
}

/** What this schedule accepted: a piece of work the person gave Mako, under the words it now has. */
interface Work {
  id: string
  words: string
  /** Words acknowledged and then replaced: they must never go. */
  was: string[]
  gone: boolean
  /** The Stop that holds it, until a resume or nothing. */
  stopped: boolean
  /** How many times its words reached a harness: once at most. */
  sent: number
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const sentWords = (text: string, words: string) => text.includes(words)

class Schedule {
  private readonly gates: Gates = { open: [], close: [] }
  private world: AgentsWorld
  private readonly work: Work[] = []
  private conversation = ""
  private seenPrompts = 0
  private root: string
  /** Prompts every host of this schedule delivered, across crashes. */
  private readonly delivered: string[] = []
  private readonly trace: string[] = []
  private inFlight = 0
  private worstInFlight = 0
  private serial = 0
  private readonly next: () => number

  /** Some steps of a generated schedule land before the last has settled; a pinned one's each land where it says. */
  constructor(root: string, next: () => number, private readonly hurried: boolean) {
    this.root = root
    this.next = next
    this.world = new AgentsWorld(this.options(root))
  }

  private options(root: string): WorldOptions {
    const gate = (into: Gate[]) => new Promise<void>((resolve, reject) => into.push({ resolve, reject }))
    return {
      root,
      script: () => "Done",
      starting: async (conversation) => {
        // A conversation's own start isn't a switch; everything after it opens under the schedule's hand.
        if (conversation === this.conversation || !this.conversation) return
        this.inFlight += 1
        this.worstInFlight = Math.max(this.worstInFlight, this.inFlight)
        try {
          await gate(this.gates.open)
        } finally {
          this.inFlight -= 1
        }
      },
      closing: async () => {
        // A switch retiring its source: a host's exit closes what it has at once.
        if (!this.exiting) await gate(this.gates.close)
      },
      resumeVerdict: async () => ({ kind: "resumable", record: "same" }),
    }
  }

  private exiting = false
  /** The bindings there were at the last Stop, until someone asks for something since: no other may come. */
  private stopped: Set<string> | undefined

  get snapshot(): LiveSnapshot {
    return this.world.live.snapshot(this.conversation)!
  }

  async begin(): Promise<void> {
    const { conversation } = await this.world.apex("claude", "full")
    this.conversation = conversation
    await this.quiet()
  }

  /** Whether it was accepted: one refused to its sender's face was not. */
  private accept(words: string, send: (id: string) => void): boolean {
    const id = randomUUID()
    const work: Work = { id, words, was: [], gone: false, stopped: false, sent: 0 }
    try {
      send(id)
      this.work.push(work)
      return true
    } catch {
      return false
    }
  }

  private unsent(): Work[] {
    return this.work.filter((work) => !work.gone && !work.sent)
  }

  /** The row of `work`, as the queue holds it now. */
  private row(work: Work): LiveRequest | undefined {
    return this.snapshot.requests.find((request) => request.id === work.id)
  }

  async apply(step: Step): Promise<void> {
    this.trace.push(JSON.stringify(step))
    const live = this.world.live
    const id = this.conversation
    const pick = <T,>(items: readonly T[]) => items[Math.floor(this.next() * items.length)]
    const rows = () => this.unsent().filter((work) => { const row = this.row(work); return row?.status === "queued" || row?.status === "held" })
    switch (step.kind) {
      case "move":
        this.stopped = undefined
        // Refused to its asker's face (another switch is pending): nothing was accepted.
        await this.world.continueOn(id, { kind: "move", move: { id: randomUUID(), to: { harness: step.to } } }, ActorSchema.parse(this.world.caller(id))).catch(() => undefined)
        break
      case "switch":
        this.stopped = undefined
        this.accept(`switch-${(this.serial += 1)} to ${step.to}.`, (request) => live.transfer(id, { id: request, provider: step.to, text: `switch-${this.serial} to ${step.to}.`, attachments: [] }))
        break
      case "open":
        this.gates.open.shift()?.resolve()
        break
      case "open-fail":
        this.gates.open.shift()?.reject(new Error("The destination could not start"))
        break
      case "close-ok":
        for (const gate of this.gates.close.splice(0)) gate.resolve()
        break
      case "close-fail":
        // One error for the closes of one switch: `Promise.all` takes the first.
        for (const gate of this.gates.close.splice(0)) gate.reject(new Error(step.forNow ? "[unavailable] Server at capacity" : "synthetic source close failed"))
        break
      // A retry's time comes.
      case "later":
        live.wakeDue(Date.now() + HOUR)
        break
      case "stop":
        this.stopped ??= new Set(this.snapshot.control!.bindings.map((binding) => binding.id))
        await live.cancel(id)
        for (const work of this.unsent()) work.stopped = true
        break
      case "resume": {
        const work = pick(rows().filter((candidate) => this.row(candidate)?.status === "held"))
        if (!work) break
        const row = this.row(work)!
        // Under an open edit, the row's Resume is the person's own word for it too.
        live.editQueued(id, { requestId: work.id, expectedText: row.text, change: { kind: "resume" } })
        work.stopped = false
        this.stopped = undefined
        break
      }
      case "edit": {
        const work = pick(rows())
        if (!work) break
        const row = this.row(work)!
        const words = `edited-${(this.serial += 1)}.`
        try {
          live.editQueued(id, { requestId: work.id, expectedText: row.text, change: { kind: "edit", text: words } })
        } catch {
          break
        }
        work.was.push(work.words)
        work.words = words
        break
      }
      case "pause-edit": {
        const work = pick(rows())
        if (!work) break
        live.editQueued(id, { requestId: work.id, expectedText: this.row(work)!.text, change: { kind: "pause" } })
        break
      }
      case "delete": {
        const work = pick(rows())
        if (!work) break
        live.editQueued(id, { requestId: work.id, expectedText: this.row(work)!.text, change: { kind: "remove" } })
        work.gone = true
        break
      }
      case "clear":
        for (const work of rows()) work.gone = true
        live.clearQueue(id)
        break
      case "carried": {
        const work = pick(rows())
        if (!work) break
        live.carried(id, [work.id], "cloud")
        work.gone = true
        break
      }
      case "remote-cancel": {
        const work = pick(rows())
        if (!work) break
        await live.cancelRequest(id, work.id)
        // It reaches a queued row or a switch's: a plain held one stays, and goes on its Resume.
        work.gone = this.row(work)?.status !== "held"
        break
      }
      case "message": {
        this.stopped = undefined
        const waits = this.snapshot.control!.transfers.some((transfer) => (transfer.state.kind === "queued" || transfer.state.kind === "preparing") && this.snapshot.requests.find((request) => request.id === transfer.input.id)?.status !== "held")
        const taken = this.accept(`message-${(this.serial += 1)}.`, (request) => void live.submit(id, request, `message-${this.serial}.`, []))
        assert.ok(taken || waits, `a message was refused with no switch under way: ${JSON.stringify(this.snapshot.control!.transfers.map((transfer) => [transfer.input.text, transfer.state.kind]))}`)
        break
      }
      case "restart":
        await this.quit(() => this.world.restart())
        break
      case "crash":
        await this.crash()
        break
    }
    await this.quiet()
    this.check(step.kind)
  }

  /** A host's exit waits for what's under way: the gates let it finish, as a real exit's closes do. */
  private async quit(exit: () => Promise<void>): Promise<void> {
    this.exiting = true
    for (const gate of this.gates.open.splice(0)) gate.reject(new Error("the host stopped"))
    for (const gate of this.gates.close.splice(0)) gate.resolve()
    this.take()
    await exit()
    this.exiting = false
  }

  /**
   * SIGKILL at this moment: the journals as they stand are what the next host reads, so a copy taken between two steps
   * is what a killed process leaves, at a tenth of the cost of a child per crash. A transcript is written off the event
   * loop, its folder renamed from under a copy: `copyAsFound`, which `cpSync` isn't.
   */
  private async crash(): Promise<void> {
    this.take()
    const dead = this.world
    this.root = `${this.root}-c`
    copyAsFound(dead.root, this.root)
    this.exiting = true
    for (const gate of this.gates.open.splice(0)) gate.reject(new Error("the host stopped"))
    for (const gate of this.gates.close.splice(0)) gate.resolve()
    await dead.close().catch(() => undefined)
    this.exiting = false
    this.seenPrompts = 0
    this.world = new AgentsWorld(this.options(this.root))
  }

  /** Nothing has moved for a few milliseconds: what the last step started has gone as far as it goes without another. */
  private async quiet(): Promise<void> {
    if (this.hurried && this.next() < 0.15) return sleep(1).then(() => undefined)
    const reading = () => JSON.stringify([this.snapshot?.requests.map((request) => [request.id, request.status]), this.snapshot?.control?.transfers.map((transfer) => transfer.state.kind), this.world.prompts.length, this.gates.open.length, this.gates.close.length])
    let last = reading()
    for (let calm = 0, rounds = 0; calm < 4 && rounds < 200; rounds += 1) {
      await sleep(4)
      const now = reading()
      calm = now === last ? calm + 1 : 0
      last = now
    }
  }

  /** Takes what the harnesses were sent since the last look. */
  private take(): void {
    const prompts = this.world.prompts.filter((prompt) => prompt.conversation === this.conversation).slice(this.seenPrompts)
    this.seenPrompts += prompts.length
    for (const prompt of prompts) {
      this.delivered.push(prompt.text)
      for (const work of this.work) {
        for (const old of work.was) assert.ok(!sentWords(prompt.text, old), `replaced words went: ${old}`)
        if (work.gone) assert.ok(!sentWords(prompt.text, work.words), `removed words went: ${work.words}`)
        if (!sentWords(prompt.text, work.words)) continue
        assert.ok(!work.stopped, `sent after a Stop with no resume: ${work.words}`)
        work.sent += 1
        assert.equal(work.sent, 1, `sent twice: ${work.words}`)
      }
    }
  }

  private check(when: string): void {
    this.take()
    const snapshot = this.snapshot
    const control = snapshot.control!
    const label = (what: string) => `after ${when}: ${what}`
    // At most one switch in flight, and only ever one under way on the record.
    const underWay = control.transfers.filter((transfer) => transfer.state.kind === "preparing")
    assert.ok(underWay.length <= 1, label(`${underWay.length} switches preparing at once`))
    assert.ok(this.worstInFlight <= 1, label(`${this.worstInFlight} destinations opening at once`))
    // Always a binding the conversation can use.
    assert.ok(control.bindings.some((binding) => binding.id === control.activeBindingId), label(`the active binding ${control.activeBindingId} isn't one of its bindings`))
    // No binding comes after a Stop that nobody asked for since: what wasn't committed stays uncommitted.
    if (this.stopped) assert.ok(this.stopped.has(control.activeBindingId), label(`a binding came after a Stop: ${control.activeBindingId}, of ${[...this.stopped].join(", ")}`))
    // Nothing accepted is lost: its words are in the queue, on the switch that carries them, or were sent.
    for (const work of this.unsent()) {
      const queued = snapshot.requests.some((request) => request.text === work.words && request.status !== "canceled")
      const carried = control.transfers.some((transfer: ContextTransfer) => transfer.input.text === work.words)
      assert.ok(queued || carried, label(`accepted words are nowhere: ${work.words}: ${JSON.stringify({ requests: snapshot.requests.map((request) => [request.text, request.status]), transfers: control.transfers.map((transfer) => [transfer.input.text, transfer.state.kind]) })}`))
    }
    // A switch waiting has its message in the queue, or still its own: whatever took that row took the switch with it.
    for (const transfer of control.transfers) {
      if (transfer.state.kind !== "queued" && transfer.state.kind !== "preparing") continue
      const row = snapshot.requests.find((request) => request.id === transfer.input.id)
      assert.ok(!row || row.status === "queued" || row.status === "held", label(`a switch outlived its message: ${transfer.input.text} is ${row?.status}`))
    }
    // One home for its message: a switch that failed for good doesn't leave a copy in the queue that its retry would send twice.
    for (const transfer of control.transfers) {
      if (transfer.state.kind !== "failed") continue
      const row = snapshot.requests.find((request) => request.id === transfer.input.id)
      assert.ok(!row || (row.status !== "queued" && row.status !== "held"), label(`a failed switch's message still waits in the queue: ${transfer.input.text}`))
    }
  }

  /** Every gate opens and every held message resumes: what's left goes, once, and the conversation still takes a message. */
  async finish(): Promise<void> {
    this.stopped = undefined
    const live = this.world.live
    const id = this.conversation
    for (let round = 0; round < 120; round += 1) {
      for (const gate of this.gates.open.splice(0)) gate.resolve()
      for (const gate of this.gates.close.splice(0)) gate.resolve()
      for (const work of this.unsent()) {
        const row = this.row(work)
        if (row?.status === "held") {
          live.editQueued(id, { requestId: work.id, expectedText: row.text, change: { kind: "resume" } })
          work.stopped = false
        }
      }
      live.wakeDue(Date.now() + HOUR)
      await sleep(10)
      this.check(`finishing (${round})`)
      const moving = this.snapshot.session.status === "running" || this.snapshot.requests.some((request) => request.status === "queued" || request.status === "dispatching") || this.snapshot.control!.transfers.some((transfer) => transfer.state.kind === "queued" || transfer.state.kind === "preparing")
      if (!moving && !this.gates.open.length && !this.gates.close.length) break
    }
    const left = this.snapshot
    assert.ok(!left.requests.some((request) => request.status === "queued" || request.status === "held"), `the queue emptied: ${JSON.stringify(left.requests.map((request) => [request.text, request.status]))}`)
    const words = `last-${randomUUID()}.`
    await this.settled()
    live.submit(id, randomUUID(), words, [])
    for (let round = 0; round < 300 && !this.world.prompts.some((prompt) => prompt.text.includes(words)); round += 1) {
      for (const gate of [...this.gates.open.splice(0), ...this.gates.close.splice(0)]) gate.resolve()
      await sleep(10)
    }
    assert.ok(this.world.prompts.some((prompt) => prompt.text.includes(words)), `the conversation takes a message at the end: ${JSON.stringify({ session: this.snapshot.session.status, transfers: this.snapshot.control!.transfers.map((transfer) => transfer.state.kind) })}`)
  }

  private async settled(): Promise<void> {
    for (let round = 0; round < 300 && this.world.live.snapshot(this.conversation)?.session.status === "running"; round += 1) await sleep(5)
  }

  dump(): string {
    return this.trace.join("\n  ")
  }

  async end(): Promise<void> {
    this.exiting = true
    for (const gate of [...this.gates.open.splice(0), ...this.gates.close.splice(0)]) gate.resolve()
    await this.world.close()
  }
}

/** A folder as it stands: what a write moves away during the copy is what a killed process wouldn't have left there. */
function copyAsFound(from: string, to: string): void {
  mkdirSync(to, { recursive: true })
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    try {
      if (entry.isDirectory()) copyAsFound(join(from, entry.name), join(to, entry.name))
      else copyFileSync(join(from, entry.name), join(to, entry.name))
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error
    }
  }
}

async function run(name: string, root: string, seed: number, made?: Step[]): Promise<void> {
  const next = random(seed)
  const plan = made ?? schedule(next)
  const each = new Schedule(root, next, !made)
  try {
    await each.begin()
    for (const step of plan) await each.apply(step)
    await each.finish()
  } catch (error) {
    throw new Error(`${name}: ${error instanceof Error ? error.message : String(error)}\n  ${each.dump()}`, { cause: error })
  } finally {
    await each.end()
  }
}

const root = mkdtempSync(join(tmpdir(), "mako-switch-interleavings-"))
try {
  if (SEED !== undefined) await run(`seed ${SEED}`, join(root, `seed-${SEED}`), SEED)
  else {
    for (const [at, pinned] of PINNED.entries()) {
      if (ONLY_PINNED === undefined || ONLY_PINNED === at) await run(pinned.name, join(root, `pinned-${at}`), at + 1, pinned.steps)
    }
    if (ONLY_PINNED !== undefined) process.exit(0)
    for (let seed = 1; seed <= SCHEDULES; seed += 1) await run(`seed ${seed}`, join(root, `seed-${seed}`), seed)
  }
} finally {
  rmSync(root, { recursive: true, force: true })
}

console.log(`switch interleavings: ${PINNED.length} pinned and ${SCHEDULES} generated schedules; nothing sent after a Stop, no edit or message lost, one switch in flight, always a usable binding`)
