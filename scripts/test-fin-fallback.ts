import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { resetWords } from "@mako/host/contracts/account-usage"
import { fallbackOrder, modelFamily, movedLine, stepKey, type FallbackInput } from "@mako/host/contracts/fin-fallback"
import { FROM_AGENTS } from "@mako/host/conversations/agent-wakes"
import { ThreadIdSchema } from "@mako/host/contracts/thread-identity"
import { AgentsWorld, type Script, type ScriptedEnd, type WorldAccount, type WorldOptions } from "./lib/agents-world.ts"

/**
 * When a Fin's harness account reaches its limit, the Fin goes on at the next
 * step of an order built from the person's own setup (`npm run
 * test:fin-fallback`): their other accounts of that harness, then the model
 * connections the harness's routes take for its model's family, then their
 * next harness, never above its access, never back to a place its turn ran
 * on. Covered: the order on a matrix of accounts, connections, harnesses,
 * access and the switch; and an engine run whose stub harness reports its
 * limit at a Fin's start and mid-turn, resumes the same session on the next
 * account, then hands off to the next harness, with the switch off leaving
 * today's behaviour. The engine's clock is fixed to a known instant and
 * advances only with the run, so every reset reads the same words.
 */

const label = (harness: string) => harness[0]!.toUpperCase() + harness.slice(1)
type Harness = FallbackInput["harnesses"][number]
/** One of the person's harnesses: fitting the Fin's access, signed in and with room unless `patch` says otherwise. */
function harness(name: string, patch: Partial<Harness> = {}): Harness {
  return { harness: name, fits: true, signedIn: true, spent: false, ...patch }
}

