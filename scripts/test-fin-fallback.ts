import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { resetWords } from "@mako/host/contracts/account-usage"
import { fallbackOrder, modelFamily, movedLine, stepKey, type FallbackInput } from "@mako/host/contracts/fin-fallback"
import { childGroup } from "@mako/host/contracts/children"
import { FROM_AGENTS } from "@mako/host/conversations/agent-wakes"
import { ThreadIdSchema } from "@mako/host/contracts/thread-identity"
import type { AgentCaller } from "@mako/host/contracts/agents"
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
// What the next reads of the clock say, ahead of the time itself.
const clockSays: number[] = []
const clock = () => clockSays.shift() ?? NOW + Math.round(performance.now() - began)
const RESET = NOW + 3 * 3_600_000
const LIMIT = "You've hit your usage limit"
/** Every harness signed in: its catalog lists a model. */
const CATALOGS = Object.fromEntries(["claude", "codex", "cursor", "grok", "opencode", "devin"].map((harness) => [harness, [{ id: `${harness}-model`, label: `${harness} model`, options: [] }]]))

interface Run {
  world: AgentsWorld
  apex: { conversation: string }
  caller: AgentCaller
  wakes: string[]
  fin: () => string
  finTurns: () => { harness: string; text: string }[]
}

/** An Apex on Claude with one Fin, "labels"; `fin` scripts the Fin's turns by their number. */
/** A Fin's scripted turn: its reply, after `end` says how a limit refused it, if one did. */
type FinScript = (turn: number, end: (how: ScriptedEnd) => void) => string | Promise<string>

