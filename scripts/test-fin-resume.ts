import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AgentCaller, ChildState } from "@mako/host/contracts/agents"
import type { AgentsSendResult } from "@mako/host/contracts/agent-tools"
import { ThreadIdSchema } from "@mako/host/contracts/thread-identity"
import { FROM_AGENTS } from "@mako/host/conversations/agent-wakes"
import { AgentsWorld, type Script } from "./lib/agents-world.ts"

/**
 * A stopped Fin is paused, not over (`npm run test:fin-resume`). Six Fins an
 * Apex stopped while the host stalled could only be replaced by fresh ones,
 * which redid work their branches already held. Now a message from the Apex,
 * or the person writing in the Fin's own Thread, resumes it in the same
 * Session, beneath an account of why it stopped, how long ago, and what moved
 * in its checkout and on the branch it goes into since; its turns report and
 * wake the Apex again. Covered: a resume after a stop, after a failure, after
 * a host restart and after its branch moved, a repeat of the same message
 * resuming it once, the person's own message, and a second stop.
 */
for (const key of Object.keys(process.env)) if (key.startsWith("GIT_")) delete process.env[key]
const root = mkdtempSync(join(tmpdir(), "mako-fin-resume-"))
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "Fin", GIT_AUTHOR_EMAIL: "fin@example.invalid", GIT_COMMITTER_NAME: "Fin", GIT_COMMITTER_EMAIL: "fin@example.invalid" } }).trim()
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
/** Past the next whole second: Git keeps seconds, so a commit in the stop's own second could read as before it. */
const nextSecond = () => pause(1_050 - (Date.now() % 1_000))
const RESUMED = "[mako · resumed after a stop just now]"

