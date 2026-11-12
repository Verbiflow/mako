import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ProviderBinding, ResumeVerdict } from "@mako/host/contracts/conversation-control"
import { ThreadIdSchema } from "@mako/host/contracts/thread-identity"
import { carriedTuning } from "@mako/host/harnesses/harness-models"
import { AgentsWorld, type Script, type WorldOptions } from "./lib/agents-world.ts"
import { recordedCatalog } from "./model-catalogs.ts"

/**
 * A message to a Fin whose session can't be reopened, and a Fin's model on its own harness and across harnesses
 * (`npm run test:fin-reopen`), on a scratch host with scripted harnesses:
 * - a Fin whose harness never located its session's records takes a message in a new session of that harness with
 *   the whole conversation, and `agents_send` says so only once it did; a reopening that fails refuses the message;
 * - `agents_move` to the harness a Fin is on, naming a model, runs it on that model from its next turn, warm or after
 *   a restart;
 * - a move onto another harness never carries a model that harness doesn't list, nor another harness's encoding of one.
 */
const root = mkdtempSync(join(tmpdir(), "mako-fin-reopen-"))
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
let worlds = 0

async function until(what: string, done: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`)
    await pause(5)
  }
}

/** What `assessProviderResume` says of a binding: one whose records were never located can't be resumed, ever. */
const assessed = async (binding: ProviderBinding): Promise<ResumeVerdict> => binding.nativeId && binding.path
  ? { kind: "resumable", record: "same" }
  : { kind: "unavailable", reason: "The native session identity or source has not been located.", lost: true }

const catalogs = { claude: recordedCatalog("claude")!.models, cursor: recordedCatalog("cursor")!.models, codex: recordedCatalog("codex")!.models }

async function world(harness: string, options: Partial<WorldOptions> & { model?: string } = {}) {
  const script: Script = (turn) => turn.text.includes("You're fin:") ? "Labels finished." : "ok"
  const w = new AgentsWorld({ root: join(root, `w${(worlds += 1)}`), script, resumeVerdict: assessed, catalogs, ...options })
  const apex = await w.apex("claude", "full")
  const started = await w.agents.start(apex.caller, { brief: { objective: "Label everything" }, name: "labels", harness, cwd: w.root, clientKey: "labels", ...(options.model && { model: options.model }) })
  assert.ok(!("refused" in started), JSON.stringify(started))
  const child = started.child!
  await until("its first turn", () => w.prompts.some((prompt) => prompt.text.includes("You're fin:")))
  await w.settle(40, 20_000)
  const conversation = () => w.store.thread(ThreadIdSchema.parse(child))!.sessions.flatMap((session) => w.store.conversationsOf(session))[0]!
  const prompts = () => w.prompts.filter((prompt) => prompt.conversation === conversation())
  const send = (text: string) => w.agents.send(apex.caller, { to: "labels", text, clientKey: randomUUID() })
  const move = (to: string, extra: { model?: string; reasoning?: string; fast?: boolean } = {}) => w.agents.move(apex.caller, { child: "labels", harness: to, clientKey: randomUUID(), ...extra })
  return { w, apex, child, conversation, prompts, send, move }
}

/**
 * The Fins moved off Codex earlier: their Claude session was never located, and every message to them was lost, said
 * as "takes it now". `restart`: the host before closed its conversations on its way out; otherwise it ended without.
 */
async function lostSession(restart: "closed" | "crashed"): Promise<void> {
  const f = await world("claude", { unlocated: ["claude"] })
  const binding = () => f.w.live.snapshot(f.conversation())!.control!.bindings.find((each) => each.id === f.w.live.snapshot(f.conversation())!.control!.activeBindingId)!
  assert.ok(binding().nativeId && !binding().path, "the repro: a Claude binding with a native ID and no located records")
  // A new host: nothing holds the Fin's session open, so the message has to reopen it.
  await (restart === "closed" ? f.w.restart() : f.w.crashed())
  const before = f.prompts().length
  const said = await f.send("What did you label first?")
  assert.ok(!("refused" in said), `the message was refused: ${"refused" in said ? said.why : ""}`)
  assert.equal(said.delivery, "turn", said.hears)
  assert.match(said.hears, /opened labels's session again/)
  await until("the message to reach its harness", () => f.prompts().length === before + 1)
  const prompt = f.prompts().at(-1)!
  assert.equal(prompt.harness, "claude", "on its own harness")
  assert.ok(prompt.text.includes("What did you label first?"))
  const carried = f.w.live.snapshot(f.conversation())!.requests.filter((request) => request.context?.some((manifest) => manifest.includesBase))
  assert.equal(carried.length, 1, "the new session is handed the whole conversation, once")
  assert.ok(!f.w.live.snapshot(f.conversation())!.control!.transfers.some((transfer) => transfer.state.kind === "failed"), "nothing failed")
  await f.w.settle(40, 20_000)
  console.log(`lost session (${restart}): "${said.hears}"`)
  await f.w.close()
}

/** A reopening that fails is said as failed, never as taken. */
async function reopenFails(): Promise<void> {
  const f = await world("claude")
  // Its records are there but can't be read: the next host can't reopen it, and nothing goes on in its place.
  f.w.options.resumeVerdict = async () => ({ kind: "unavailable", reason: "Native session recovery evidence could not be read. Retry after its source is available." })
  await f.w.restart()
  const said = await f.send("Still there?")
  // That cause clears by itself, so the message waits to go again: said so, never as taken.
  assert.ok(!("refused" in said), JSON.stringify(said))
  assert.equal(said.delivery, "queued")
  assert.match(said.hears, /couldn't open labels's session yet \(.*could not be read.*\)\. This is saved and goes again by itself/)
  console.log(`reopen waits: "${said.hears}"`)
  await f.w.close()
  // One that doesn't clear (its harness is gone) refuses the message.
  const g = await world("claude")
  g.w.options.resumeVerdict = async () => ({ kind: "unavailable", reason: "The saved session's provider is not available." })
  await g.w.restart()
  const refused = await g.send("Still there?")
  assert.ok("refused" in refused, `said as taken: ${"hears" in refused ? refused.hears : ""}`)
  assert.equal(refused.refused, "unavailable")
  assert.match(refused.why, /didn't get this: Mako couldn't open its session\. .*provider is not available/)
  console.log(`reopen fails: refused, "${refused.why}"`)
  await g.w.close()
}

/** host-stall-fix: on Claude, on a model Claude refuses; `agents_move` to Claude with a model said "on Claude Code already". */
async function sameHarnessModel(): Promise<void> {
  const f = await world("claude", { model: "claude-opus-5-5" })
  const moved = await f.move("claude", { model: "claude-sonnet-5" })
  assert.ok(!("refused" in moved), JSON.stringify(moved))
  const one = moved.moved[0]!
  assert.notEqual(one.state, "here", `the repro: ${one.hears}`)
  assert.equal(one.state, "moved")
  assert.equal(one.runsOn, "claude-sonnet-5")
  assert.equal(f.w.store.edges().of(f.child)?.asked.model, "claude-sonnet-5", "its edge says what it runs on")
  const before = f.prompts().length
  const said = await f.send("Next batch, please.")
  assert.ok(!("refused" in said), JSON.stringify(said))
  await until("its next turn", () => f.prompts().length === before + 1)
  assert.equal(f.prompts().at(-1)!.settings?.model, "claude-sonnet-5", "its next turn runs on the model it was moved to")
  assert.equal(f.w.live.session(f.conversation())?.harness, "claude", "in the same harness")
  await f.w.settle(40, 20_000)
  // A message after that one names nothing: the process runs on what it was tuned to.
  const after = f.prompts().length
  await f.send("And the one after.")
  await until("the turn after", () => f.prompts().length === after + 1)
  assert.equal(f.prompts().at(-1)!.settings, undefined, "the retune rides one message, once")
  await f.w.settle(40, 20_000)
  // After a restart the session reopens on it.
  await f.w.restart()
  const starts = f.w.starts.length
  await f.send("After the restart.")
  await until("its session to reopen", () => f.w.starts.slice(starts).some((start) => start.conversation === f.conversation()))
  assert.equal(f.w.starts.slice(starts).find((start) => start.conversation === f.conversation())!.tuning?.model, "claude-sonnet-5", "a reopened session starts on it")
  const unknown = await f.move("claude", { model: "gpt-6.1-sol" })
  assert.ok("refused" in unknown || "refused" in (unknown.left?.[0] ?? {}), `a model Claude doesn't list is refused: ${JSON.stringify(unknown)}`)
  const again = await f.move("claude")
  assert.ok(!("refused" in again) && again.moved[0]!.state === "here", "a move naming nothing new is still a no-op")
  await f.w.settle(40, 20_000)
  console.log(`same harness: "${one.hears}"`)
  await f.w.close()
}

