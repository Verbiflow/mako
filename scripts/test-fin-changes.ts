import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { frontDoorNote, type FrontDoorChild } from "@mako/host/contracts/agent-tools"
import { ThreadIdSchema } from "@mako/host/contracts/thread-identity"
import { FROM_AGENTS } from "@mako/host/contracts/children"
import { CONTEXT_COMPACTED } from "@mako/host/contracts/native-activity"
import { FinChanges } from "@mako/host/conversations/fin-changes"
import { PollAnswers, turnOf } from "@mako/host/base/poll-answers"
import { AgentsWorld, type Script } from "./lib/agents-world.ts"

/**
 * Change marks (`FinChanges`): an Apex reads only what changed. `agents_list` answers a `mark`, and with `since` lists
 * only the Fins whose state, report, open questions or pull requests changed since, counting the rest; the front door's
 * note names a Fin nothing changed for since the last note instead of describing it again (`npm run test:agents-doors`).
 */
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

// What counts as a change: a working Fin's next step doesn't, nor a queued one's place in line; a report, a question,
// an end and a pull request do.
{
  const changes = new FinChanges()
  const fin = "fin-a"
  assert.equal(changes.at(fin, { state: { kind: "working", step: "Reading" } }, 1), 1, "first read: changed then")
  assert.equal(changes.at(fin, { state: { kind: "working", step: "Running npm test", phase: "testing" } }, 2), 1, "a working Fin's step moving is no change")
  assert.equal(changes.at(fin, { state: { kind: "working" }, report: { status: "progress", at: 5 } }, 3), 3, "a report is")
  assert.equal(changes.at(fin, { state: { kind: "working" }, report: { status: "progress", at: 5 }, questions: 1 }, 4), 4, "so is a question it asks")
  assert.equal(changes.at(fin, { state: { kind: "ended", outcome: "done" }, report: { status: "done", at: 6 }, questions: 1 }, 5), 5, "and its end")
  assert.equal(changes.at(fin, { state: { kind: "ended", outcome: "done" }, report: { status: "done", at: 6 }, questions: 1, pulls: [{ number: 12, state: "open" }] }, 6), 6, "and a pull request it opens")
  assert.equal(changes.at(fin, { state: { kind: "ended", outcome: "done" }, report: { status: "done", at: 6 }, questions: 1, pulls: [{ number: 12, state: "open" }] }, 9), 6, "the same facts again: same since")
  assert.equal(changes.at("fin-q", { state: { kind: "queued", reason: "tree-running", ahead: 3 } }, 1), 1)
  assert.equal(changes.at("fin-q", { state: { kind: "queued", reason: "tree-running", ahead: 1 } }, 2), 1, "a queued Fin moving up the line is no change")
}

// The host's own clock: never earlier than the last tick, its marks this host life's alone.
{
  const changes = new FinChanges()
  assert.equal(changes.tick(100), 100)
  assert.equal(changes.tick(50), 101, "a clock that steps back still moves forward")
  assert.equal(changes.tick(101), 102, "and two reads in one millisecond are two ticks")
  const mark = changes.mark(102)
  assert.equal(changes.since(mark), 102, "its own mark reads")
  assert.equal(changes.since(new FinChanges().mark(102)), undefined, "another host's, or an earlier life's, doesn't")
  assert.equal(changes.since(changes.mark(500)), undefined, "nor one past any tick it gave")
  assert.equal(changes.since("102"), undefined, "nor one without its life")
  assert.equal(changes.since(undefined), undefined)
}

