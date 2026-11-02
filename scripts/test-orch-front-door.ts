import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { FRONT_DOOR_LISTED, frontDoorNote, type FrontDoorChild } from "@mako/host/contracts/agent-tools"
import { agentWords, PASSED_ON_NOTE, passedOn, routedCall } from "@mako/host/contracts/children"
import { ThreadIdSchema } from "@mako/host/contracts/thread-identity"
import { FROM_AGENTS } from "@mako/host/conversations/agent-wakes"
import { AgentsWorld, type Script } from "./lib/agents-world.ts"

/**
 * The lead as the Thread's front door (`npm run test:orch-front-door`): the
 * person writes to the lead, which hears its Threads as they stand ahead of
 * the message and passes it on with `agents_send`. The person's words reach
 * the child word for word, as theirs; a finished child takes them as its next
 * task in its own Thread; a stopped one is refused; a running one hears them
 * at its next step or after its turn, as its harness takes a message; a
 * repeat is the same message; the person can move one to another child; and
 * a Thread's children are heard by the Session the person last wrote in.
 */
const root = mkdtempSync(join(tmpdir(), "mako-orch-front-door-"))
const LEAD_LINE = "You're this Thread's lead"

async function until(what: string, done: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

function promptsOf(world: AgentsWorld, conversation: string) {
  return world.prompts.filter((prompt) => prompt.conversation === conversation)
}

/** The person's words as a prompt ends with them, past Mako's note. */
function spoken(text: string): string {
  return text.replace(/^<mako-local-control>[\s\S]*?<\/mako-local-control>\n\n/, "")
}

/** A lead on Codex with an Android child on Claude and an iOS child on Cursor, both finished. */
async function team(name: string, script: Script) {
  const world = new AgentsWorld({ root: join(root, name), script })
  const lead = await world.lead("codex")
  const android = await world.agents.start(lead.caller, { brief: { objective: "Fix the Android build settings. Gradle fails on API 34." }, harness: "claude", name: "android", clientKey: "android", cwd: world.root })
  const ios = await world.agents.start(lead.caller, { brief: { objective: "Ship the iOS share sheet." }, harness: "cursor", name: "ios", clientKey: "ios", cwd: world.root })
  assert.ok(!("refused" in android) && android.conversation && !("refused" in ios) && ios.conversation)
  await world.settle()
  return { world, lead, android: android.conversation!, ios: ios.conversation! }
}

/** A lead that passes on whatever names one of its Threads, and answers the rest itself. */
function frontDoorScript(children: () => string[]): Script {
  return async (turn) => {
    if (children().includes(turn.conversation)) return `Done: ${turn.harness} did it.`
    const said = spoken(turn.text)
    if (!turn.text.includes(LEAD_LINE)) return "ok"
    const to = /android|gradle/i.test(said) ? "android" : /ios|share sheet/i.test(said) ? "ios" : undefined
    if (!to) return "I'll answer this one myself."
    const sent = await turn.world.agents.send(turn.caller, { to, forward: true, clientKey: `route:${said}` })
    assert.ok(!("refused" in sent), JSON.stringify(sent))
    return `Sent to ${to}.`
  }
}

/** The person's message reaches the child it's for, word for word, as theirs; the other hears nothing; the lead heard both first. */
async function forwardsToTheRightChild(): Promise<void> {
  let kids: string[] = []
  const { world, lead, android, ios } = await team("forward", frontDoorScript(() => kids))
  kids = [android, ios]
  try {
    const iosBefore = promptsOf(world, ios).length
    const words = "Gradle still fails on API 34 after the bump.\nThe log says the namespace is missing."
    world.say(lead.conversation, words)
    await world.settle()
    const heard = promptsOf(world, lead.conversation).find((prompt) => prompt.text.endsWith(words))!.text
    assert.match(heard, /^<mako-local-control>/, "the lead hears its Threads in Mako's note, never as the person's words")
    assert.ok(heard.includes(LEAD_LINE))
    assert.match(heard, /- child:android · Claude · done[^·]*· asked: Fix the Android build settings\./)
    assert.match(heard, /- child:ios · Cursor · done[^·]*· asked: Ship the iOS share sheet\./)
    assert.ok(heard.endsWith(words), "the person's words close the lead's prompt unchanged")
    const passed = promptsOf(world, android)
    assert.equal(passed.length, 2, "its brief, then the person's message as its next turn")
    const read = agentWords(spoken(passed[1]!.text))
    assert.deepEqual(read, { from: "your lead", body: words, passedOn: {} }, "word for word, marked as the person's, passed on by the lead")
    assert.equal(promptsOf(world, ios).length, iosBefore, "the other child hears nothing")
    assert.equal(world.store.edges().children(world.store.journalPlacement(lead.conversation)!.thread).length, 2, "no new child: the finished one took it in its own Thread")
    assert.equal(world.agents.diagnostics().routes.forwarded, 1)
  } finally {
    await world.close()
  }
}

/** A repeat of a send is the same message; a stopped child is refused; words of the lead's own go as the lead's. */
async function repeatsStopsAndOwnWords(): Promise<void> {
  let kids: string[] = []
  const { world, lead, android, ios } = await team("repeat", async (turn) => (kids.includes(turn.conversation) ? "Done." : "ok"))
  kids = [android, ios]
  try {
    world.say(lead.conversation, "Tell android to rebase on main.")
    await world.settle()
    const first = await world.agents.send(lead.caller, { to: "child:android", forward: true, text: "Main moved an hour ago.", clientKey: "k1" })
    const again = await world.agents.send(lead.caller, { to: "child:android", forward: true, text: "Main moved an hour ago.", clientKey: "k1" })
    assert.ok(!("refused" in first) && !("refused" in again))
    assert.equal(again.request, first.request)
    assert.equal(again.deduped, true)
    await world.settle()
    const passed = promptsOf(world, android).at(-1)!.text
    assert.equal(spoken(passed), `${passedOn("your lead")}\nTell android to rebase on main.\n\n${PASSED_ON_NOTE}\nMain moved an hour ago.`)
    assert.deepEqual(agentWords(spoken(passed))?.passedOn, { added: "Main moved an hour ago." })
    assert.equal(promptsOf(world, android).length, 2, "once")
    const own = await world.agents.send(lead.caller, { to: "ios", text: "Pause after the share sheet lands.", clientKey: "k2" })
    assert.ok(!("refused" in own))
    await world.settle()
    assert.deepEqual(agentWords(spoken(promptsOf(world, ios).at(-1)!.text)), { from: "your lead", body: "Pause after the share sheet lands." })
    const empty = await world.agents.send(lead.caller, { to: "ios", clientKey: "k3" })
    assert.equal("refused" in empty && empty.refused, "conflict", "neither words nor forward")
    await world.agents.stop(lead.caller, { child: "ios" })
    const stopped = await world.agents.send(lead.caller, { to: "ios", text: "One more thing.", clientKey: "k4" })
    assert.equal("refused" in stopped && stopped.refused, "conflict", "a stopped Thread's delegation stays over")
    assert.match("refused" in stopped ? stopped.why : "", /agents_start/)
    const stranger = await world.agents.send(lead.caller, { to: "web", text: "Hi.", clientKey: "k5" })
    assert.equal("refused" in stranger && stranger.refused, "unknown-child")
    const person = await world.agents.send({ kind: "person" }, { to: "android", text: "Hi.", clientKey: "k6" })
    assert.equal("refused" in person && person.refused, "no-parent")
  } finally {
    await world.close()
  }
}

/** A running child hears it at its next step where its harness steers there (Claude), after its turn where it doesn't (Cursor). */
async function steerOrQueue(): Promise<void> {
  let kids: string[] = []
  let busy = false
  const { world, lead, android, ios } = await team("steer", async (turn) => {
    if (kids.includes(turn.conversation) && busy) await turn.world.hold(turn.conversation)
    return "Done."
  })
  kids = [android, ios]
  try {
    busy = true
    world.live.submit(android, randomUUID(), "Next: the release build.", [])
    world.live.submit(ios, randomUUID(), "Next: the widget.", [])
    await until("both children at work", () => [android, ios].every((child) => world.live.snapshot(child)?.session.status === "running"))
    world.say(lead.conversation, "Also bump the target SDK.")
    await until("the lead's turn", () => promptsOf(world, lead.conversation).some((prompt) => prompt.text.endsWith("Also bump the target SDK.")))
    const steered = await world.agents.send(lead.caller, { to: "android", forward: true, clientKey: "s1" })
    const queued = await world.agents.send(lead.caller, { to: "ios", forward: true, clientKey: "s2" })
    assert.ok(!("refused" in steered) && !("refused" in queued))
    assert.equal(steered.delivery, "steer")
    assert.equal(queued.delivery, "queued")
    await until("the steer", () => world.steers.some((steer) => steer.conversation === android))
    assert.equal(agentWords(world.steers.find((steer) => steer.conversation === android)!.text)?.body, "Also bump the target SDK.")
    const before = promptsOf(world, ios).length
    busy = false
    world.release(android)
    world.release(ios)
    await world.settle()
    assert.equal(promptsOf(world, ios).length, before + 1, "Cursor takes it as its next turn")
    assert.equal(agentWords(spoken(promptsOf(world, ios).at(-1)!.text))?.body, "Also bump the target SDK.")
  } finally {
    await world.close()
  }
}

/** The note goes only ahead of the person's messages to a lead: never a wake, never a Thread without children. */
async function onlyThePersonsTurnsOfALead(): Promise<void> {
  const world = new AgentsWorld({ root: join(root, "only"), script: async (turn) => (turn.text.includes("child:") ? "Done: it's fixed." : "ok") })
  try {
    const plain = await world.lead("claude")
    world.say(plain.conversation, "Hello there.")
    await world.settle()
    assert.ok(!promptsOf(world, plain.conversation).at(-1)!.text.includes(LEAD_LINE), "a Thread without children hears no note")
    const lead = await world.lead("codex")
    await world.agents.start(lead.caller, { brief: { objective: "Fix it." }, harness: "grok", name: "fixer", clientKey: "f", cwd: world.root })
    await world.settle()
    const wakes = promptsOf(world, lead.conversation).filter((prompt) => spoken(prompt.text).startsWith(FROM_AGENTS))
    assert.ok(wakes.length >= 1, "the child's report woke the lead")
    assert.ok(wakes.every((wake) => !wake.text.includes(LEAD_LINE)), "a wake carries no front-door note")
    world.say(lead.conversation, "How is it going?")
    await world.settle()
    assert.ok(promptsOf(world, lead.conversation).find((prompt) => prompt.text.endsWith("How is it going?"))!.text.includes("- child:fixer · Grok · done"))
  } finally {
    await world.close()
  }
}

/** What the person says to a child in its own Thread, its lead hears in its next note, and a redirect moves a queued message. */
async function directTalkAndRedirect(): Promise<void> {
  let kids: string[] = []
  let busy = false
  const { world, lead, android, ios } = await team("direct", async (turn) => {
    if (kids.includes(turn.conversation) && busy) await turn.world.hold(turn.conversation)
    return "ok"
  })
  kids = [android, ios]
  try {
    world.say(android, "Use the new signing key from the vault.")
    await world.settle()
    world.say(lead.conversation, "Where are we?")
    await world.settle()
    assert.match(promptsOf(world, lead.conversation).find((prompt) => prompt.text.endsWith("Where are we?"))!.text, /child:android · .* the person wrote to it directly (just now|\d+m ago): "Use the new signing key from the vault\."/)
    busy = true
    world.live.submit(ios, randomUUID(), "Next: the widget.", [])
    await until("iOS at work", () => world.live.snapshot(ios)?.session.status === "running")
    world.say(lead.conversation, "The share sheet crashes on Android 15.")
    await until("the lead's turn", () => promptsOf(world, lead.conversation).some((prompt) => prompt.text.endsWith("The share sheet crashes on Android 15.")))
    const sent = await world.agents.send(lead.caller, { to: "ios", forward: true, clientKey: "wrong" })
    assert.ok(!("refused" in sent) && sent.delivery === "queued")
    const moved = await world.agents.redirect(lead.conversation, { from: "ios", request: sent.request, to: "android" })
    assert.ok(!("refused" in moved), JSON.stringify(moved))
    assert.equal(moved.withdrawn, true)
    assert.equal(world.live.snapshot(ios)!.requests.find((request) => request.id === sent.request)?.status, "canceled", "it left the child it was wrong for")
    const again = await world.agents.redirect(lead.conversation, { from: "ios", request: sent.request, to: "android" })
    assert.ok(!("refused" in again) && again.withdrawn, "a repeat moves nothing twice")
    busy = false
    world.release(ios)
    world.release(android)
    await world.settle()
    const landed = promptsOf(world, android).filter((prompt) => spoken(prompt.text) === "The share sheet crashes on Android 15.")
    assert.equal(landed.length, 1, "once, as the person's own words")
    assert.equal(world.live.snapshot(android)!.requests.at(-1)!.actor?.kind, "person")
    assert.equal(world.agents.diagnostics().routes.redirected, 1)
  } finally {
    await world.close()
  }
}

/** A Thread with two Sessions: its children's reports wake the Session the person last wrote in, and that one routes. */
/** A result a Session waited for, while the person wrote in another of the Thread's Sessions, wakes neither: the Thread heard it in the answer. */
async function waitedResultWakesNoSession(): Promise<void> {
  const leads = new Set<string>()
  const answers: unknown[] = []
  let open!: () => void
  const gate = new Promise<void>((resolve) => (open = resolve))
  const world = new AgentsWorld({
    root: join(root, "waited"),
    script: async (turn) => {
      if (!leads.has(turn.conversation)) {
        await gate
        await turn.world.agents.report(turn.caller, { status: "done", summary: "12 files.", clientKey: "r" })
        return "Reported."
      }
      if (turn.text.endsWith("go")) answers.push(await turn.world.agents.start(turn.caller, { brief: { objective: "Count the files." }, harness: "codex", name: "count", mode: "wait", clientKey: "w", cwd: turn.world.root }))
      return "ok"
    },
  })
  try {
    const first = await world.lead("claude")
    leads.add(first.conversation)
    world.say(first.conversation, "go")
    await until("the child's turn", () => world.prompts.some((prompt) => !leads.has(prompt.conversation)))
    const thread = ThreadIdSchema.parse(world.store.journalPlacement(first.conversation)!.thread)
    const placed = world.store.createSession({ operationId: randomUUID(), thread, actor: world.store.person() })
    const second = randomUUID()
    leads.add(second)
    await world.live.start("cursor", world.root, { conversationId: second, session: placed.session })
    world.say(second, "Anything new?")
    await until("the second Session's turn", () => promptsOf(world, second).length === 1)
    open()
    await until("the waited answer", () => answers.length === 1)
    await world.settle()
    for (const conversation of [first.conversation, second])
      assert.equal(promptsOf(world, conversation).filter((prompt) => spoken(prompt.text).startsWith(FROM_AGENTS)).length, 0, "the result came in the answer, so no Session is woken with it")
    assert.equal(world.store.undeliveredReports().length, 0)
  } finally {
    await world.close()
  }
}

async function frontSessionHears(): Promise<void> {
  let kids: string[] = []
  let gate: Promise<void> | undefined
  const world = new AgentsWorld({
    root: join(root, "sessions"),
    script: async (turn) => {
      if (kids.includes(turn.conversation)) {
        await gate
        return "Done: the build is green."
      }
      return "ok"
    },
  })
  try {
    const first = await world.lead("claude")
    let open!: () => void
    gate = new Promise((resolve) => (open = resolve))
    const started = await world.agents.start(first.caller, { brief: { objective: "Get the build green." }, harness: "codex", name: "build", clientKey: "b", cwd: world.root })
    assert.ok(!("refused" in started) && started.conversation)
    kids = [started.conversation!]
    const thread = ThreadIdSchema.parse(world.store.journalPlacement(first.conversation)!.thread)
    const placed = world.store.createSession({ operationId: randomUUID(), thread, actor: world.store.person() })
    const second = randomUUID()
    await world.live.start("cursor", world.root, { conversationId: second, session: placed.session })
    assert.equal(world.store.journalPlacement(second)?.thread, thread, "one Thread, two Sessions")
    world.say(second, "Is the build green yet?")
    await until("the second Session's turn", () => promptsOf(world, second).length === 1)
    assert.ok(promptsOf(world, second)[0]!.text.includes("- child:build · Codex"), "the Session the person writes in hears its Thread's children")
    const sent = await world.agents.send(world.caller(second), { to: "build", forward: true, clientKey: "s" })
    assert.ok(!("refused" in sent), "and routes to them: children are the Thread's")
    open()
    await world.settle()
    const wokeFirst = promptsOf(world, first.conversation).filter((prompt) => spoken(prompt.text).startsWith(FROM_AGENTS))
    const wokeSecond = promptsOf(world, second).filter((prompt) => spoken(prompt.text).startsWith(FROM_AGENTS))
    assert.equal(wokeFirst.length, 0, "the Session the person left hears nothing")
    assert.ok(wokeSecond.length >= 1, "the report wakes the Session the person last wrote in")
  } finally {
    await world.close()
  }
}

/** What the note lists: what a message is likeliest for first, and a big team counted past `FRONT_DOOR_LISTED`. */
function noteListing(): void {
  const now = 10 * 60_000
  const child = (name: string, kind: "working" | "idle", at = now): FrontDoorChild => ({
    name,
    harness: "Codex",
    state: kind === "working" ? { kind: "working", phase: "Running the tests" } : { kind: "idle" },
    topic: `Own ${name}.`,
    report: { status: "progress", line: "Half done", at },
  })
  const lines = frontDoorNote([child("docs", "idle"), child("api", "working", now - 3 * 60_000)], now)
  assert.ok(lines[1]!.startsWith("- child:api · Codex · working: Running the tests"), JSON.stringify(lines))
  assert.match(lines[1]!, /last report \(progress, 3m ago\): Half done/)
  const many = frontDoorNote(Array.from({ length: 20 }, (_, index) => child(`area-${index}`, "working")), now)
  assert.equal(many.filter((line) => line.startsWith("- child:")).length, FRONT_DOOR_LISTED)
  assert.ok(many.includes("… and 4 more (agents_list)."))
  assert.equal(frontDoorNote([], now).length, 0)
}

/** The transcript reads a routing call the same from every harness's decoded call, and nothing else as one. */
function routedCalls(): void {
  const call = (server: string, tool: string, args: Record<string, string | boolean>) =>
    routedCall({ type: "toolCall", id: "c", tool: { kind: "mcp", name: `${server}.${tool}`, label: tool, server, tool }, arguments: args })
  assert.deepEqual(call("mako", "agents_send", { to: "child:android", forward: true, clientKey: "k" }), { to: "android", forward: true })
  assert.deepEqual(call("mako", "agents_send", { to: "ios", text: " Pause it. ", clientKey: "k" }), { to: "ios", forward: false, text: "Pause it." })
  assert.equal(call("mako", "agents_start", { to: "ios" }), undefined)
  assert.equal(call("github", "agents_send", { to: "ios" }), undefined)
  assert.equal(call("mako", "agents_send", { forward: true }), undefined)
}

try {
  noteListing()
  routedCalls()
  for (const test of [forwardsToTheRightChild, repeatsStopsAndOwnWords, steerOrQueue, onlyThePersonsTurnsOfALead, directTalkAndRedirect, frontSessionHears, waitedResultWakesNoSession]) {
    await test()
    console.log(`ok ${test.name}`)
  }
  console.log("test:orch-front-door ok")
} finally {
  rmSync(root, { recursive: true, force: true })
}
