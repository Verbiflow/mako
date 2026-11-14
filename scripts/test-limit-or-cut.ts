import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { STRANDED_AFTER_MS } from "@mako/host/contracts/turn-continuation"
import { ThreadIdSchema } from "@mako/host/contracts/thread-identity"
import { AgentsWorld, HARNESSES, TESTED_HARNESSES, type Script, type WorldAccount } from "./lib/agents-world.ts"

/**
 * A Fin's turn that stops early is either cut or at a limit, on each of the six harnesses (`npm run test:fin-fallback`).
 * A cut that wasn't a limit goes to its Apex, unless a Stop came first. A limit moves the Fin on, and never also reads
 * as a cut, whichever comes first. A decision that everything's spent stands only while what it was made on does.
 */

const root = mkdtempSync(join(tmpdir(), "mako-limit-or-cut-"))
const LIMIT = "You've hit your usage limit"
const RESET = Date.now() + 3 * 3_600_000
/** Past when a cut nothing picks up is looked at. */
const SETTLED_MS = STRANDED_AFTER_MS + 500
const CATALOGS = Object.fromEntries(HARNESSES.map((harness) => [harness, [{ id: `${harness}-model`, label: `${harness} model`, options: [] }]]))

async function until(what: string, done: () => boolean, ms = 15_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

interface Run {
  world: AgentsWorld
  fin: string
  child: ReturnType<typeof ThreadIdSchema.parse>
  caller: Awaited<ReturnType<AgentsWorld["apex"]>>["caller"]
  spent: WorldAccount
  /** Its harness refuses what it's sent, on this limit, from now on. */
  refusing: { words?: string }
}

/** An Apex on `harness` and one Fin at work there, its first turn held, or `first` deciding how it ends. */
async function fin(name: string, harness: string, first?: (spent: WorldAccount, end: (fail: string) => void) => void): Promise<Run> {
  const spent: WorldAccount = { name: "default" }
  const accounts = Object.fromEntries(HARNESSES.map((each): [string, WorldAccount[]] => [each, each === harness ? [spent] : [{ name: "default" }]]))
  const refusing: Run["refusing"] = {}
  let turns = 0
  const script: Script = (turn) => {
    if (!turn.text.includes("You're fin:") && turns === 0) return "ok"
    turns += 1
    if (turns > 1) return "Done."
    // A turn that's cut stops without answering.
    if (!first) return turn.world.hold(turn.conversation).then(() => {
      const session = turn.world.live.snapshot(turn.conversation)!.session
      turn.world.live.observe({ type: "live-session", session: { ...session, status: "ready", lastStop: "cancelled" } })
      return new Promise<string>(() => {})
    })
    first(spent, (fail) => turn.world.endWith(turn.conversation, { limit: { resetsAt: RESET }, fail }))
    return ""
  }
  const world = new AgentsWorld({ root: join(root, name), script, accounts, selected: Object.fromEntries(HARNESSES.map((each) => [each, "default"])), catalogs: CATALOGS, order: [...HARNESSES], refusePrompt: (_conversation, on) => (on === harness ? refusing.words : undefined) })
  const apex = await world.apex(harness, "auto")
  const started = await world.agents.start(apex.caller, { brief: { objective: "Label the snippets" }, harness, name: "labels", clientKey: "labels", cwd: world.root })
  assert.ok(!("refused" in started) && started.conversation, JSON.stringify(started))
  return { world, fin: started.conversation!, child: ThreadIdSchema.parse(started.child), caller: apex.caller, spent, refusing }
}

/**
 * A Fin whose account ran out with every other spent, while the read of them is held open: the person takes the waiting
 * message away and starts a turn of their own, and only then the read says there's nowhere to go.
 */
async function outOfAccountsLate(name: string, harness: string): Promise<void> {
  const held: WorldAccount[] = [{ name: "personal" }, { name: "work", spentUntil: RESET }]
  let out = () => {}
  const spent = new Promise<void>((resolve) => (out = resolve))
  let answer = () => {}
  const answered = new Promise<void>((resolve) => (answer = resolve))
  let reading = false
  let newer = false
  let turns = 0
  const script: Script = async (turn) => {
    if (turn.text.includes("New work.")) {
      newer = true
      return turn.world.hold(turn.conversation).then(() => "Done.")
    }
    if (!turn.text.includes("You're fin:") || (turns += 1) > 1) return "ok"
    await spent
    held[0]!.spentUntil = RESET
    turn.world.endWith(turn.conversation, { limit: { resetsAt: RESET }, fail: LIMIT })
    return "Partial."
  }
  const world = new AgentsWorld({
    root: join(root, name),
    script,
    accounts: { [harness]: held },
    selected: { [harness]: "personal" },
    catalogs: { [harness]: CATALOGS[harness]! },
    order: [harness],
    readingAccounts: async (_harness, all) => {
      if (!all) return
      reading = true
      await answered
    },
  })
  try {
    const apex = await world.apex(harness, "auto")
    const started = await world.agents.start(apex.caller, { brief: { objective: "Keep the work" }, harness, name: "one", clientKey: "one", cwd: world.root })
    assert.ok(!("refused" in started) && started.conversation, JSON.stringify(started))
    const conversation = started.conversation!
    await until(`${harness} late: the Fin to work`, () => world.live.session(conversation)?.status === "running")
    out()
    await until(`${harness} late: the move to read the accounts`, () => reading)
    const wait = world.live.snapshot(conversation)!.requests.find((request) => request.status === "held" && request.retry?.cause === "rate-limited")!
    world.live.editQueued(conversation, { requestId: wait.id, expectedText: wait.text, change: { kind: "remove" } })
    const mine = world.say(conversation, "New work.")
    await until(`${harness} late: their turn to start`, () => newer)
    answer()
    await pause(300)
    const edge = world.store.edges().of(ThreadIdSchema.parse(started.child))
    assert.equal(edge?.closedAt, undefined, `${harness} late: out of accounts doesn't stop a turn the person just started`)
    assert.equal(edge?.tuned?.rerouted?.line, undefined, `${harness} late: nor say it's out`)
    assert.equal(world.live.snapshot(conversation)!.requests.find((request) => request.id === mine)?.status, "dispatching", `${harness} late: their turn goes on`)
  } finally {
    out()
    answer()
    await world.close()
  }
}

const cutReports = (run: Run) => run.world.store.reportsOf(run.child, 0).filter((report) => report.summary.startsWith("Its turn was cut short"))
const elsewhere = (run: Run, harness: string) => run.world.prompts.filter((prompt) => prompt.conversation === run.fin && prompt.harness !== harness)
const moved = (run: Run) => run.world.store.edges().of(run.child)?.tuned?.rerouted?.to

try {
  for (const harness of TESTED_HARNESSES) {
    // A cut that wasn't a limit is its Apex's to hear, and nothing moves.
    {
      const run = await fin(`${harness}-cut`, harness)
      await until(`${harness} cut: the Fin to work`, () => run.world.live.session(run.fin)?.status === "running")
      await run.world.live.handOff(run.fin)
      await until(`${harness} cut: its Apex to hear it`, () => cutReports(run).length === 1, SETTLED_MS + 5_000)
      assert.equal(moved(run), undefined, `${harness} cut: it moves nowhere`)
      assert.equal(elsewhere(run, harness).length, 0, `${harness} cut: nothing goes elsewhere`)
      await run.world.close()
    }

    // A turn that ended on a limit moves on, and is no cut.
    {
      const run = await fin(`${harness}-limit`, harness, (spent, end) => {
        spent.spentUntil = RESET
        end(LIMIT)
      })
      await until(`${harness} limit: it to go on`, () => elsewhere(run, harness).length === 1)
      assert.ok(moved(run), `${harness} limit: it moved`)
      await pause(SETTLED_MS)
      assert.equal(cutReports(run).length, 0, `${harness} limit: no cut is raised`)
      await run.world.close()
    }

    // Cut first, then a limit on what goes next: the move carries it on, and the cut isn't raised beside it.
    {
      const run = await fin(`${harness}-cut-then-limit`, harness)
      await until(`${harness} both: the Fin to work`, () => run.world.live.session(run.fin)?.status === "running")
      await run.world.live.handOff(run.fin)
      run.spent.spentUntil = RESET
      run.refusing.words = LIMIT
      await run.world.agents.send(run.caller, { to: "labels", text: "Carry on.", clientKey: "go-on" })
      await until(`${harness} both: it to go on`, () => elsewhere(run, harness).length === 1)
      assert.ok(moved(run), `${harness} both: it moved`)
      await pause(SETTLED_MS)
      assert.equal(cutReports(run).length, 0, `${harness} both: no cut beside the move`)
      await run.world.close()
    }

    // A Stop wins over a cut waiting to be looked at.
    {
      const run = await fin(`${harness}-stop`, harness)
      await until(`${harness} stop: the Fin to work`, () => run.world.live.session(run.fin)?.status === "running")
      await run.world.live.handOff(run.fin)
      await run.world.agents.stop(run.caller, { child: "labels" })
      await pause(SETTLED_MS)
      assert.equal(cutReports(run).length, 0, `${harness} stop: nothing asks about what was stopped`)
      assert.equal(elsewhere(run, harness).length, 0, `${harness} stop: nothing goes on`)
      await run.world.close()
    }
    // What decided "out of accounts" no longer stands: the person's newer turn goes on.
    await outOfAccountsLate(`${harness}-late`, harness)
    console.log(`${harness}: a cut reaches its Apex, a limit moves and raises no cut, a cut then a limit moves, a Stop wins over both, and a stale "out of accounts" stops nothing`)
  }
  console.log("limit or cut: ok")
} finally {
  rmSync(root, { recursive: true, force: true })
}