// ── The order, pure.
{
  const base: FallbackInput = {
    from: { harness: "claude", account: "personal", model: "claude-opus-5-5" },
    when: "start",
    on: true,
    accounts: [
      { name: "personal", label: "personal", active: true, spent: { until: 1 } },
      { name: "spent", label: "spent", active: false, spent: { until: null } },
      { name: "unread", label: "unread", active: false, unread: true },
      { name: "gone", label: "gone", active: false, unusable: true },
      { name: "work", label: "work", active: false },
      { name: "side", label: "side", active: false },
    ],
    connections: [
      { id: "router", name: "Router", enabled: true, accepted: true, models: [{ id: "openai/gpt-6", harnessModel: "mako-router/openai/gpt-6" }, { id: "anthropic/claude-opus-5", harnessModel: "mako-router/anthropic/claude-opus-5" }] },
      { id: "off", name: "Off", enabled: false, accepted: true, models: [{ id: "claude-opus-5", harnessModel: "mako-off/claude-opus-5" }] },
      { id: "elsewhere", name: "Elsewhere", enabled: true, accepted: false, models: [{ id: "claude-opus-5", harnessModel: "mako-elsewhere/claude-opus-5" }] },
    ],
    continuation: { kind: "resumes", via: "test" },
    harnesses: [harness("claude"), harness("cursor", { fits: false }), harness("grok", { spent: true }), harness("devin", { signedIn: false }), harness("codex"), harness("opencode")],
  }
  const keys = (input: FallbackInput) => fallbackOrder(input).map(stepKey)
  assert.deepEqual(keys(base), ["claude:work", "claude:side", "claude@router", "codex", "opencode"],
    "accounts with room in the person's order, then the connection that serves the family, then harnesses that fit, are signed in and have room")
  assert.deepEqual(fallbackOrder(base)[2], { why: "connection", harness: "claude", connection: "router", connectionName: "Router", model: "mako-router/anthropic/claude-opus-5" }, "a connection step names the model as the harness lists it")
  assert.deepEqual(keys({ ...base, from: { harness: "claude", account: "personal" } }), ["claude:work", "claude:side", "codex", "opencode"], "without a model, no connection serves its family")
  assert.deepEqual(keys({ ...base, from: { ...base.from, model: "gpt-6" } }), ["claude:work", "claude:side", "claude@router", "codex", "opencode"], "a gpt model's family on the connection")
  assert.deepEqual(keys({ ...base, from: { harness: "claude", model: "claude-opus-5-5" } }), ["claude:work", "claude:side", "claude@router", "codex", "opencode"], "the account in use is the active one when none is named")
  assert.deepEqual(keys({ ...base, when: "mid-run" }), keys(base), "mid-run on a harness that resumes under another account: the same order")
  assert.deepEqual(keys({ ...base, when: "mid-run", continuation: { kind: "new-session", reason: "test" } }), ["claude@router", "codex", "opencode"], "mid-run on one that only starts new sessions: no other account of it")
  assert.deepEqual(keys({ ...base, when: "mid-run", continuation: undefined }), ["claude@router", "codex", "opencode"], "a harness that declares nothing only starts new sessions")
  assert.deepEqual(keys({ ...base, visited: ["claude:work", "codex"] }), ["claude:side", "claude@router", "opencode"], "never back to a place the turn ran on")
  assert.deepEqual(keys({ ...base, harnesses: base.harnesses.map((each) => ({ ...each, fits: each.harness === "claude" })) }), ["claude:work", "claude:side", "claude@router"], "no harness above the Fin's access")
  assert.deepEqual(keys({ ...base, on: false }), ["codex", "opencode"], "switch off at a start: today's next harness alone")
  assert.deepEqual(keys({ ...base, on: false, when: "mid-run" }), [], "switch off mid-run: nothing moves")
  assert.deepEqual(keys({ ...base, accounts: [], connections: [], harnesses: [harness("claude")] }), [], "nowhere to go")

  assert.equal(modelFamily("claude-opus-5-5"), "claude")
  assert.equal(modelFamily("anthropic/claude-sonnet-5"), "claude")
  assert.equal(modelFamily("sonnet"), "claude")
  assert.equal(modelFamily("gpt-6.1-sol"), "gpt")
  assert.equal(modelFamily("openai/o4-mini"), "gpt")
  assert.equal(modelFamily("grok-4.7-build"), "grok")
  assert.equal(modelFamily("composer-2.5"), undefined)

  const now = Date.UTC(2026, 10, 4, 20)
  const until = now + 2 * 3_600_000
  const at = resetWords(until, now)
  assert.equal(movedLine({ step: { why: "account", harness: "claude", account: "work", label: "work" }, from: { harness: "claude", account: "personal" }, until }, label, now), `Moved to Claude (work): personal is at its limit until ${at}`)
  assert.equal(movedLine({ step: { why: "connection", harness: "opencode", connection: "router", connectionName: "Router", model: "m" }, from: { harness: "opencode" } }, label, now), "Moved to Router on Opencode: Opencode's account is at its limit")
  assert.equal(movedLine({ step: { why: "harness", harness: "codex" }, from: { harness: "claude", account: "work" }, until }, label, now), `Moved to Codex: Claude (work) is at its limit until ${at}`)
  console.log("order: accounts, connections, harnesses, access, visits and the switch")
}