async function until(what: string, done: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`)
    await pause(10)
  }
}

function sent(result: AgentsSendResult) {
  assert.ok(!("refused" in result), `refused: ${"refused" in result ? result.why : ""}`)
  return result
}

interface Fixture {
  world: AgentsWorld
  apex: { conversation: string; caller: AgentCaller }
  fin(): string
  state(): ChildState | undefined
  /** What the Fin's harness was sent, in order. */
  finPrompts(): string[]
  wakes: string[]
}

/**
 * An Apex with one Fin, "labels", whose first turn holds until it's stopped
 * (or runs `first`); every later turn says what it was sent and ends.
 */
async function fixture(name: string, options: { cwd?: string; first?: (world: AgentsWorld, conversation: string) => Promise<string> } = {}): Promise<Fixture> {
  const wakes: string[] = []
  let finConversation = ""
  let turns = 0
  const script: Script = async (turn) => {
    if (turn.conversation === finConversation || turn.text.includes("You're fin:")) {
      turns += 1
      if (turns === 1) return options.first ? options.first(turn.world, turn.conversation) : turn.world.hold(turn.conversation).then(() => "Cut short.")
      return "Labels finished."
    }
    if (turn.text.startsWith(FROM_AGENTS)) wakes.push(turn.text)
    return "ok"
  }
  const world = new AgentsWorld({ root: options.cwd ?? join(root, name), script })
  const apex = await world.apex("cursor", "full")
  const started = await world.agents.start(apex.caller, { brief: { objective: "Label half the snippets" }, harness: "claude", name: "labels", clientKey: "labels", cwd: world.root })
  assert.ok(!("refused" in started) && started.conversation, JSON.stringify(started))
  finConversation = started.conversation!
  const entry = () => world.agents.roster(apex.conversation).find((each) => each.child?.name === "labels")?.child
  return {
    world,
    apex,
    fin: () => finConversation,
    state: () => entry()?.state,
    finPrompts: () => world.prompts.filter((prompt) => prompt.conversation === finConversation).map((prompt) => prompt.text),
    wakes,
  }
}

async function stopWhileWorking(f: Fixture, reason = "the host is stalling"): Promise<void> {
  await until("the Fin to work", () => f.world.live.session(f.fin())?.status === "running")
  const stopped = await f.world.agents.stop(f.apex.caller, { child: "labels", reason })
  assert.deepEqual("stopped" in stopped && stopped.stopped, ["labels"])
  await until("the stop", () => f.state()?.kind === "ended")
  await f.world.settle(400)
}

try {
  // Resumed after a stop: the same Session takes the message beneath its account, and reports and wakes again.
  {
    const f = await fixture("after-stop")
    await stopWhileWorking(f)
    assert.deepEqual(f.state(), { kind: "ended", outcome: "stopped", reason: "the host is stalling" })
    const answer = sent(await f.world.agents.send(f.apex.caller, { to: "labels", text: "The host is back: carry on.", clientKey: "go" }))
    assert.equal(answer.delivery, "turn")
    await until("its resumed turn to end", () => f.state()?.kind === "ended" && f.finPrompts().length === 2)
    const prompt = f.finPrompts()[1]!
    assert.ok(prompt.includes("The host is back: carry on."), prompt)
    assert.ok(prompt.includes(`${RESUMED}\nYou were stopped just now (the host is stalling), and this message resumes your work in the same session`), prompt)
    assert.equal(f.world.live.session(f.fin())?.nativeId, `native-${f.fin()}`, "the same Session, not a new Fin")
    assert.deepEqual(f.state(), { kind: "ended", outcome: "done" })
    const thread = ThreadIdSchema.parse(f.world.agents.roster(f.apex.conversation)[0]!.child!.thread)
    assert.deepEqual(f.world.store.reportsOf(thread, 0).map((report) => [report.status, report.summary]), [["done", "Labels finished."]], "its resumed turn reports")
    await until("the Apex to hear", () => f.wakes.length === 1)
    assert.match(f.wakes[0]!, /"labels" \(Claude\) done: Labels finished\./)
    const edge = f.world.store.edges().of(thread)!
    assert.equal(edge.closedAt, undefined)
    assert.equal(edge.resumed?.reason, "the host is stalling")
    await f.world.close()
  }
  console.log("after a stop: the same Session resumed beneath its account, reported done and woke its Apex")

  // Resumed after its turn failed: the account says so, with why.
  {
    const f = await fixture("after-failure", {
      first: async (world, conversation) => {
        await world.agents.report(world.caller(conversation), { status: "failed", summary: "The labeler crashed on snippet 212.", clientKey: "crash" })
        return "Crashed."
      },
    })
    await until("the failure", () => { const now = f.state(); return now?.kind === "ended" && now.outcome === "failed" })
    await f.world.settle(400)
    sent(await f.world.agents.send(f.apex.caller, { to: "labels", text: "Skip 212 and go on.", clientKey: "go" }))
    await until("its resumed turn", () => f.finPrompts().length === 2)
    assert.ok(f.finPrompts()[1]!.includes("[mako · resumed after a failure just now]\nYour last turn failed just now (The labeler crashed on snippet 212.)"), f.finPrompts()[1])
    await until("it to finish", () => { const now = f.state(); return now?.kind === "ended" && now.outcome === "done" })
    await f.world.close()
  }
  console.log("after a failure: resumed with why its turn failed")

  // Resumed after a host restart, and a repeat of the message, before and after the restart, resumes it once.
  {
    const f = await fixture("after-restart")
    await stopWhileWorking(f, "pausing for the night")
    await f.world.restart()
    const apex = { conversation: f.apex.conversation, caller: f.world.caller(f.apex.conversation) }
    assert.deepEqual(f.state(), { kind: "ended", outcome: "stopped", reason: "pausing for the night" }, "still stopped after the restart")
    const first = sent(await f.world.agents.send(apex.caller, { to: "labels", text: "Morning: carry on.", clientKey: "morning" }))
    assert.equal(first.delivery, "turn")
    const again = sent(await f.world.agents.send(apex.caller, { to: "labels", text: "Morning: carry on.", clientKey: "morning" }))
    assert.equal(again.deduped, true, "a repeat answers the first")
    await until("its resumed turn to end", () => { const now = f.state(); return now?.kind === "ended" && now.outcome === "done" })
    await f.world.restart()
    const later = sent(await f.world.agents.send(f.world.caller(f.apex.conversation), { to: "labels", text: "Morning: carry on.", clientKey: "morning" }))
    assert.equal(later.deduped, true, "and after another restart too")
    await f.world.settle(400)
    assert.equal(f.finPrompts().filter((prompt) => prompt.includes("Morning: carry on.")).length, 1, "its harness heard it once")
    await f.world.close()
  }
  console.log("after a restart: resumed once, a repeat of the message deduped before and after another restart")

  // Resumed after its branch moved: the account names the commit on its branch and what landed on main touching its files.
  {
    const repo = join(root, "branch-moved")
    mkdirSync(repo, { recursive: true })
    git(repo, "init", "-q", "-b", "main")
    writeFileSync(join(repo, ".git", "info", "exclude"), "journals/\nthreads.sqlite*\nnative/\n")
    writeFileSync(join(repo, "labels.json"), "{}\n")
    writeFileSync(join(repo, "README.md"), "Labels\n")
    git(repo, "add", ".")
    git(repo, "commit", "-q", "-m", "Start the labels")
    git(repo, "update-ref", "refs/remotes/origin/main", "HEAD")
    git(repo, "checkout", "-q", "-b", "fin/labels")
    writeFileSync(join(repo, "labels.json"), "{\"a\":\"ts\"}\n")
    git(repo, "commit", "-q", "-am", "Label the first half")
    await nextSecond()
    const f = await fixture("branch-moved", { cwd: repo })
    await stopWhileWorking(f)
    await nextSecond()
    writeFileSync(join(repo, "notes.md"), "Picked up by hand\n")
    git(repo, "add", "notes.md")
    git(repo, "commit", "-q", "-m", "Note what was done by hand")
    const main = git(repo, "rev-parse", "refs/remotes/origin/main")
    git(repo, "checkout", "-q", "main")
    writeFileSync(join(repo, "labels.json"), "{\"schema\":2}\n")
    git(repo, "commit", "-q", "-am", "Move labels to schema 2 (#900)")
    git(repo, "update-ref", "refs/remotes/origin/main", "HEAD", main)
    git(repo, "checkout", "-q", "fin/labels")
    sent(await f.world.agents.send(f.apex.caller, { to: "labels", text: "Carry on.", clientKey: "go" }))
    await until("its resumed turn", () => f.finPrompts().length === 2)
    const prompt = f.finPrompts()[1]!
    assert.match(prompt, /In your checkout since then:\n- \.: HEAD moved \w{8} → \w{8} [^\n]*New commit: \w{8} Note what was done by hand\./)
    assert.match(prompt, /Where your branch stands now:\n- \.: on fin\/labels, nothing uncommitted, 2 ahead of origin\/main and 1 behind, a commit landed there touching files you changed: \w{8} Move labels to schema 2 \(#900\) \(labels\.json\)\./)
    await f.world.close()
  }
  console.log("after its branch moved: the account named the new commit on its branch and what landed on main touching its files")

  // The person writing in the stopped Fin's own Thread resumes it too; a resumed Fin stops again as a pause.
  {
    const f = await fixture("person")
    await stopWhileWorking(f)
    f.world.say(f.fin(), "Finish the second half too.")
    await until("it to resume and finish", () => { const now = f.state(); return now?.kind === "ended" && now.outcome === "done" })
    const thread = ThreadIdSchema.parse(f.world.agents.roster(f.apex.conversation)[0]!.child!.thread)
    assert.equal(f.world.store.edges().of(thread)?.resumed?.reason, "the host is stalling")
    assert.deepEqual(f.world.store.reportsOf(thread, 0).map((report) => report.status), ["done"], "the turn the person started reports to the Apex")
    const again = await f.world.agents.stop(f.apex.caller, { child: "labels", reason: "enough for today" })
    assert.deepEqual("stopped" in again && again.stopped, ["labels"])
    assert.deepEqual(f.state(), { kind: "ended", outcome: "stopped", reason: "enough for today" }, "a second stop says its own reason")
    await f.world.close()
  }
  console.log("the person's own message resumed it, and a second stop paused it again with its own reason")
} finally {
  rmSync(root, { recursive: true, force: true })
}
console.log("fin resume: ok")