async function run(name: string, options: Partial<WorldOptions> & { fin: FinScript; start?: { harness?: string; model?: string }; apexOn?: string }): Promise<Run | { refused: string }> {
  const wakes: string[] = []
  let finConversation = ""
  let turns = 0
  const script: Script = (turn) => {
    if (turn.conversation === finConversation || turn.text.includes("You're fin:")) {
      turns += 1
      return options.fin(turns, (how) => turn.world.endWith(turn.conversation, how))
    }
    // An Apex that went with its tree hears them with the conversation handed over above them.
    if (turn.text.includes(FROM_AGENTS)) wakes.push(turn.text)
    return "ok"
  }
  const world = new AgentsWorld({ root: join(root, name), script, now: clock, catalogs: CATALOGS, order: ["claude", "cursor", "codex", "grok", "opencode", "devin"], ladders: { cursor: [{ id: "full", name: "Full", access: "full" }] }, ...options })
  const apex = await world.apex(options.apexOn ?? "claude", "auto")
  const started = await world.agents.start(apex.caller, { brief: { objective: "Label the snippets" }, name: "labels", clientKey: "labels", cwd: world.root, ...options.start })
  if ("refused" in started) {
    await world.close()
    return { refused: started.why }
  }
  finConversation = started.conversation!
  return {
    world,
    apex,
    caller: apex.caller,
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
    assert.ok(r.wakes[0]!.includes('"labels" (Codex)'), `it's named for the harness it's on: ${r.wakes[0]!.slice(0, 200)}`)
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

  // A hand-off with messages queued behind it: the move and its context reach the next harness first, each message once, in order.
  {
    const held = { claude: named("personal"), codex: named("default") }
    let cut = () => {}
    const cutting = new Promise<void>((resolve) => (cut = resolve))
    const r = await run("queued-behind", {
      accounts: held,
      selected: { claude: "personal" },
      start: { harness: "claude" },
      fin: async (turn, end) => {
        if (turn > 1) return "Done."
        await cutting
        held.claude[0]!.spentUntil = RESET
        end({ limit: { resetsAt: RESET }, fail: LIMIT })
        return "Partial labels."
      },
    })
    assert.ok(!("refused" in r))
    await until("its first turn", () => r.finTurns().length === 1)
    r.world.say(r.fin(), "After: verify the labels.")
    r.world.say(r.fin(), "After that: write them up.")
    cut()
    await until("all three to reach the next harness", () => r.finTurns().filter((turn) => turn.harness !== "claude").length === 3)
    const there = r.finTurns().filter((turn) => turn.harness !== "claude")
    assert.ok(there[0]!.text.includes("[mako · moved after a usage limit]"), `the move goes first, not: ${there[0]!.text.slice(0, 60)}`)
    assert.ok(there[1]!.text.includes("After: verify the labels."), "then what was queued, in order")
    assert.ok(there[2]!.text.includes("After that: write them up."), "and the next")
    const requests = r.world.live.snapshot(r.fin())!.requests
    const carrying = requests.filter((request) => request.context?.length)
    assert.equal(carrying.length, 1, "one row carries the hand-over's context")
    assert.ok(carrying[0]!.text.includes("[mako · moved after a usage limit]"), "and it's the move's")
    await r.world.close()
  }
  console.log("a hand-off with messages queued behind it: the move and its context go first, then each message once, in order")

  // A message that arrives while the next harness prepares can't overtake the move: it's refused in words, and sent after the move lands it goes behind it.
  {
    const held = { claude: named("personal"), codex: named("default") }
    let release = () => {}
    const released = new Promise<void>((resolve) => (release = resolve))
    let preparing = false
    const r = await run("arrives-preparing", {
      accounts: held,
      selected: { claude: "personal" },
      start: { harness: "claude" },
      starting: async (_conversation, harness) => {
        if (harness !== "codex") return
        preparing = true
        await released
      },
      fin: (turn, end) => {
        if (turn > 1) return "Done."
        held.claude[0]!.spentUntil = RESET
        end({ limit: { resetsAt: RESET }, fail: LIMIT })
        return "Partial labels."
      },
    })
    assert.ok(!("refused" in r))
    await until("Codex to prepare", () => preparing)
    assert.throws(() => r.world.say(r.fin(), "After: verify the labels."), /A provider switch is pending/)
    assert.equal(r.finTurns().filter((turn) => turn.harness === "codex").length, 0, "nothing reaches the next harness while it prepares")
    release()
    await until("the move to reach the next harness", () => r.finTurns().some((turn) => turn.harness === "codex"))
    r.world.say(r.fin(), "After: verify the labels.")
    await until("both to reach the next harness", () => r.finTurns().filter((turn) => turn.harness === "codex").length === 2)
    const there = r.finTurns().filter((turn) => turn.harness === "codex")
    assert.ok(there[0]!.text.includes("[mako · moved after a usage limit]"), `the move goes first, not: ${there[0]!.text.slice(0, 60)}`)
    assert.ok(there[1]!.text.includes("After: verify the labels."), "then what arrived while it prepared")
    const carrying = r.world.live.snapshot(r.fin())!.requests.filter((request) => request.context?.length)
    assert.equal(carrying.length, 1, "one row carries the hand-over's context")
    assert.ok(carrying[0]!.text.includes("[mako · moved after a usage limit]"), "and it's the move's")
    await r.world.close()
  }
  console.log("a message arriving while the next harness prepares: refused in words, and sent again it goes after the move and its context")

  // The exact words that stopped this Mac's Fins on 2026-11-05: Cursor marks no limit and its reading can't say it, so the words alone move it, with their reset.
  // Their date is three days from today, in Cursor's form: the words named 11/8/2026, which a run on that day found already past.
  {
    const resets = new Date()
    resets.setHours(0, 0, 0, 0)
    resets.setDate(resets.getDate() + 3)
    const words = `Your team has reached its usage limit Please reach out to an admin to increase your limit, or return on ${resets.getMonth() + 1}/${resets.getDate()}/${resets.getFullYear()} when your usage resets.`
    const r = await run("cursor-words", {
      accounts: { cursor: named("default"), claude: named("personal") },
      selected: { cursor: "default", claude: "personal" },
      start: { harness: "cursor" },
      ladders: {},
      fin: (turn, end) => {
        if (turn > 1) return "Done."
        end({ fail: words })
        return "Partial labels."
      },
    })
    assert.ok(!("refused" in r))
    await until("it to go on", () => r.finTurns().some((turn) => turn.harness !== "cursor"))
    const moved = edgeOf(r).tuned?.rerouted
    assert.equal(moved?.until, resets.getTime(), "until the date Cursor's words name")
    assert.equal(moved?.from, "cursor")
    await r.world.close()
  }
  console.log("Cursor's exact words, with no limit marked and no reading: it moves, until the date they name")

  // A limit that moves a whole tree says so once, for all of it, in the Apex's row, and "Got it" ends it for good.
  {
    const held = { claude: named("personal"), codex: named("default") }
    let out = () => {}
    const spent = new Promise<void>((resolve) => (out = resolve))
    const r = await run("one-notice", {
      accounts: held,
      selected: { claude: "personal" },
      start: { harness: "claude" },
      fin: async (turn, end) => {
        if (turn > 2) return "Done."
        await spent
        end({ limit: { resetsAt: RESET }, fail: LIMIT })
        return "Partial labels."
      },
    })
    assert.ok(!("refused" in r))
    const second = await r.world.agents.start(r.caller, { brief: { objective: "Check the labels" }, harness: "claude", name: "checks", clientKey: "checks", cwd: r.world.root })
    assert.ok(!("refused" in second))
    await until("both to be at work", () => r.world.prompts.filter((prompt) => prompt.text.includes("You're fin:")).length === 2)
    held.claude[0]!.spentUntil = RESET
    out()
    await until("the notice", () => r.world.agents.personAsk(r.apex.conversation) !== undefined, 8_000)
    const said = r.world.agents.personAsk(r.apex.conversation)!
    assert.equal(said.line, `Claude (personal) ran out until ${resetWords(RESET, clock())}. This Thread and 2 Fins moved to Codex.`, "what ran out, until when and what moved where, in one line")
    assert.deepEqual(said.ask.options?.map((option) => option.label), ["Got it"])
    assert.equal(r.world.agents.roster(r.apex.conversation).find((agent) => agent.child?.limitNotice)?.child?.limitNotice?.harness, "claude", "it names the harness that ran out, though the Fin carrying it has left")
    const carrying = r.world.agents.roster(r.apex.conversation).filter((agent) => agent.child?.limitNotice)
    assert.equal(carrying.length, 1, "one notice for the tree, not a card per Fin")
    for (const agent of r.world.agents.roster(r.apex.conversation)) {
      assert.match(agent.child?.moved ?? "", /^Moved to Codex/, "a moved Fin reads moved")
      assert.notEqual(agent.child?.state?.kind === "ended" ? agent.child.state.outcome : undefined, "failed", "never failed")
    }
    const seen = await r.world.agents.respond(r.apex.conversation, { fin: said.fin, ask: said.ask.id, request: "seen", option: 0 })
    assert.ok(!("refused" in seen), JSON.stringify(seen))
    assert.equal(r.world.agents.personAsk(r.apex.conversation), undefined, "seen, it's gone from every surface")
    assert.equal(r.world.prompts.filter((prompt) => prompt.text.includes("Got it")).length, 0, "and no Fin was told anything")
    await r.world.close()
  }
  console.log("a limit that moves a whole tree: one notice saying what ran out, until when and what moved where; a moved Fin reads moved; Got it ends it")

  // A host that stops while a notice gathers leaves it kept: the next says it once, and it still ends at its reset.
  {
    const reset = clock() + 15_000
    const held = { claude: named("personal"), codex: named("default") }
    let spent!: () => void
    const out = new Promise<void>((resolve) => (spent = resolve))
    const r = await run("notice-restart", {
      accounts: held,
      selected: { claude: "personal" },
      start: { harness: "claude" },
      fin: async (turn, end) => {
        if (turn > 1) return "Done."
        await out
        end({ limit: { resetsAt: reset }, fail: LIMIT })
        return "Partial labels."
      },
    })
    assert.ok(!("refused" in r))
    held.claude[0]!.spentUntil = reset
    spent()
    await until("the move", () => r.finTurns().some((turn) => turn.harness === "codex"))
    const tree = r.world.store.journalPlacement(r.apex.conversation)!.thread
    assert.equal(r.world.store.limitNotice(tree), undefined, "said to nobody yet: it gathers")
    assert.equal(r.world.store.limitNotices().filter(({ notice }) => notice.gathering).length, 1, "and is kept already")
    await r.world.restart()
    await until("the notice after a restart", () => r.world.agents.personAsk(r.apex.conversation) !== undefined, 8_000)
    assert.match(r.world.agents.personAsk(r.apex.conversation)!.line, /ran out until .*1 Fin moved to Codex\.$/)
    assert.equal((r.world.live.snapshot(r.apex.conversation)?.blocks ?? []).filter((block) => block.type === "event" && block.label.includes("ran out")).length, 1, "the transcript says it once")
    const shown = () => r.world.live.snapshot(r.apex.conversation)?.nativeAgents?.agents.filter((agent) => agent.child?.limitNotice).length
    await until("the Apex's snapshot to hold it", () => r.world.agents.roster(r.apex.conversation).some((agent) => agent.child?.limitNotice))
    await r.world.restart()
    await until("it read in again", () => r.world.agents.roster(r.apex.conversation).some((agent) => agent.child?.limitNotice))
    r.world.live.childrenChanged(r.apex.conversation, false)
    assert.equal(shown(), 1, "standing, a host read it in")
    await until("its reset, heard by a quiet Thread", () => shown() === 0, 20_000)
    await r.world.close()
  }
  // No restart at all: the notice is said, the Thread goes quiet, and its reset alone ends it there.
  {
    const reset = clock() + 7_000
    const held = { claude: named("personal"), codex: named("default") }
    let spent!: () => void
    const out = new Promise<void>((resolve) => (spent = resolve))
    const r = await run("notice-ends", {
      accounts: held,
      selected: { claude: "personal" },
      start: { harness: "claude" },
      fin: async (turn, end) => {
        if (turn > 1) return "Done."
        await out
        end({ limit: { resetsAt: reset }, fail: LIMIT })
        return "Partial labels."
      },
    })
    assert.ok(!("refused" in r))
    held.claude[0]!.spentUntil = reset
    spent()
    // No roster isn't no notice: it doesn't count as cleared, and neither does anything before the reset. This failed
    // in CI without saying if a notice stood or the roster had gone: a failure now prints which.
    const shown = () => r.world.live.snapshot(r.apex.conversation)?.nativeAgents?.agents.filter((agent) => agent.child?.limitNotice).length
    await until("the notice on the Apex's snapshot", () => shown() === 1, 6_000)
    const fresh = () => r.world.agents.roster(r.apex.conversation).filter((agent) => agent.child?.limitNotice).length
    assert.equal(fresh(), 1, "a fresh read of the roster has it too")
    await until("its reset, with nobody reading", () => shown() === 0, 12_000).catch((error) => {
      const entries = r.world.agents.roster(r.apex.conversation).map((agent) => [agent.child?.state?.kind, Boolean(agent.child?.limitNotice)])
      console.error("At its reset:", JSON.stringify({ reset, now: clock(), shown: shown() ?? "no roster", entries, session: r.world.live.session(r.apex.conversation)?.status, notices: r.world.store.limitNotices() }))
      throw error
    })
    assert.ok(clock() >= reset, `the notice held until its reset, not ${reset - clock()} ms short of it`)
    assert.equal(fresh(), 0, "and a fresh read of the roster agrees")
    await r.world.close()
  }
  // A timer can fire a moment early, and the clock can cross the reset between the two reads that follow. Linux runners
  // left a notice on the Apex's snapshot this way, past its reset, while a fresh roster was clean.
  {
    const reset = clock() + 7_000
    const held = { claude: named("personal"), codex: named("default") }
    let spent!: () => void
    const out = new Promise<void>((resolve) => (spent = resolve))
    const r = await run("notice-early-timer", {
      accounts: held,
      selected: { claude: "personal" },
      start: { harness: "claude" },
      fin: async (turn, end) => {
        if (turn > 1) return "Done."
        await out
        end({ limit: { resetsAt: reset }, fail: LIMIT })
        return "Partial labels."
      },
    })
    assert.ok(!("refused" in r))
    held.claude[0]!.spentUntil = reset
    const realTimeout = globalThis.setTimeout
    let early = 0
    // SAFETY: called as setTimeout is, with the timer it returns; only the reset's own timer is touched.
    globalThis.setTimeout = ((work: () => void, ms?: number) => {
      const forReset = ms !== undefined && ms > 1_000 && Math.abs(clock() + ms - reset) < 5
      return realTimeout(() => {
        if (forReset && !early) {
          early += 1
          clockSays.push(reset - 1, reset)
        }
        work()
      }, ms)
    }) as typeof setTimeout
    try {
      spent()
      const shown = () => r.world.live.snapshot(r.apex.conversation)?.nativeAgents?.agents.filter((agent) => agent.child?.limitNotice).length
      await until("the notice on the Apex's snapshot", () => shown() === 1, 6_000)
      await until("its reset, on a timer that fired early", () => shown() === 0, 12_000)
      assert.equal(early, 1, "the reset's timer is the one that fired early")
      assert.ok(clock() >= reset - 1, "and the notice held until its reset")
    } finally {
      globalThis.setTimeout = realTimeout
    }
    await r.world.close()
  }
  // Past its reset a notice is off the entry that carries it, whatever the cache held; and a host that comes back to
  // one it was gathering keeps it as said, with no line of news that's over.
  {
    let now = NOW
    const held = { claude: named("personal"), codex: named("default") }
    let spent!: () => void
    const out = new Promise<void>((resolve) => (spent = resolve))
    const r = await run("notice-reset", {
      now: () => now,
      accounts: held,
      selected: { claude: "personal" },
      start: { harness: "claude" },
      fin: async (turn, end) => {
        if (turn > 1) return "Done."
        await out
        end({ limit: { resetsAt: RESET }, fail: LIMIT })
        return "Partial labels."
      },
    })
    assert.ok(!("refused" in r))
    held.claude[0]!.spentUntil = RESET
    spent()
    await until("the notice", () => r.world.agents.personAsk(r.apex.conversation) !== undefined, 8_000)
    assert.equal(r.world.agents.roster(r.apex.conversation).filter((agent) => agent.child?.limitNotice).length, 1)
    now = RESET + 1
    assert.equal(r.world.agents.personAsk(r.apex.conversation), undefined)
    assert.equal(r.world.agents.roster(r.apex.conversation).filter((agent) => agent.child?.limitNotice).length, 0, "the Inbox and the phone read the roster")
    await r.world.close()
  }
  {
    let now = NOW
    const held = { claude: named("personal"), codex: named("default") }
    let spent!: () => void
    const out = new Promise<void>((resolve) => (spent = resolve))
    const r = await run("notice-late", {
      now: () => now,
      accounts: held,
      selected: { claude: "personal" },
      start: { harness: "claude" },
      fin: async (turn, end) => {
        if (turn > 1) return "Done."
        await out
        end({ limit: { resetsAt: RESET }, fail: LIMIT })
        return "Partial labels."
      },
    })
    assert.ok(!("refused" in r))
    held.claude[0]!.spentUntil = RESET
    spent()
    await until("the move", () => r.finTurns().some((turn) => turn.harness === "codex"))
    now = RESET + 1
    await r.world.restart()
    await until("it said", () => !r.world.store.limitNotices().some(({ notice }) => notice.gathering), 8_000)
    assert.equal(r.world.agents.personAsk(r.apex.conversation), undefined, "over before anyone could read it")
    assert.equal((r.world.live.snapshot(r.apex.conversation)?.blocks ?? []).filter((block) => block.type === "event" && block.label.includes("ran out")).length, 0, "and no line of it")
    await r.world.close()
  }
  // A move rides the digest: a second Fin's result joining it, and a restart under it, keep the line until the Apex hears it.
  {
    const held = { claude: named("personal"), codex: named("default") }
    let spent!: () => void
    const out = new Promise<void>((resolve) => (spent = resolve))
    let limited = false
    const r = await run("moved-digest", {
      apexOn: "codex",
      accounts: held,
      selected: { claude: "personal" },
      start: { harness: "claude" },
      fin: () => "unused",
      script: async (turn) => {
        if (turn.text.includes("HOLD")) return turn.world.hold(turn.conversation).then(() => "ok")
        if (!limited && turn.harness === "claude" && turn.text.includes("You're fin:")) {
          limited = true
          await out
          turn.world.endWith(turn.conversation, { limit: { resetsAt: RESET }, fail: LIMIT })
          return "Partial labels."
        }
        return "Done."
      },
    })
    assert.ok(!("refused" in r))
    const apex = r.apex.conversation
    r.world.say(apex, "HOLD")
    await until("the Apex at work", () => r.world.live.session(apex)?.status === "running")
    held.claude[0]!.spentUntil = RESET
    spent()
    const waiting = () => r.world.live.snapshot(apex)!.requests.find((request) => request.digest && (request.status === "queued" || request.status === "held"))
    const MOVED_LINE = '"labels" moved to Codex'
    await until("the digest", () => Boolean(waiting()?.text.includes(MOVED_LINE)))
    const first = waiting()!
    const second = await r.world.agents.start(r.caller, { brief: { objective: "A second result" }, harness: "codex", name: "second", clientKey: "second", cwd: r.world.root })
    assert.ok(!("refused" in second))
    await until("the second result to join", () => (waiting()?.digest?.notices.length ?? 0) >= 2)
    assert.equal(waiting()!.id, first.id, "one digest")
    assert.equal(waiting()!.text.split(MOVED_LINE).length, 2, "still saying the move, once")
    assert.equal(waiting()!.digest?.lines?.length, 1, "kept on its row")
    await r.world.restart()
    await until("the Apex read in", () => r.world.live.snapshot(apex) !== undefined)
    assert.equal(r.world.live.snapshot(apex)!.requests.find((request) => request.id === first.id)?.digest?.lines?.length, 1, "across a restart too")
    // The restart cut the Apex's turn, so its queue waits for a Resume.
    const paused = r.world.live.snapshot(apex)!.requests.find((request) => request.id === first.id)!
    if (paused.pause) r.world.live.editQueued(apex, { requestId: paused.id, expectedText: paused.text, change: { kind: "resume" } })
    await r.world.settle(40, 20_000, "ignore")
    assert.equal(r.world.prompts.filter((prompt) => prompt.conversation === apex && prompt.text.includes(MOVED_LINE)).length, 1, "the Apex hears it, once")
    await r.world.close()
  }
  // A digest that fails with nothing done goes on as a new row, carrying its move; a report joining that row keeps it.
  {
    const held = { claude: named("personal"), codex: named("default") }
    let spent!: () => void
    const out = new Promise<void>((resolve) => (spent = resolve))
    let limited = false
    let failing = true
    const heard: string[] = []
    const r = await run("moved-failed", {
      apexOn: "codex",
      // Claude spent, the Apex at a limit has nowhere to go, or it would move on with its digest.
      catalogs: { claude: CATALOGS.claude!, codex: CATALOGS.codex! },
      accounts: held,
      selected: { claude: "personal" },
      start: { harness: "claude" },
      fin: () => "unused",
      script: async (turn) => {
        if (turn.text.startsWith(FROM_AGENTS)) {
          if (!failing) {
            heard.push(turn.text)
            return "Done."
          }
          const session = turn.world.live.snapshot(turn.conversation)!.session
          turn.world.live.observe({ type: "live-session", session: { ...session, status: "failed", error: LIMIT } })
          return new Promise<string>(() => {})
        }
        if (turn.text.includes("HOLD")) return turn.world.hold(turn.conversation).then(() => "ok")
        if (!limited && turn.harness === "claude" && turn.text.includes("You're fin:")) {
          limited = true
          await out
          turn.world.endWith(turn.conversation, { limit: { resetsAt: RESET }, fail: LIMIT })
          return "Partial labels."
        }
        return "Done."
      },
    })
    assert.ok(!("refused" in r))
    const apex = r.apex.conversation
    r.world.say(apex, "HOLD")
    await until("the Apex at work", () => r.world.live.session(apex)?.status === "running")
    held.claude[0]!.spentUntil = RESET
    spent()
    const MOVED_LINE = '"labels" moved to Codex'
    const waiting = () => r.world.live.snapshot(apex)!.requests.find((request) => request.digest && (request.status === "queued" || request.status === "held"))
    await until("the digest", () => Boolean(waiting()?.text.includes(MOVED_LINE)))
    r.world.release(apex)
    await until("the digest to fail with nothing done", () => Boolean(waiting()?.continues))
    assert.equal(waiting()!.digest?.lines?.length, 1, "the row that goes on from it carries the move")
    const second = await r.world.agents.start(r.caller, { brief: { objective: "A second result" }, harness: "codex", name: "second", clientKey: "second", cwd: r.world.root })
    assert.ok(!("refused" in second))
    await until("the second result to join", () => (waiting()?.digest?.notices.length ?? 0) >= 2)
    assert.equal(waiting()!.text.split(MOVED_LINE).length, 2, "a report joining it keeps the move, once")
    failing = false
    const person = r.world.say(apex, "After the limit.")
    await until("their message", () => r.world.live.snapshot(apex)!.requests.find((request) => request.id === person)?.status === "completed")
    assert.equal(heard.filter((text) => text.includes(MOVED_LINE)).length, 1, "the Apex hears it, once")
    await r.world.close()
  }
  // A Fin placed on another account before the binding kept the pin has it on its edge alone: it comes onto the binding.
  {
    const held = accounts()
    held.claude[0]!.spentUntil = RESET
    const r = await run("old-edge-pin", { accounts: held, selected: { claude: "personal" }, start: { harness: "claude" }, fin: () => "Done." })
    assert.ok(!("refused" in r))
    await until("its first turn", () => r.world.live.session(r.fin())?.status === "ready")
    const control = r.world.live.snapshot(r.fin())!.control!
    for (const binding of control.bindings) delete binding.account
    delete held.claude[0]!.spentUntil
    await r.world.restart()
    await until("the pin back on its binding", () => r.world.live.pinnedAccount(r.fin(), "claude") === "work")
    const sent = await r.world.agents.send(r.world.caller(r.apex.conversation), { to: "labels", text: "After the upgrade.", clientKey: "after" })
    assert.ok(!("refused" in sent))
    await until("the message", () => r.world.prompts.some((prompt) => prompt.conversation === r.fin() && prompt.text.includes("After the upgrade.")))
    assert.equal(r.world.launches.filter((launch) => launch.conversation === r.fin()).at(-1)?.account, "work", "the account it was placed on, though the selected one has room again")
    await r.world.close()
  }
  console.log("a limit's notice: kept before it gathers, said once after a restart, and over at its reset on every surface")

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

  // A Stop while a hand-off prepares the next harness: retired, nothing handed off or sent.
  {
    let release!: () => void
    let preparing = false
    let limited = false
    const prepared = new Promise<void>((resolve) => (release = resolve))
    const held = accounts()
    held.claude = named("personal")
    const r = await run("stop-during-hand-off", {
      accounts: held,
      selected: { claude: "personal" },
      readingChoices: async (harness) => {
        if (!limited || harness !== "codex") return
        preparing = true
        await prepared
      },
      fin: (turn, end) => {
        if (turn === 1) {
          held.claude[0]!.spentUntil = RESET
          limited = true
          end({ limit: { resetsAt: RESET }, fail: LIMIT })
        }
        return "partial"
      },
    })
    assert.ok(!("refused" in r))
    await until("the hand-off to prepare Codex", () => preparing)
    const stopped = await r.world.agents.stop(r.world.caller(r.apex.conversation), { child: "labels" })
    assert.ok("stopped" in stopped && stopped.stopped.includes("labels"), JSON.stringify(stopped))
    release()
    await r.world.settle(400, 20_000, "ignore")
    assert.deepEqual(r.finTurns().map((turn) => turn.harness), ["claude"], "nothing handed off or sent")
    assert.equal(r.world.live.session(r.fin())?.harness, "claude")
    assert.equal(edgeOf(r).tuned?.rerouted, undefined)
    const turn = r.world.store.finTurn(edgeOf(r).child)
    assert.equal(turn?.moving, undefined, "the move is retired")
    assert.equal(turn?.handled.length, 1, "for good: that limit is never moved for again")
    await r.world.close()
  }
  console.log("a Stop while a hand-off prepares the next harness: retired, nothing handed off or sent")

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
    assert.match(line, /^Out of accounts until .+: work and personal$/, line)
    assert.equal(edgeOf(r).closedReason, line, "its stop says why in the same words")
    const stopped = r.world.agents.roster(r.apex.conversation)[0]!.child!.state!
    assert.equal(childGroup(stopped), "failed", "its work isn't finished, so it never reads as done")
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