/** host-stall-fix's model came from Cursor (`claude-opus-5-5[cyber=false,...]`), borrow-build's from Codex (`gpt-6.1-sol`). */
async function carriedAcross(): Promise<void> {
  const claude = catalogs.claude
  assert.deepEqual(carriedTuning(claude, { model: "claude-opus-5-5[cyber=false,context=1m,effort=medium,fast=false]", options: { plan: false, fast: false } }), { model: "claude-opus-5-5", options: { fast: false } }, "Cursor's encoding goes as the model it names, with the options Claude has")
  assert.equal(carriedTuning(claude, { model: "gpt-6.1-sol", options: { effort: "high" } }), undefined, "a model Claude doesn't list goes as nothing")
  assert.deepEqual(carriedTuning(claude, { model: "claude-opus-5-5[1m]" }), { model: "claude-opus-5-5[1m]" }, "Claude's own bracketed alias stays")
  assert.deepEqual(carriedTuning(undefined, { model: "claude-opus-5-5[context=1m,fast=false]", options: { plan: false } }), { model: "claude-opus-5-5" }, "unread, only an encoding is dropped")
  assert.deepEqual(carriedTuning(undefined, { model: "claude-opus-5-5[1m]" }), { model: "claude-opus-5-5[1m]" })
  for (const [from, model, expected] of [
    ["cursor", "claude-opus-5-5[cyber=false,context=1m,effort=medium,fast=false]", "claude-opus-5-5"],
    ["codex", "gpt-6.1-sol", undefined],
  ] as const) {
    const f = await world(from)
    const id = randomUUID()
    const starts = f.w.starts.length
    const snapshot = await f.w.continueOn(f.conversation(), { kind: "move", move: { id, to: { harness: "claude", tuning: { model, options: { plan: false } } } } })
    assert.ok(snapshot)
    await until("the move to land", () => f.w.live.session(f.conversation())?.harness === "claude" && !f.w.live.switching(f.conversation()))
    await f.send("Go on.")
    await until("its Claude session", () => f.w.starts.slice(starts).some((start) => start.conversation === f.conversation() && start.harness === "claude"))
    const start = f.w.starts.slice(starts).find((each) => each.conversation === f.conversation() && each.harness === "claude")!
    assert.equal(start.tuning?.model, expected, `${from}'s ${model} onto Claude`)
    await f.w.settle(40, 20_000)
    console.log(`carried from ${from}: ${model} -> ${start.tuning?.model ?? "Claude's default"}`)
    await f.w.close()
  }
}

/** `CASE=<name>` runs that one alone. */
const cases = { lostAfterExit: () => lostSession("closed"), lostAfterCrash: () => lostSession("crashed"), reopenFails, sameHarnessModel, carriedAcross }
try {
  for (const [name, run] of Object.entries(cases)) if (!process.env.CASE || process.env.CASE === name) await run()
  console.log("fin reopen ok")
} finally {
  rmSync(root, { recursive: true, force: true })
}