// The note: changed Fins in full, unchanged ones named on one line, one that waits on an answer always in full.
{
  const fin = (name: string, state: FrontDoorChild["state"], changedAt: number): FrontDoorChild => ({ name, harness: "Codex", state, topic: `Do ${name}.`, changedAt })
  const now = 10 * 60_000
  const seenAt = 5 * 60_000
  const lines = frontDoorNote([
    fin("fresh", { kind: "ended", outcome: "done" }, 6 * 60_000),
    fin("still", { kind: "idle" }, 60_000),
    fin("old", { kind: "ended", outcome: "done" }, 60_000),
    fin("asks", { kind: "blocked", question: "Which branch?", on: "lead" }, 60_000),
  ], now, false, seenAt)
  const text = lines.join("\n")
  assert.ok(lines.some((line) => line.startsWith("- fin:fresh ·")), `a Fin that changed is described: ${text}`)
  assert.ok(lines.some((line) => line.startsWith("- fin:asks ·") && line.includes("Which branch?")), "one waiting on an answer always is")
  assert.ok(!lines.some((line) => line.startsWith("- fin:still") || line.startsWith("- fin:old")), "unchanged ones aren't described again")
  assert.ok(lines.includes("Unchanged since the last note (5m ago): fin:still (idle), fin:old (done) (agents_list has each)."), text)
  const first = frontDoorNote([fin("still", { kind: "idle" }, 60_000)], now, false)
  assert.ok(first.some((line) => line.startsWith("- fin:still ·")), "with no note before, every Fin is described")
}