// ── The engine, on a stub harness that reports its limit.
const root = mkdtempSync(join(tmpdir(), "mako-fin-fallback-"))
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(what: string, done: () => boolean, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`)
    await pause(10)
  }
}
const NOW = Date.UTC(2026, 10, 4, 20)
const began = performance.now()
const clock = () => NOW + Math.round(performance.now() - began)
const RESET = NOW + 3 * 3_600_000
const LIMIT = "You've hit your usage limit"
/** Every harness signed in: its catalog lists a model. */
const CATALOGS = Object.fromEntries(["claude", "codex", "cursor", "grok", "opencode", "devin"].map((harness) => [harness, [{ id: `${harness}-model`, label: `${harness} model`, options: [] }]]))

interface Run {
  world: AgentsWorld
  apex: { conversation: string }
  wakes: string[]
  fin: () => string
  finTurns: () => { harness: string; text: string }[]
}

/** An Apex on Claude with one Fin, "labels"; `fin` scripts the Fin's turns by their number. */
/** A Fin's scripted turn: its reply, after `end` says how a limit refused it, if one did. */
type FinScript = (turn: number, end: (how: ScriptedEnd) => void) => string | Promise<string>

async function run(name: string, options: Partial<WorldOptions> & { fin: FinScript; start?: { harness?: string; model?: string } }): Promise<Run | { refused: string }> {
  const wakes: string[] = []
  let finConversation = ""
  let turns = 0
  const script: Script = (turn) => {
    if (turn.conversation === finConversation || turn.text.includes("You're fin:")) {
      turns += 1
      return options.fin(turns, (how) => turn.world.endWith(turn.conversation, how))
    }
    if (turn.text.startsWith(FROM_AGENTS)) wakes.push(turn.text)
    return "ok"
  }
  const world = new AgentsWorld({ root: join(root, name), script, now: clock, catalogs: CATALOGS, order: ["claude", "cursor", "codex", "grok", "opencode", "devin"], ladders: { cursor: [{ id: "full", name: "Full", access: "full" }] }, ...options })
  const apex = await world.apex("claude", "auto")
  const started = await world.agents.start(apex.caller, { brief: { objective: "Label the snippets" }, name: "labels", clientKey: "labels", cwd: world.root, ...options.start })
  if ("refused" in started) {
    await world.close()
    return { refused: started.why }
  }
  finConversation = started.conversation!
  return {
    world,
    apex,
    wakes,
    fin: () => finConversation,
    finTurns: () => world.prompts.filter((prompt) => prompt.conversation === finConversation).map((prompt) => ({ harness: prompt.harness, text: prompt.text })),
  }
}

/** The person's accounts of a harness, in their order, each with room until a test spends it. */
const named = (...names: string[]): WorldAccount[] => names.map((name) => ({ name }))
const accounts = () => ({
  claude: named("personal", "work"),
  codex: named("default"),
  grok: named("default"),
  opencode: named("default"),
  devin: named("default"),
  cursor: named("default"),
})
const edgeOf = (r: Run) => r.world.store.edges().of(ThreadIdSchema.parse(r.world.agents.roster(r.apex.conversation)[0]!.child!.thread))!
const strip = async (r: Run) => {
  const listed = await r.world.agents.list(r.world.caller(r.apex.conversation), {})
  assert.ok("children" in listed, JSON.stringify(listed))
  return listed.children[0]!
}
const noted = (r: Run, label: string) => (r.world.live.snapshot(r.fin())?.blocks ?? []).some((block) => block.type === "event" && block.label === label)

try {
  // At its start: the selected account is at its limit, so the Fin starts on the next account of the same harness, named or not.
  for (const named of [undefined, "claude"]) {
    const held = accounts()
    held.claude[0]!.spentUntil = RESET
    const r = await run(`start-${named ?? "unnamed"}`, { accounts: held, selected: { claude: "personal" }, start: named ? { harness: named } : {}, fin: () => "Labelled." })
    assert.ok(!("refused" in r), "refused" in r ? r.refused : "")
    await until("its turn to end", () => r.world.agents.roster(r.apex.conversation)[0]?.child?.state?.kind === "ended")
    const line = `Moved to Claude (work): personal is at its limit until ${resetWords(RESET, clock())}`
    const finLaunches = r.world.launches.filter((launch) => launch.conversation === r.fin())
    assert.deepEqual(finLaunches.map((launch) => [launch.harness, launch.account]), [["claude", "work"]], "it launched on the next account, its harness kept")
    assert.equal(r.finTurns()[0]!.harness, "claude")
    assert.deepEqual(edgeOf(r).tuned?.rerouted?.to, { why: "account", harness: "claude", account: "work", label: "work" })
    assert.equal(r.world.agents.roster(r.apex.conversation)[0]!.child!.moved, line, "its row says where and why")
    assert.equal((await strip(r)).moved, line, "and its strip")
    await r.world.close()
  }
  console.log("at its start: the next account of its harness, whether the start named the harness or not, its row and strip saying so")

  // A start that named a model keeps the refusal.
  {
    const held = accounts()
    held.claude[0]!.spentUntil = RESET
    const r = await run("start-model", { accounts: held, selected: { claude: "personal" }, start: { harness: "claude", model: "claude-opus-5-5" }, fin: () => "Labelled." })
    assert.ok("refused" in r)
    assert.match(r.refused, /Claude is at its limit on personal until .*Leave model out/)
  }
  console.log("a start that named a model: refused, saying when the limit resets")

  // Mid-run: the account runs out mid-turn, the same session resumes on the next account; that one runs out too, and
  // the Fin hands off to the next harness, past one above its access, never back to the first account.
  {
    const held = accounts()
    const r = await run("mid-run", {
      accounts: held,
      selected: { claude: "personal" },
      continuation: { codex: { kind: "new-session", reason: "test" } },
      fin: (turn, end) => {
        if (turn === 1) {
          held.claude[0]!.spentUntil = RESET
          end({ limit: { window: "5-hour limit", resetsAt: RESET }, fail: LIMIT })
          return "Labelled 40."
        }
        if (turn === 2) {
          held.claude[1]!.spentUntil = RESET
          // The first account has room again: still not one this turn goes back to.
          delete held.claude[0]!.spentUntil
          end({ limit: { resetsAt: RESET }, fail: LIMIT })
          return "Labelled 80."
        }
        return "Labelled all 120."
      },
    })
    assert.ok(!("refused" in r))
    await until("its third turn to end", () => r.finTurns().length === 3 && r.world.agents.roster(r.apex.conversation)[0]?.child?.state?.kind === "ended")
    const turns = r.finTurns()
    assert.deepEqual(turns.map((turn) => turn.harness), ["claude", "claude", "codex"], "the next account of Claude, then Codex, past Cursor, which runs only above its access")
    assert.ok(turns[1]!.text.includes("[mako · moved after a usage limit]"), turns[1]!.text)
    assert.ok(turns[1]!.text.includes("This is the same session"), turns[1]!.text)
    assert.ok(turns[2]!.text.includes("carried over from Claude (work)"), turns[2]!.text)
    const finLaunches = r.world.launches.filter((launch) => launch.conversation === r.fin() || launch.harness === "codex")
    assert.deepEqual(finLaunches.slice(0, 2).map((launch) => [launch.harness, launch.account, launch.resume]), [["claude", "personal", undefined], ["claude", "work", `native-${r.fin()}`]], "the same native session resumed on the next account")
    assert.deepEqual(finLaunches[2] && [finLaunches[2].harness, finLaunches[2].resume], ["codex", undefined], "a new Codex session for the hand-off")
    const line = `Moved to Codex: Claude (work) is at its limit until ${resetWords(RESET, clock())}`
    assert.deepEqual(edgeOf(r).tuned?.rerouted?.to, { why: "harness", harness: "codex" })
    assert.equal(r.world.agents.roster(r.apex.conversation)[0]!.child!.moved, line)
    assert.ok(noted(r, "Moved to Claude (work)") && noted(r, "Moved to Codex"), "each move is a line in its transcript")
    const thread = edgeOf(r).child
    assert.deepEqual(r.world.store.reportsOf(thread, 0).map((report) => [report.status, report.summary]), [["done", "Labelled all 120."]], "one report, the turn that finished the work: no failure for a limit it moved past")
    await until("its Apex to hear", () => r.wakes.length === 1)
    assert.ok(r.wakes[0]!.includes(`"labels" moved to Claude (work): personal is at its limit`), r.wakes[0])
    assert.ok(r.wakes[0]!.includes(`"labels" moved to Codex: Claude (work) is at its limit`), r.wakes[0])
    assert.equal(r.wakes.length, 1, "the moves never woke the Apex by themselves")
    await r.world.close()
  }
  console.log("mid-run: the same session on the next account, then a hand-off to the next harness, said in its row, transcript and its Apex's digest")

  // A harness that only starts new sessions under another account hands off mid-run instead.
  {
    const held = accounts()
    held.codex.push({ name: "second" })
    const r = await run("new-session", {
      accounts: held,
      selected: { codex: "default" },
      continuation: { codex: { kind: "new-session", reason: "test" } },
      start: { harness: "codex" },
      fin: (turn, end) => {
        if (turn === 1) {
          held.codex[0]!.spentUntil = RESET
          end({ limit: { resetsAt: RESET }, fail: LIMIT })
          return ""
        }
        return "Done."
      },
    })
    assert.ok(!("refused" in r))
    await until("its second turn to end", () => r.finTurns().length === 2 && r.world.agents.roster(r.apex.conversation)[0]?.child?.state?.kind === "ended")
    assert.deepEqual(r.finTurns().map((turn) => turn.harness), ["codex", "claude"], "Codex's other account is skipped mid-run: the next harness")
    await r.world.close()
  }
  console.log("a harness that only starts new sessions: mid-run it hands off to the next harness")

  // The person's own message in the Fin's Thread is theirs to drive: a limit there ends the turn as before.
  {
    const held = accounts()
    let finConversation = ""
    const r = await run("person", {
      accounts: held,
      selected: { claude: "personal" },
      fin: (turn, end) => {
        if (turn === 1) return "First pass."
        held.claude[0]!.spentUntil = RESET
        end({ limit: { resetsAt: RESET }, fail: LIMIT })
        return ""
      },
    })
    assert.ok(!("refused" in r))
    finConversation = r.fin()
    await until("its first turn", () => r.world.agents.roster(r.apex.conversation)[0]?.child?.state?.kind === "ended")
    r.world.say(finConversation, "One more pass, please.")
    await until("the person's turn to fail", () => r.world.live.snapshot(finConversation)?.requests.some((request) => request.status === "failed") ?? false)
    await r.world.settle(300, 20_000, "ignore")
    assert.equal(r.finTurns().length, 2, "nothing moved")
    assert.equal(edgeOf(r).tuned?.rerouted, undefined)
    await r.world.close()
  }
  console.log("a turn the person sent in the Fin's Thread: no move")

  // A Stop while the move reads the accounts: the waiting continuation is the Stop's, so nothing moves or goes.
  {
    let release!: () => void
    let reading = false
    const read = new Promise<void>((resolve) => (release = resolve))
    const held = accounts()
    const r = await run("stop-during-read", {
      accounts: held,
      selected: { claude: "personal" },
      readingAccounts: async (_harness, all) => {
        if (!all) return
        reading = true
        await read
      },
      fin: (turn, end) => {
        if (turn === 1) {
          held.claude[0]!.spentUntil = RESET
          end({ limit: { resetsAt: RESET }, fail: LIMIT })
        }
        return "partial"
      },
    })
    assert.ok(!("refused" in r))
    await until("the move to read the accounts", () => reading)
    const stopped = await r.world.agents.stop(r.world.caller(r.apex.conversation), { child: "labels" })
    assert.ok("stopped" in stopped && stopped.stopped.includes("labels"), JSON.stringify(stopped))
    release()
    await r.world.settle(400, 20_000, "ignore")
    assert.equal(r.finTurns().length, 1, "the stopped Fin got no continuation")
    assert.deepEqual(r.world.launches.filter((launch) => launch.conversation === r.fin()).map((launch) => launch.account), ["personal"], "nor a launch on the next account")
    assert.equal(edgeOf(r).tuned?.rerouted, undefined, "and its edge names no move")
    assert.equal(r.world.store.finTurn(edgeOf(r).child)?.moving, undefined, "the move let go of its claim")
    await r.world.close()
  }
  console.log("a Stop while the move reads the accounts: no move, no continuation, no launch")

  // A restart in the middle of a logical turn: the places it ran on are the store's, so it never goes back to one, and
  // with every step at its limit or run on it stops out of accounts rather than loop.
  {
    const held = accounts()
    let finConversation = ""
    const r = await run("restart", {
      accounts: held,
      selected: { claude: "personal" },
      catalogs: { claude: CATALOGS.claude! },
      fin: (turn, end) => {
        if (turn === 1) {
          held.claude[0]!.spentUntil = RESET
          end({ limit: { resetsAt: RESET }, fail: LIMIT })
          return "partial"
        }
        // The restart cuts this one: its script never answers.
        if (turn === 2) return new Promise<string>(() => {})
        if (turn === 3) {
          delete held.claude[0]!.spentUntil
          held.claude[1]!.spentUntil = RESET
          end({ limit: { resetsAt: RESET }, fail: LIMIT })
          return "partial"
        }
        return "done"
      },
    })
    assert.ok(!("refused" in r))
    finConversation = r.fin()
    await until("the move to work", () => r.world.launches.some((launch) => launch.conversation === finConversation && launch.account === "work"))
    await until("its turn on work", () => r.finTurns().length === 2)
    await r.world.restart()
    await until("it to stop out of accounts", () => { const state = r.world.agents.roster(r.apex.conversation)[0]?.child?.state; return state?.kind === "ended" && state.outcome === "stopped" }, 30_000)
    const accountsRun = r.world.launches.filter((launch) => launch.conversation === finConversation).map((launch) => launch.account)
    assert.equal(accountsRun.lastIndexOf("personal"), 0, `never back to personal: ${accountsRun.join(", ")}`)
    const line = r.world.agents.roster(r.apex.conversation)[0]!.child!.moved!
    assert.match(line, /^Out of accounts: work and personal are at their limits until /, line)
    assert.equal(edgeOf(r).closedReason, line, "its stop says why in the same words")
    await r.world.close()
  }
  console.log("a restart mid-turn: never back to an account the turn ran on, and out of accounts it stops saying so")

  // Switch off: today's behaviour exactly. At a start the next harness for a Fin that named none, a refusal for one that
  // named it; mid-run the turn fails and reports so.
  {
    const held = accounts()
    held.claude[0]!.spentUntil = RESET
    const off = { accounts: held, selected: { claude: "personal" }, moveOnLimit: () => false }
    const unnamed = await run("off-start", { ...off, fin: () => "Labelled." })
    assert.ok(!("refused" in unnamed))
    await until("its turn", () => unnamed.finTurns().length === 1)
    assert.equal(unnamed.finTurns()[0]!.harness, "codex", "the person's next harness that fits, as before")
    assert.deepEqual(edgeOf(unnamed).tuned?.rerouted, { from: "claude", until: RESET }, "rerouted as before: no step, no line")
    await unnamed.world.close()
    const named = await run("off-named", { ...off, start: { harness: "claude" }, fin: () => "Labelled." })
    assert.ok("refused" in named, "a start that named the harness is refused, as before")

    const fresh = accounts()
    const midRun = await run("off-mid-run", {
      accounts: fresh,
      selected: { claude: "personal" },
      moveOnLimit: () => false,
      fin: (_turn, end) => {
        fresh.claude[0]!.spentUntil = RESET
        end({ limit: { resetsAt: RESET }, fail: LIMIT })
        return ""
      },
    })
    assert.ok(!("refused" in midRun))
    await until("its failure", () => { const state = midRun.world.agents.roster(midRun.apex.conversation)[0]?.child?.state; return state?.kind === "ended" && state.outcome === "failed" })
    await midRun.world.settle(300, 20_000, "ignore")
    assert.equal(midRun.finTurns().length, 1, "no continuation")
    assert.deepEqual(midRun.world.launches.filter((launch) => launch.conversation === midRun.fin()).map((launch) => launch.account), ["personal"], "no other launch")
    assert.equal(edgeOf(midRun).tuned?.rerouted, undefined)
    assert.equal(noted(midRun, "Moved to Claude (work)"), false)
    await midRun.world.close()
  }
  console.log("switch off: today's next-harness rule at a start, a refusal when named, and a failed turn mid-run")
  console.log("fin fallback: ok")
} finally {
  rmSync(root, { recursive: true, force: true })
}
