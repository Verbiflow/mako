import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ThreadIdSchema } from "@mako/host/contracts/thread-identity"
import { AgentsWorld } from "./lib/agents-world.ts"

/**
 * A deliberate Apex in the engine (`npm run test:apexes`): made with a first message, it reads that it's new and what
 * it is at its first turn; it starts Fins in parallel and one after another; its Fins message each other directly,
 * at most three an hour to one, while an ordinary Apex's still hand work on through it; and what needs the person
 * reaches its note at every turn, saying whether it changed.
 */
const root = mkdtempSync(join(tmpdir(), "mako-apex-shiver-"))

async function until(what: string, done: () => Promise<boolean> | boolean, timeoutMs = 15_000): Promise<void> {
  const end = Date.now() + timeoutMs
  while (!(await done())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

// Only a Fin holds its turn: an Apex's note names its Fins' briefs, and it must never hold on their words.
const apexes = new Set<string>()
const world = new AgentsWorld({
  root: join(root, "world"),
  script: async (turn) => {
    if (turn.text.includes("(hold)") && !apexes.has(turn.conversation)) await turn.world.hold(turn.conversation)
    return "ok"
  },
})
try {
  await world.apex("claude")
  const made = await world.apexes.create({ name: "Mobile", purpose: "The iOS and Android apps", cwd: world.root, harness: "claude", message: "You run the mobile work: TestFlight builds and crash fixes. Report PRs and blockers only.", clientKey: "mobile" }, "person")
  if ("refused" in made) throw new Error(JSON.stringify(made))
  const apex = made
  apexes.add(apex.conversation)
  await until("its first turn", () => world.prompts.some((prompt) => prompt.conversation === apex.conversation))
  const first = world.prompts.find((prompt) => prompt.conversation === apex.conversation)!.text
  assert.match(first, /You're Mobile, an Apex the person keeps for: The iOS and Android apps/, "its role, said once")
  assert.match(first, /You're new: your plan and rules are empty/, "it's told to write its purpose into its rules and plan")
  assert.match(first, /Your plan, Mobile's PLAN.md/, "its plan rides its turn")
  assert.match(first, /Nothing needs the person now/)
  assert.match(first, /You run the mobile work/, "the person's first message is the turn")
  const caller = world.caller(apex.conversation)
  await world.settle(300, 15_000, "ignore")

  // It writes its purpose into its rules and plan, as its note asked.
  for (const [layer, text] of [["apex", "Report PRs and blockers only."], ["fins", "Open PRs as drafts."]] as const) {
    const wrote = await world.apexes.act(caller, { action: "rules_write", layer, text, clientKey: layer })
    assert.ok("outcome" in wrote && wrote.outcome === "written", JSON.stringify(wrote))
  }

  // Parallel Fins, and one after another.
  const start = async (name: string, objective: string, after?: string[]) => {
    const started = await world.agents.start(caller, { brief: { objective }, harness: "claude", name, clientKey: name, cwd: world.root, ...(after && { after }) })
    assert.ok(!("refused" in started), JSON.stringify(started))
    return started
  }
  const crash = await start("crash", "Fix the launch crash (hold).")
  const icons = await start("icons", "Refresh the app icons (hold).")
  const notes = await start("notes", "Write the release notes once the crash fix is in.", ["crash"])
  assert.equal(notes.state, "queued", "a dependent Fin waits")
  assert.deepEqual(notes.after, ["crash"])
  await until("both parallel Fins to work", async () => {
    const listed = await world.agents.list(caller, {})
    return "children" in listed && ["crash", "icons"].every((name) => listed.children.find((child) => child.name === name)?.state.kind === "working")
  })
  const finBrief = world.prompts.find((prompt) => prompt.conversation === crash.conversation)!.text
  assert.match(finBrief, /You're a Fin of Mobile/, "a Fin knows its Apex and that it may message its siblings")
  assert.match(finBrief, /Open PRs as drafts\./, "a Fin reads its Apex's Fin rules")
  assert.ok(!finBrief.includes("Report PRs and blockers only."), "never the Apex's own")

  // A sibling message goes straight to the sibling, its words marked as a Fin's.
  const sent = await world.agents.send(world.caller(icons.conversation!), { to: "crash", text: "Which asset catalog did you touch? I'm editing Assets.xcassets.", deliver: "queue", clientKey: "ask-1" })
  assert.ok(!("refused" in sent), JSON.stringify(sent))
  assert.equal(sent.name, "crash")
  for (const key of ["ask-2", "ask-3"]) assert.ok(!("refused" in await world.agents.send(world.caller(icons.conversation!), { to: "crash", text: `More (${key}).`, clientKey: key })))
  const fourth = await world.agents.send(world.caller(icons.conversation!), { to: "crash", text: "One more.", clientKey: "ask-4" })
  assert.ok("refused" in fourth && fourth.refused === "rate-limited", "at most three an hour to one")
  const interrupt = await world.agents.send(world.caller(crash.conversation!), { to: "icons", text: "Stop.", deliver: "interrupt", clientKey: "i" })
  assert.ok("refused" in interrupt && interrupt.refused === "conflict", "a sibling's turn is its own to end")
  world.release(crash.conversation!)
  await until("the sibling to hear it", () => world.prompts.some((prompt) => prompt.conversation === crash.conversation && prompt.text.includes("Which asset catalog did you touch?") && prompt.text.includes("fin:icons, another Fin of your Apex")))

  // What needs the person reaches the Apex's note at its next turn, and says it changed.
  world.release(icons.conversation!)
  await until("icons to end its turn", async () => {
    const listed = await world.agents.list(caller, {})
    return "children" in listed && listed.children.find((child) => child.name === "icons")?.state.kind === "ended"
  })
  const asked = await world.agents.report(world.caller(icons.conversation!), { status: "needs-input", summary: "Two icon sets.", question: "Ship the rounded set or the flat one?", options: [{ label: "Rounded" }, { label: "Flat" }], clientKey: "q" })
  assert.ok(!("refused" in asked), JSON.stringify(asked))
  await world.agents.answer(caller, { to: "icons", person: true, clientKey: "leave" })
  world.say(apex.conversation, "How do things stand?")
  await until("the Apex's turn with Needs you", () => world.prompts.some((prompt) => prompt.conversation === apex.conversation && /Needs the person now \(changed since your last turn\):\n- fin:icons/.test(prompt.text)))

  // An ordinary Apex's Fins message each other directly too.
  const plain = await world.apex("codex")
  apexes.add(plain.conversation)
  const a = await world.agents.start(plain.caller, { brief: { objective: "One (hold)." }, harness: "claude", name: "a", clientKey: "a", cwd: world.root })
  const b = await world.agents.start(plain.caller, { brief: { objective: "Two (hold)." }, harness: "claude", name: "b", clientKey: "b", cwd: world.root })
  assert.ok(!("refused" in a) && !("refused" in b))
  const direct = await world.agents.send(world.caller(a.conversation!), { to: "b", text: "hi", clientKey: "x" })
  assert.ok(!("refused" in direct) && direct.name === "b", `an ordinary Apex's Fins message each other: ${JSON.stringify(direct)}`)
  world.release(a.conversation!)
  world.release(b.conversation!)
  // A Fin's brief names its mates' asks, so any of them may have held on another's words: let every one go.
  for (const of of [caller, plain.caller]) {
    const listed = await world.agents.list(of, { scope: "all" })
    if ("children" in listed) for (const child of listed.children) {
      const conversation = world.store.conversationsOf(world.store.thread(ThreadIdSchema.parse(child.child))!.sessions.at(-1)!).at(-1)
      if (conversation) world.release(conversation)
    }
  }
  await world.settle(300, 20_000, "ignore")
  console.log("apex shiver: a first message makes the Apex write its purpose; parallel and after; siblings message directly within limits; Needs you reaches its note")
} finally {
  await world.close()
  rmSync(root, { recursive: true, force: true })
}