// Through the engine: a list's mark, `since` with a Fin that reported, and the front door's second note.
{
  const root = mkdtempSync(join(tmpdir(), "mako-fin-changes-"))
  // A prompt the Apex's harness refuses before taking it, while `refusing`.
  let refusing = ""
  const world = new AgentsWorld({ root, script: (turn) => (turn.text.includes("You're fin:") ? "Done for now." : "ok"), refusePrompt: (id) => (refusing && id === refusing ? "Not now: the test refuses it." : undefined) })
  try {
    const apex = await world.apex("claude", "full")
    const children: string[] = []
    for (const name of ["alpha", "beta", "gamma"]) {
      const answer = await world.agents.start(apex.caller, { brief: { objective: `Check ${name}` }, name, harness: "codex", cwd: world.root, clientKey: name })
      assert.ok(!("refused" in answer), JSON.stringify(answer))
      children.push(answer.child!)
    }
    await world.settle(300, 30_000, "ignore")
    const first = await world.agents.list(apex.caller, {})
    assert.ok("children" in first && "mark" in first, JSON.stringify(first))
    assert.equal(first.children.length, 3)
    const mark = first.mark!
    const tick = Number(mark.split(":")[1])
    assert.ok(first.children.every((strip) => strip.changedAt !== undefined && strip.changedAt <= tick), "every row has its change mark, on the list's clock")
    await pause(5)
    const quiet = await world.agents.list(apex.caller, { since: mark })
    assert.ok("children" in quiet && "mark" in quiet)
    assert.equal(quiet.children.length, 0, "nothing changed: nothing listed")
    assert.equal(quiet.unchanged, 3, "and every Fin counted")

    const door = () => world.agents.frontDoor(apex.conversation, {}, false)
    const before = door()
    assert.equal(before.filter((line) => line.startsWith("- fin:")).length, 3, `the first note describes each: ${before.join("\n")}`)
    await pause(5)
    const conversation = world.store.thread(ThreadIdSchema.parse(children[1]!))!.sessions.flatMap((session) => world.store.conversationsOf(session))[0]!
    const reported = await world.agents.report(world.caller(conversation), { status: "done", summary: "Beta is checked: two fixes, PR to follow.", clientKey: "beta-done" })
    assert.ok(!("refused" in reported), JSON.stringify(reported))
    await world.settle(300, 30_000, "ignore")
    const moved = await world.agents.list(apex.caller, { since: mark })
    assert.ok("children" in moved)
    assert.deepEqual(moved.children.map((strip) => strip.name), ["beta"], "only the Fin that reported")
    assert.equal(moved.unchanged, 2)
    const after = door()
    const described = after.filter((line) => line.startsWith("- fin:")).map((line) => line.slice("- fin:".length).split(" ")[0])
    assert.deepEqual(described, ["beta"], `the next note describes only what changed: ${after.join("\n")}`)
    assert.ok(after.some((line) => line.startsWith("Unchanged since the last note") && line.includes("fin:alpha") && line.includes("fin:gamma")), after.join("\n"))
    // Mako's own prompts (a digest) carry no roster, but the first after its harness compacted or rewound does, every
    // Fin described, once.
    const digestActor = { kind: "agent" as const, session: world.store.journalPlacement(apex.conversation)!.session }
    const heard = world.agents.frontDoor(apex.conversation, { actor: digestActor }, false, false)
    assert.ok(!heard.some((line) => line.startsWith("- fin:")), `a digest to a process that heard the note carries no roster: ${heard.join("\n")}`)
    const fresh = world.agents.frontDoor(apex.conversation, { actor: digestActor }, false, true)
    assert.ok(!fresh.some((line) => line.startsWith("- fin:")), "nor one to a new process, which resumes its history")
    const compacted = world.agents.frontDoor(apex.conversation, { actor: digestActor }, false, true, true)
    assert.equal(compacted.filter((line) => line.startsWith("- fin:")).length, 3, `after a compaction, a digest carries the roster: ${compacted.join("\n")}`)
    assert.ok(!compacted.some((line) => line.startsWith("If the message is for one of them")), "without the person's routing guidance")
    // A process that hasn't heard a note (new, compacted, after a failed send) hears every Fin described again.
    const whole = world.agents.frontDoor(apex.conversation, {}, false, true)
    assert.equal(whole.filter((line) => line.startsWith("- fin:")).length, 3, `a fresh context: each described: ${whole.join("\n")}`)
    assert.ok(!whole.some((line) => line.startsWith("Unchanged since")))
    // Through dispatch: a digest before a compaction carries no roster, the first after one carries it, once.
    const news = (words: string) => {
      world.live.submit(apex.conversation, randomUUID(), `${FROM_AGENTS}\n${words}`, [], undefined, undefined, undefined, digestActor, { digest: { notices: [] } })
    }
    const sentTo = (words: string) => world.prompts.filter((prompt) => prompt.conversation === apex.conversation && prompt.text.includes(words)).at(-1)?.text ?? ""
    // The process hears the note first, with the person's message.
    world.say(apex.conversation, "How are they doing?")
    await world.settle(300, 20_000, "ignore")
    assert.ok(sentTo("How are they doing?").includes("- fin:"), "the person's message carries the roster")
    news("Before the compaction.")
    await world.settle(300, 20_000, "ignore")
    assert.ok(sentTo("Before the compaction.") && !sentTo("Before the compaction.").includes("- fin:alpha"), "a digest to a process that heard the note: no roster")
    world.live.observe({ type: "live-update", id: apex.conversation, update: { kind: "event", label: CONTEXT_COMPACTED } })
    news("After the compaction.")
    await world.settle(300, 20_000, "ignore")
    assert.ok(sentTo("After the compaction.").includes("- fin:alpha"), `the first digest after a compaction carries the roster: ${sentTo("After the compaction.").slice(0, 600)}`)
    news("And after that.")
    await world.settle(300, 20_000, "ignore")
    assert.ok(!sentTo("And after that.").includes("- fin:alpha"), "once")
    // Kept in its journal: a restart between the compaction and the digest still sends the roster.
    world.live.observe({ type: "live-update", id: apex.conversation, update: { kind: "event", label: CONTEXT_COMPACTED } })
    await world.settle(300, 20_000, "ignore")
    await world.restart()
    news("After the restart.")
    await world.settle(300, 20_000, "ignore")
    assert.ok(sentTo("After the restart.").includes("- fin:alpha"), `a restart keeps it: ${sentTo("After the restart.").slice(0, 400)}`)
    // Cleared only once a send commits: one the harness refused leaves it for the next prompt it takes.
    world.live.observe({ type: "live-update", id: apex.conversation, update: { kind: "event", label: CONTEXT_COMPACTED } })
    await world.settle(300, 20_000, "ignore")
    const heardBefore = world.prompts.filter((prompt) => prompt.conversation === apex.conversation).length
    refusing = apex.conversation
    news("Refused news.")
    await world.settle(300, 20_000, "ignore")
    refusing = ""
    news("After the refusal.")
    await world.settle(300, 20_000, "ignore")
    const taken = world.prompts.filter((prompt) => prompt.conversation === apex.conversation).slice(heardBefore)
    assert.ok(taken.length > 0 && taken[0]!.text.includes("- fin:alpha"), `the first prompt it took after a refused one carries the roster: ${taken.map((prompt) => prompt.text.slice(0, 120)).join(" | ")}`)
    const chars = (lines: readonly string[]) => lines.reduce((sum, line) => sum + line.length + 1, 0)
    console.log(`front door: ${chars(before)} characters with every Fin described, ${chars(after)} with one changed of three`)
  } finally {
    await world.close()
    rmSync(root, { recursive: true, force: true })
  }
}

