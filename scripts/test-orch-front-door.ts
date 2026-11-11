import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { FRONT_DOOR_GUIDANCE, FRONT_DOOR_LISTED, frontDoorNote, type FrontDoorChild } from "@mako/host/contracts/agent-tools"
import { CONTEXT_COMPACTED } from "@mako/host/contracts/native-activity"
import { agentWords, PASSED_ON_NOTE, passedOn, routedCall, YOUR_APEX } from "@mako/host/contracts/children"
import { ThreadIdSchema } from "@mako/host/contracts/thread-identity"
import { FROM_AGENTS } from "@mako/host/conversations/agent-wakes"
import { AgentsWorld, type Script } from "./lib/agents-world.ts"

/**
 * The Apex as the Thread's front door (`npm run test:orch-front-door`): the
 * person writes to the Apex, which hears its Fins as they stand ahead of
 * the message and passes it on with `agents_send`. The person's words reach
 * the Fin word for word, as theirs; a finished Fin takes them as its next
 * task in its own Thread; a stopped one is refused; a running one hears them
 * at its next step or after its turn, as its harness takes a message; a
 * repeat is the same message; the person can move one to another Fin, or
 * write to one straight from the Apex's conversation with no turn of the
 * Apex's; and a Thread's Fins are heard by the Session the person last
 * wrote in.
 */
const root = mkdtempSync(join(tmpdir(), "mako-orch-front-door-"))
const APEX_LINE = "You're this Thread's Apex"

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

/** An Apex on Codex with an Android child on Claude and an iOS child on Cursor, both finished. */
async function team(name: string, script: Script) {
  const world = new AgentsWorld({ root: join(root, name), script })
  const apex = await world.apex("codex")
  const android = await world.agents.start(apex.caller, { brief: { objective: "Fix the Android build settings. Gradle fails on API 34." }, harness: "claude", name: "android", clientKey: "android", cwd: world.root })
  const ios = await world.agents.start(apex.caller, { brief: { objective: "Ship the iOS share sheet." }, harness: "cursor", name: "ios", clientKey: "ios", cwd: world.root })
  assert.ok(!("refused" in android) && android.conversation && !("refused" in ios) && ios.conversation)
  await world.settle()
  return { world, apex, android: android.conversation!, ios: ios.conversation! }
}

/** An Apex that passes on whatever names one of its Fins, and answers the rest itself. */
function frontDoorScript(children: () => string[]): Script {
  return async (turn) => {
    if (children().includes(turn.conversation)) return `Done: ${turn.harness} did it.`
    const said = spoken(turn.text)
    if (!turn.text.includes(APEX_LINE)) return "ok"
    const to = /android|gradle/i.test(said) ? "android" : /ios|share sheet/i.test(said) ? "ios" : undefined
    if (!to) return "I'll answer this one myself."
    const sent = await turn.world.agents.send(turn.caller, { to, forward: true, clientKey: `route:${said}` })
    assert.ok(!("refused" in sent), JSON.stringify(sent))
    return `Sent to ${to}.`
  }
}

/** The person's message reaches the child it's for, word for word, as theirs; the other hears nothing; the Apex heard both first. */
async function forwardsToTheRightChild(): Promise<void> {
  let kids: string[] = []
  const { world, apex, android, ios } = await team("forward", frontDoorScript(() => kids))
  kids = [android, ios]
  try {
    const iosBefore = promptsOf(world, ios).length
    const words = "Gradle still fails on API 34 after the bump.\nThe log says the namespace is missing."
    world.say(apex.conversation, words)
    await world.settle()
    const heard = promptsOf(world, apex.conversation).find((prompt) => prompt.text.endsWith(words))!.text
    assert.match(heard, /^<mako-local-control>/, "the Apex hears its Threads in Mako's note, never as the person's words")
    assert.ok(heard.includes(APEX_LINE))
    assert.match(heard, /- fin:android · Claude · done[^·]*· asked: Fix the Android build settings\./)
    assert.match(heard, /- fin:ios · Cursor · done[^·]*· asked: Ship the iOS share sheet\./)
    assert.ok(heard.endsWith(words), "the person's words close the Apex's prompt unchanged")
    const passed = promptsOf(world, android)
    assert.equal(passed.length, 2, "its brief, then the person's message as its next turn")
    const read = agentWords(spoken(passed[1]!.text))
    assert.deepEqual(read, { from: "your Apex", body: words, passedOn: {} }, "word for word, marked as the person's, passed on by the Apex")
    assert.equal(promptsOf(world, ios).length, iosBefore, "the other child hears nothing")
    assert.equal(world.store.edges().children(world.store.journalPlacement(apex.conversation)!.thread).length, 2, "no new child: the finished one took it in its own Thread")
    assert.equal(world.agents.diagnostics().routes.forwarded, 1)
  } finally {
    await world.close()
  }
}

/** A repeat of a send is the same message; a stopped child is refused; words of the Apex's own go as the Apex's. */
async function repeatsStopsAndOwnWords(): Promise<void> {
  let kids: string[] = []
  const { world, apex, android, ios } = await team("repeat", async (turn) => (kids.includes(turn.conversation) ? "Done." : "ok"))
  kids = [android, ios]
  try {
    world.say(apex.conversation, "Tell android to rebase on main.")
    await world.settle()
    const first = await world.agents.send(apex.caller, { to: "child:android", forward: true, text: "Main moved an hour ago.", clientKey: "k1" })
    const again = await world.agents.send(apex.caller, { to: "fin:android", forward: true, text: "Main moved an hour ago.", clientKey: "k1" })
    assert.ok(!("refused" in first) && !("refused" in again))
    assert.equal(again.request, first.request)
    assert.equal(again.deduped, true)
    await world.settle()
    const passed = promptsOf(world, android).at(-1)!.text
    assert.equal(spoken(passed), `${passedOn(YOUR_APEX)}\nTell android to rebase on main.\n\n${PASSED_ON_NOTE}\nMain moved an hour ago.`)
    assert.deepEqual(agentWords(spoken(passed))?.passedOn, { added: "Main moved an hour ago." })
    assert.equal(promptsOf(world, android).length, 2, "once")
    const own = await world.agents.send(apex.caller, { to: "ios", text: "Pause after the share sheet lands.", clientKey: "k2" })
    assert.ok(!("refused" in own))
    await world.settle()
    assert.deepEqual(agentWords(spoken(promptsOf(world, ios).at(-1)!.text)), { from: "your Apex", body: "Pause after the share sheet lands." })
    const empty = await world.agents.send(apex.caller, { to: "ios", clientKey: "k3" })
    assert.equal("refused" in empty && empty.refused, "conflict", "neither words nor forward")
    await world.agents.stop(apex.caller, { child: "ios" })
    const resumed = await world.agents.send(apex.caller, { to: "ios", text: "One more thing.", clientKey: "k4" })
    assert.ok(!("refused" in resumed), "a stop is a pause: a message resumes it")
    await world.settle()
    assert.match(promptsOf(world, ios).at(-1)!.text, /One more thing\.\n\n\[mako · resumed after a stop just now\]/, "beneath an account of its stop")
    const stranger = await world.agents.send(apex.caller, { to: "web", text: "Hi.", clientKey: "k5" })
    assert.equal("refused" in stranger && stranger.refused, "unknown-child")
    const person = await world.agents.send({ kind: "person" }, { to: "android", text: "Hi.", clientKey: "k6" })
    assert.equal("refused" in person && person.refused, "no-parent")
  } finally {
    await world.close()
  }
}