// Reading Fins at work again changes nothing (`PollAnswers`): a list or read says their reports wake the caller; the
// same read again, unchanged, says so whole; the time after, only that; a change, another call or a terminal resets it.
{
  const root = mkdtempSync(join(tmpdir(), "mako-fin-changes-polls-"))
  let release = () => {}
  const held = new Promise<void>((resolve) => { release = resolve })
  const world = new AgentsWorld({ root, script: async (turn) => {
    if (!turn.text.includes("You're fin:")) return "ok"
    await held
    return "Done."
  } })
  try {
    const apex = await world.apex("claude", "full")
    for (const name of ["slow", "slower"]) {
      const answer = await world.agents.start(apex.caller, { brief: { objective: `Check ${name}` }, name, harness: "codex", cwd: world.root, clientKey: name })
      assert.ok(!("refused" in answer), JSON.stringify(answer))
    }
    await pause(500)
    const first = await world.agents.list(apex.caller, {})
    assert.ok("children" in first, JSON.stringify(first))
    assert.ok(first.children.every((strip) => strip.state.kind === "working" || strip.state.kind === "starting"), JSON.stringify(first.children.map((strip) => strip.state)))
    assert.equal(first.next, "Their reports wake you. End your turn or keep working; don't poll.", "a list of Fins at work says their reports wake you")
    const again = await world.agents.list(apex.caller, {})
    assert.ok("children" in again && again.children.length === 2, "the first repeat is whole")
    assert.match(again.next ?? "", /^Nothing changed since your last agents_list \d+ s ago: fin:slow, fin:slower are working\. Their reports wake you; end your turn\.$/)
    const short = await world.agents.list(apex.caller, {})
    assert.ok("children" in short && short.children.length === 0 && short.unchanged === 2 && short.unchangedSince !== undefined, `the time after, only that: ${JSON.stringify(short)}`)
    assert.match(short.next ?? "", /^Nothing changed since your last agents_list/)
    assert.ok("children" in await world.agents.list(apex.caller, { scope: "all" }), "another call is read whole")
    const read = await world.agents.read(apex.caller, { child: "slow" })
    assert.ok(!("refused" in read) && "text" in read, JSON.stringify(read))
    assert.equal(read.next, "Its report wakes you. End your turn or keep working; don't poll.")
    const reread = await world.agents.read(apex.caller, { child: "slow" })
    assert.ok("text" in reread && /^Nothing changed since your last agents_read of fin:slow/.test(reread.next ?? ""), JSON.stringify(reread))
    const shortRead = await world.agents.read(apex.caller, { child: "slow" })
    assert.ok("text" in shortRead && shortRead.unchangedSince !== undefined && shortRead.text === shortRead.next, `then only that: ${JSON.stringify(shortRead)}`)
    assert.ok("text" in await world.agents.read(apex.caller, { child: "slower" }), "another Fin is read whole")
    // A Fin's report is a change: the next list is whole and says nothing of repeats.
    const fin = world.store.edges().children(world.store.journalPlacement(apex.conversation)!.thread).find((edge) => edge.name === "slow")!
    const conversation = world.store.thread(ThreadIdSchema.parse(fin.child))!.sessions.flatMap((session) => world.store.conversationsOf(session))[0]!
    const reported = await world.agents.report(world.caller(conversation), { status: "progress", summary: "Half way.", clientKey: "half" })
    assert.ok(!("refused" in reported), JSON.stringify(reported))
    const changed = await world.agents.list(apex.caller, {})
    assert.ok("children" in changed && !changed.next?.startsWith("Nothing changed"), `a change resets it: ${JSON.stringify("next" in changed && changed.next)}`)
    const timedOut = await world.agents.wait(apex.caller, { timeoutMs: 10, after: Date.now() })
    assert.ok(!("refused" in timedOut) && timedOut.timedOut && timedOut.next === "Nothing new: reports wake you without it. End your turn now; don't wait again.", JSON.stringify(timedOut))
    const waitedAgain = await world.agents.wait(apex.caller, { timeoutMs: 10, after: "cursor" in timedOut ? timedOut.cursor : 0 })
    assert.ok(!("refused" in waitedAgain) && waitedAgain.unchangedSince !== undefined && /^Nothing changed since your last agents_wait/.test(waitedAgain.next ?? ""), JSON.stringify(waitedAgain))
  } finally {
    release()
    await world.close()
    rmSync(root, { recursive: true, force: true })
  }
}