/** Steered, a running child hears it at its next step where its harness steers (Claude), after its turn where it takes no steer (Cursor here). */
async function steerOrQueue(): Promise<void> {
  let kids: string[] = []
  let busy = false
  const { world, apex, android, ios } = await team("steer", async (turn) => {
    if (kids.includes(turn.conversation) && busy) await turn.world.hold(turn.conversation)
    return "Done."
  })
  kids = [android, ios]
  try {
    busy = true
    world.live.submit(android, randomUUID(), "Next: the release build.", [])
    world.live.submit(ios, randomUUID(), "Next: the widget.", [])
    await until("both children at work", () => [android, ios].every((child) => world.live.snapshot(child)?.session.status === "running"))
    world.say(apex.conversation, "Also bump the target SDK.")
    await until("the Apex's turn", () => promptsOf(world, apex.conversation).some((prompt) => prompt.text.endsWith("Also bump the target SDK.")))
    const steered = await world.agents.send(apex.caller, { to: "android", forward: true, deliver: "steer", clientKey: "s1" })
    const queued = await world.agents.send(apex.caller, { to: "ios", forward: true, deliver: "steer", clientKey: "s2" })
    assert.ok(!("refused" in steered) && !("refused" in queued))
    assert.equal(steered.delivery, "steer")
    assert.equal(steered.hears, "android hears it at its next step, once what it's running now returns (Claude).")
    assert.equal(queued.delivery, "queued")
    assert.equal(queued.hears, "ios hears it when its current turn ends, as its next message: Cursor takes no message into a running turn.")
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

/** The note goes only ahead of the person's messages to an Apex: never a wake, never a Thread without children. */
async function onlyThePersonsTurnsOfAnApex(): Promise<void> {
  const world = new AgentsWorld({ root: join(root, "only"), script: async (turn) => (turn.text.includes("You're fin:") ? "Done: it's fixed." : "ok") })
  try {
    const plain = await world.apex("claude")
    world.say(plain.conversation, "Hello there.")
    await world.settle()
    assert.ok(!promptsOf(world, plain.conversation).at(-1)!.text.includes(APEX_LINE), "a Thread without children hears no note")
    const apex = await world.apex("codex")
    await world.agents.start(apex.caller, { brief: { objective: "Fix it." }, harness: "grok", name: "fixer", clientKey: "f", cwd: world.root })
    await world.settle()
    const wakes = promptsOf(world, apex.conversation).filter((prompt) => spoken(prompt.text).startsWith(FROM_AGENTS))
    assert.ok(wakes.length >= 1, "the child's report woke the Apex")
    assert.ok(wakes.every((wake) => !wake.text.includes(APEX_LINE)), "a wake carries no front-door note")
    world.say(apex.conversation, "How is it going?")
    await world.settle()
    assert.ok(promptsOf(world, apex.conversation).find((prompt) => prompt.text.endsWith("How is it going?"))!.text.includes("- fin:fixer · Grok · done"))
  } finally {
    await world.close()
  }
}

/** What the person says to a child in its own Thread, its Apex hears in its next note, and a redirect moves a queued message. */
async function directTalkAndRedirect(): Promise<void> {
  let kids: string[] = []
  let busy = false
  const { world, apex, android, ios } = await team("direct", async (turn) => {
    if (kids.includes(turn.conversation) && busy) await turn.world.hold(turn.conversation)
    return "ok"
  })
  kids = [android, ios]
  try {
    world.say(android, "Use the new signing key from the vault.")
    await world.settle()
    world.say(apex.conversation, "Where are we?")
    await world.settle()
    assert.match(promptsOf(world, apex.conversation).find((prompt) => prompt.text.endsWith("Where are we?"))!.text, /fin:android · .* the person wrote to it directly (just now|\d+m ago): "Use the new signing key from the vault\."/)
    busy = true
    world.live.submit(ios, randomUUID(), "Next: the widget.", [])
    await until("iOS at work", () => world.live.snapshot(ios)?.session.status === "running")
    world.say(apex.conversation, "The share sheet crashes on Android 15.")
    await until("the Apex's turn", () => promptsOf(world, apex.conversation).some((prompt) => prompt.text.endsWith("The share sheet crashes on Android 15.")))
    const sent = await world.agents.send(apex.caller, { to: "ios", forward: true, clientKey: "wrong" })
    assert.ok(!("refused" in sent) && sent.delivery === "queued")
    const moved = await world.agents.redirect(apex.conversation, { from: "ios", request: sent.request, to: "android" })
    assert.ok(!("refused" in moved), JSON.stringify(moved))
    assert.equal(moved.withdrawn, true)
    assert.equal(world.live.snapshot(ios)!.requests.find((request) => request.id === sent.request)?.status, "canceled", "it left the child it was wrong for")
    const again = await world.agents.redirect(apex.conversation, { from: "ios", request: sent.request, to: "android" })
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

/**
 * The person writes to a Fin straight from the Apex's conversation (`mako:agents-direct`): no turn of the Apex's runs,
 * the Fin takes the words as the person's own, the Apex's transcript records it once as a routing line, a retry under
 * the same request delivers it once, its line's Send elsewhere moves it while it waits, and the Apex hears it in its
 * next note as what the person told that Fin.
 */
async function addressedFromTheApex(): Promise<void> {
  let kids: string[] = []
  let busy = false
  const { world, apex, android, ios } = await team("addressed", async (turn) => {
    if (kids.includes(turn.conversation) && busy) await turn.world.hold(turn.conversation)
    return "ok"
  })
  kids = [android, ios]
  try {
    const fin = world.store.journalPlacement(android)!.thread
    // The Fin's turn ends with a report that wakes the Apex, as any of its turns does; the message itself starts none.
    const personTurns = () => promptsOf(world, apex.conversation).filter((prompt) => !spoken(prompt.text).startsWith(FROM_AGENTS)).length
    const apexTurns = personTurns()
    const words = "Use the new signing key from the vault, not the old keystore."
    const request = randomUUID()
    const [sent, retried] = await Promise.all([
      world.agents.direct(apex.conversation, { to: fin, request, text: words }),
      world.agents.direct(apex.conversation, { to: fin, request, text: words }),
    ])
    assert.ok(!("refused" in sent), JSON.stringify(sent))
    assert.deepEqual(retried, sent, "a retry under the same request is the same delivery")
    assert.deepEqual(sent, { to: "android", fin, delivery: "turn" })
    await world.settle()
    assert.equal(personTurns(), apexTurns, "no turn of the Apex's ran for it")
    assert.ok(!promptsOf(world, apex.conversation).some((prompt) => prompt.text.includes(words)), "nor did its harness hear the words")
    const landed = promptsOf(world, android).filter((prompt) => spoken(prompt.text) === words)
    assert.equal(landed.length, 1, "once, as the person's own words, with no header of an agent's")
    assert.equal(world.live.snapshot(android)!.requests.at(-1)!.actor?.kind, "person")
    const again = await world.agents.direct(apex.conversation, { to: "android", request, text: words })
    assert.deepEqual(again, sent, "answered from the first, by its name too")
    await world.settle()
    assert.equal(promptsOf(world, android).filter((prompt) => spoken(prompt.text) === words).length, 1, "a later retry delivers nothing more")
    const recorded = world.live.snapshot(apex.conversation)!.blocks.filter((block) => block.type === "event" && block.direct)
    assert.equal(recorded.length, 1, "the Apex's transcript records it once")
    const [event] = recorded
    assert.ok(event?.type === "event" && event.direct)
    assert.equal(event.label, "You wrote to android directly")
    assert.equal(event.body, words)
    const { at, received, ...route } = event.direct
    assert.deepEqual(route, { to: "android", fin, request, delivery: "turn" })
    assert.ok(at > 0)
    assert.ok(world.live.snapshot(android)!.requests.some((asked) => asked.id === received && asked.text === words), "`received` is its request in the Fin's conversation, which Send elsewhere moves")
    assert.ok(!world.live.snapshot(apex.conversation)!.requests.some((asked) => asked.text === words), "nor is it a request of the Apex's, which a turn would answer")
    assert.equal(world.agents.diagnostics().routes.direct, 1)
    world.say(apex.conversation, "Where are we?")
    await world.settle()
    assert.match(promptsOf(world, apex.conversation).find((prompt) => prompt.text.endsWith("Where are we?"))!.text, /fin:android · .* the person wrote to it directly (just now|\d+m ago): "Use the new signing key/)
    busy = true
    world.live.submit(android, randomUUID(), "Next: the release build.", [])
    world.live.submit(ios, randomUUID(), "Next: the widget.", [])
    await until("both Fins at work", () => [android, ios].every((child) => world.live.snapshot(child)?.session.status === "running"))
    const apexBusyTurns = personTurns()
    const steered = await world.agents.direct(apex.conversation, { to: "android", request: randomUUID(), text: "Keep minify on for release." })
    const queued = await world.agents.direct(apex.conversation, { to: world.store.journalPlacement(ios)!.thread, request: randomUUID(), text: "After this, the widget's dark mode." })
    assert.ok(!("refused" in steered) && steered.delivery === "steer", "Claude hears it at its next step")
    assert.ok(!("refused" in queued) && queued.delivery === "queued", "Cursor takes it after its turn, as it takes any message")
    await until("the steer", () => world.steers.some((steer) => steer.conversation === android))
    assert.equal(world.steers.find((steer) => steer.conversation === android)!.text, "Keep minify on for release.", "the person's words, with no header of an agent's")
    const misplaced = "The lock-screen widget can wait."
    const wrong = await world.agents.direct(apex.conversation, { to: "ios", request: randomUUID(), text: misplaced })
    assert.ok(!("refused" in wrong) && wrong.delivery === "queued")
    const line = world.live.snapshot(apex.conversation)!.blocks.findLast((block) => block.type === "event" && block.direct?.to === "ios")
    assert.ok(line?.type === "event" && line.direct)
    const moved = await world.agents.redirect(apex.conversation, { from: "ios", request: line.direct.received, to: "android" })
    assert.ok(!("refused" in moved) && moved.withdrawn, "Send elsewhere on its line moves it while it waits")
    busy = false
    world.release(android)
    world.release(ios)
    await world.settle()
    assert.equal(personTurns(), apexBusyTurns, "still no turn of the Apex's")
    assert.equal(spoken(promptsOf(world, ios).at(-1)!.text), "After this, the widget's dark mode.")
    assert.ok(!promptsOf(world, ios).some((prompt) => spoken(prompt.text) === misplaced), "the Fin it was wrong for never takes it")
    const heard = [...promptsOf(world, android).map((prompt) => spoken(prompt.text)), ...world.steers.filter((steer) => steer.conversation === android).map((steer) => steer.text)]
    assert.equal(heard.filter((text) => text === misplaced).length, 1, "the Fin it's moved to takes it once")
    const empty = await world.agents.direct(apex.conversation, { to: fin, request: randomUUID(), text: "  " })
    assert.equal("refused" in empty && empty.refused, "conflict")
    const stranger = await world.agents.direct(apex.conversation, { to: "web", request: randomUUID(), text: "Hi." })
    assert.equal("refused" in stranger && stranger.refused, "unknown-child")
    const elsewhere = await world.agents.direct(android, { to: "ios", request: randomUUID(), text: "Hi." })
    assert.equal("refused" in elsewhere && elsewhere.refused, "unknown-child", "only an Apex's own Fins")
    await world.agents.stop(apex.caller, { child: "ios" })
    const resumed = await world.agents.direct(apex.conversation, { to: "ios", request: randomUUID(), text: "One more thing." })
    assert.ok(!("refused" in resumed), "the person's message resumes a stopped Fin too")
    assert.equal(world.agents.diagnostics().routes.direct, 5)
  } finally {
    await world.close()
  }
}

/** A Thread with two Sessions: its children's reports wake the Session the person last wrote in, and that one routes. */
/** A result a Session waited for, while the person wrote in another of the Thread's Sessions, wakes neither: the Thread heard it in the answer. */
async function waitedResultWakesNoSession(): Promise<void> {
  const apexes = new Set<string>()
  const answers: unknown[] = []
  let open!: () => void
  const gate = new Promise<void>((resolve) => (open = resolve))
  const world = new AgentsWorld({
    root: join(root, "waited"),
    script: async (turn) => {
      if (!apexes.has(turn.conversation)) {
        await gate
        await turn.world.agents.report(turn.caller, { status: "done", summary: "12 files.", clientKey: "r" })
        return "Reported."
      }
      if (turn.text.endsWith("go")) answers.push(await turn.world.agents.start(turn.caller, { brief: { objective: "Count the files." }, harness: "codex", name: "count", mode: "wait", clientKey: "w", cwd: turn.world.root }))
      return "ok"
    },
  })
  try {
    const first = await world.apex("claude")
    apexes.add(first.conversation)
    world.say(first.conversation, "go")
    await until("the child's turn", () => world.prompts.some((prompt) => !apexes.has(prompt.conversation)))
    const thread = ThreadIdSchema.parse(world.store.journalPlacement(first.conversation)!.thread)
    const placed = world.store.createSession({ operationId: randomUUID(), thread, actor: world.store.person() })
    const second = randomUUID()
    apexes.add(second)
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
    const first = await world.apex("claude")
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
    assert.ok(promptsOf(world, second)[0]!.text.includes("- fin:build · Codex"), "the Session the person writes in hears its Thread's Fins")
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
  assert.ok(lines[1]!.startsWith("- fin:api · Codex · working: Running the tests"), JSON.stringify(lines))
  assert.match(lines[1]!, /last report \(progress, 3m ago\): Half done/)
  const many = frontDoorNote(Array.from({ length: 20 }, (_, index) => child(`area-${index}`, "working")), now)
  assert.equal(many.filter((line) => line.startsWith("- fin:")).length, FRONT_DOOR_LISTED)
  assert.ok(many.includes("… and 4 more (agents_list)."))
  assert.equal(frontDoorNote([], now).length, 0)
}

/** The transcript reads a routing call the same from every harness's decoded call, and nothing else as one. */
function routedCalls(): void {
  const call = (server: string, tool: string, args: Record<string, string | boolean>) =>
    routedCall({ type: "toolCall", id: "c", tool: { kind: "mcp", name: `${server}.${tool}`, label: tool, server, tool }, arguments: args })
  assert.deepEqual(call("mako", "agents_send", { to: "fin:android", forward: true, clientKey: "k" }), { to: "android", forward: true })
  assert.deepEqual(call("mako", "agents_send", { to: "child:android", forward: true, clientKey: "k" }), { to: "android", forward: true }, "as builds before the names taught it")
  assert.deepEqual(call("mako", "agents_send", { to: "ios", text: " Pause it. ", clientKey: "k" }), { to: "ios", forward: false, text: "Pause it." })
  assert.equal(call("mako", "agents_start", { to: "ios" }), undefined)
  assert.equal(call("github", "agents_send", { to: "ios" }), undefined)
  assert.equal(call("mako", "agents_send", { forward: true }), undefined)
}

/** Only invariant routing paragraphs use cadence; facts and unresolved decisions still accompany every person message. */
async function routingGuidanceCadence(): Promise<void> {
  let rules = "Keep the original rule and every unanswered decision."
  let refuse = false
  const world = new AgentsWorld({
    root: join(root, "routing-cadence"),
    policy: () => ({ rules: [], forApexes: rules }),
    refusePrompt: () => {
      if (!refuse) return undefined
      refuse = false
      return "Fixture send refused; delivery unknown"
    },
    script: async () => "ok",
  })
  try {
    const apex = await world.apex("codex")
    const child = await world.agents.start(apex.caller, { name: "worker", clientKey: "worker", harness: "claude", brief: { objective: "Inspect the failing check." }, cwd: world.root })
    assert.ok(!("refused" in child) && child.conversation)
    await world.settle(40)
    const report = await world.agents.report(world.caller(child.conversation), { clientKey: "decision", status: "done", summary: "The late check failed.", question: "Mutation outcome is unknown; do not retry. Which check should be repaired?" })
    assert.ok(!("refused" in report))
    await world.settle(40)
    const count = () => world.prompts.filter(p => p.conversation === apex.conversation).reduce((n, p) => n + Number(p.text.includes(FRONT_DOOR_GUIDANCE[0])), 0)
    const send = async (text: string) => {
      world.say(apex.conversation, text)
      await world.settle(30)
      const prompt = promptsOf(world, apex.conversation).filter(p => p.text.endsWith(text)).at(-1)
      assert.ok(prompt)
      assert.equal(spoken(prompt.text), text, "person's message stays exact")
      assert.ok(prompt.text.includes(report.id) && prompt.text.includes("Mutation outcome is unknown; do not retry."), "pending identity and unknown outcome are rebuilt every time")
      assert.ok(prompt.text.includes("fin:worker"), "the dynamic roster is never deduplicated")
      return prompt.text
    }
    const initial = count()
    assert.equal(initial, 0, "a process handling only service reports needs no person-routing guidance")
    for (let i = 0; i < 4; i++) {
      assert.equal((await send(`Inspect current decision ${i}.`)).includes(FRONT_DOOR_GUIDANCE[0]), i === 0)
    }
    assert.equal(count(), initial + 1)
    await world.agents.report(world.caller(child.conversation), { clientKey: "service-update", status: "done", summary: "An additional service report; the original decision is still open." })
    await world.settle(40)
    assert.ok(!(await send("After a service report.")).includes(FRONT_DOOR_GUIDANCE[0]), "service turns retain the standing key without adding or withdrawing its instructions")
    assert.equal(count(), initial + 1)
    rules = "The replacement rule applies; keep all unanswered decisions."
    assert.ok((await send("Read the changed person rule.")).includes(rules))
    assert.equal(count(), initial + 1, "changing other rules does not repeat routing guidance")
    world.live.observe({ type: "live-update", id: apex.conversation, update: { kind: "event", label: CONTEXT_COMPACTED } })
    const compacted = await send("After compaction.")
    for (const line of FRONT_DOOR_GUIDANCE) assert.ok(compacted.includes(line))
    assert.ok(!(await send("After that.")).includes(FRONT_DOOR_GUIDANCE[0]))
    world.live.observe({ type: "live-rewound", id: apex.conversation, run: "fixture-rewind" })
    assert.ok((await send("After rewind.")).includes(FRONT_DOOR_GUIDANCE[0]))
    refuse = true
    world.say(apex.conversation, "Refused fixture message.")
    await world.settle(30, 20_000, "ignore")
    assert.ok((await send("After failed delivery.")).includes(FRONT_DOOR_GUIDANCE[0]), "an uncertain send resets guidance just like other standing rules")
    await world.restart()
    assert.ok((await send("After host reconstruction.")).includes(FRONT_DOOR_GUIDANCE[0]))
    assert.ok(!(await send("After reconstruction settles.")).includes(FRONT_DOOR_GUIDANCE[0]))
    const full = world.agents.frontDoor(apex.conversation, {})
    const facts = world.agents.frontDoor(apex.conversation, {}, false)
    assert.deepEqual(full.filter(line => !FRONT_DOOR_GUIDANCE.some(guidance => guidance === line)), facts, "direct frontDoor readers keep full guidance by default")
    const read = await world.agents.read(apex.caller, { child: "worker", report: report.id })
    assert.ok(!("refused" in read) && read.text.includes("The late check failed."), "detail reading still recovers the original report")
    assert.ok("refused" in await world.agents.read(world.caller(child.conversation), { child: apex.conversation }), "guidance cadence cannot grant access")
  } finally {
    await world.close()
  }
}

try {
  noteListing()
  routedCalls()
  for (const test of [forwardsToTheRightChild, repeatsStopsAndOwnWords, steerOrQueue, onlyThePersonsTurnsOfAnApex, directTalkAndRedirect, addressedFromTheApex, frontSessionHears, waitedResultWakesNoSession, routingGuidanceCadence]) {
    await test()
    console.log(`ok ${test.name}`)
  }
  console.log("test:orch-front-door ok")
} finally {
  rmSync(root, { recursive: true, force: true })
}

await import("./test-orch-action-cadence.ts")