// The repeats themselves: per conversation and call, reset by a new turn, a changed answer or the window; none for a
// caller with no conversation.
{
  const polls = new PollAnswers(2, 1_000)
  assert.deepEqual(polls.read("c", "list", "a", "t1", 0), { repeats: 0 })
  assert.deepEqual(polls.read("c", "list", "a", "t1", 400), { repeats: 1, since: 0 })
  assert.deepEqual(polls.read("c", "list", "a", "t1", 2_400), { repeats: 0 }, "past the window it's new")
  assert.deepEqual(polls.read("c", "list", "a", "t2", 2_500), { repeats: 0 }, "a new turn is new")
  assert.deepEqual(polls.read("c", "list", "b", "t2", 2_600), { repeats: 0 }, "a changed answer is new")
  assert.deepEqual(polls.read(undefined, "list", "b", "t2", 2_700), { repeats: 0 })
  assert.deepEqual(polls.read(undefined, "list", "b", "t2", 2_800), { repeats: 0 }, "a terminal is never counted")
  polls.read("d", "list", "b", "t", 2_900)
  polls.read("e", "list", "b", "t", 3_000)
  assert.deepEqual(polls.read("c", "list", "b", "t2", 3_100), { repeats: 0 }, "bounded: the conversation heard from least recently is forgotten")
  assert.equal(turnOf([{ id: "q", status: "completed" }, { id: "r", status: "dispatching" }, { id: "s", status: "queued" }]), "r")
  assert.equal(turnOf([{ id: "q", status: "completed" }]), undefined)
}

// What needs its Apex is listed whatever `since` says; a mark this host can't read lists every Fin.
{
  const root = mkdtempSync(join(tmpdir(), "mako-fin-changes-asks-"))
  const script: Script = async (turn) => {
    if (turn.text.includes("Check asker")) {
      await turn.world.agents.report(turn.caller, { status: "needs-input", summary: "Two ways to fix it.", question: "Patch or rewrite?", options: [{ label: "Patch" }, { label: "Rewrite" }], clientKey: "ask" })
      return "Asked."
    }
    return turn.text.includes("You're fin:") ? "Done for now." : "ok"
  }
  const world = new AgentsWorld({ root, script })
  try {
    const apex = await world.apex("claude", "full")
    for (const name of ["asker", "quiet"]) {
      const answer = await world.agents.start(apex.caller, { brief: { objective: `Check ${name}` }, name, harness: "codex", cwd: world.root, clientKey: name })
      assert.ok(!("refused" in answer), JSON.stringify(answer))
    }
    await world.settle(300, 30_000, "ignore")
    const first = await world.agents.list(apex.caller, {})
    assert.ok("children" in first && first.mark)
    assert.equal(first.children.find((strip) => strip.name === "asker")?.state.kind, "blocked", JSON.stringify(first.children.map((strip) => [strip.name, strip.state])))
    const again = await world.agents.list(apex.caller, { since: first.mark })
    assert.ok("children" in again)
    assert.deepEqual(again.children.map((strip) => strip.name), ["asker"], "a Fin waiting on its Apex is listed though nothing changed")
    assert.equal(again.unchanged, 1, "the other is counted")
    for (const foreign of ["elsewhere:1", `${first.mark.split(":")[0]}:${Number.MAX_SAFE_INTEGER}`]) {
      const whole = await world.agents.list(apex.caller, { since: foreign })
      assert.ok("children" in whole)
      assert.equal(whole.children.length, 2, `a mark this host can't read (${foreign.slice(0, 12)}…) lists every Fin`)
      assert.equal(whole.unchanged, undefined)
    }
    console.log("change marks: a Fin waiting on its Apex is always listed; another host's mark, or one ahead, lists every Fin")
  } finally {
    await world.close()
    rmSync(root, { recursive: true, force: true })
  }
}

console.log("change marks: agents_list answers a mark and lists only what changed since it; the front door names an unchanged Fin instead of describing it again")
