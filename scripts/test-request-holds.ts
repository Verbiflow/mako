import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { LiveRequest } from "@mako/host/contracts/live-conversations"
import { latchedByStop } from "@mako/host/contracts/delivery-retry"
import { holdOf, nextInLine } from "@mako/host/contracts/request-hold"
import { LiveJournal } from "@mako/host/conversations/live-journal"
import { AgentsWorld, HARNESSES, type Script } from "./lib/agents-world.ts"

/**
 * One reading of why a queued message waits, and one rule for what goes next
 * (`npm run test:request-holds`), step one of the one delivery queue
 * (`AGENTS.md`, "One delivery queue"). Covered: the hold each held message is
 * under; an edit, a sign-out, a message about to go again or one Mako's exit
 * paused keeps the line, while after the person's Stop a new message goes and
 * what the Stop paused waits for Resume; a message about to go again goes first when a new one comes;
 * one timer sends a held message at its time with nothing polling; the
 * queue's order, moved by an interrupt or a resume, survives the journal
 * being read again; and a message waiting to go again survives the host
 * killed with SIGKILL, and goes once. The engine cases run on each of the six
 * scripted harnesses.
 */
const root = mkdtempSync(join(tmpdir(), "mako-request-holds-"))
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function until(what: string, done: () => boolean, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`)
    await pause(10)
  }
}

type Row = Pick<LiveRequest, "status" | "signIn" | "editing" | "retry" | "wake" | "pause"> & { id: string }
const row = (id: string, status: LiveRequest["status"], marks: Partial<Row> = {}): Row => ({ id, status, ...marks })
const retry = { at: 5, attempt: 1, since: 0, cause: "rate-limited" as const, reason: "429" }
const signIn = { harness: "claude", account: "", credential: "", at: 0 }

/** A turn told to "Hold." runs until `release`; every other turn ends at once. */
const script: Script = (turn) => (turn.text.includes("Hold.") ? turn.world.hold(turn.conversation).then(() => "Held.") : "Done.")

function requestOf(world: AgentsWorld, conversation: string, words: string): LiveRequest | undefined {
  return world.live.snapshot(conversation)?.requests.find((request) => request.text.includes(words))
}

function sent(world: AgentsWorld, conversation: string): string[] {
  return world.prompts.filter((prompt) => prompt.conversation === conversation).map((prompt) => /\b(One|Two|Three|Hold)\./.exec(prompt.text)?.[1] ?? prompt.text.slice(0, 20))
}

/** The child host: a conversation asleep whose wake fails at capacity, so its message waits to go again; then it waits to be killed. */
async function childHost(dir: string, harness: string): Promise<void> {
  let fail = false
  const world = new AgentsWorld({
    root: dir,
    script,
    starting: () => {
      if (!fail) return
      fail = false
      throw new Error("[unavailable] Server at capacity")
    },
  })
  const { conversation } = await world.apex(harness, "full")
  world.say(conversation, "One.")
  await until("its first turn", () => requestOf(world, conversation, "One.")?.status === "completed")
  world.live.hibernateIfIdle(conversation, "test")
  await until("it to sleep", () => world.live.session(conversation)?.connection === "hibernated")
  fail = true
  world.say(conversation, "Two.")
  await until("the wake to fail", () => requestOf(world, conversation, "Two.")?.status === "held")
  writeFileSync(join(dir, "ready"), conversation)
  await new Promise(() => {})
}

if (process.argv[2] === "--host") {
  await childHost(process.argv[3]!, process.argv[4]!)
}

try {
  // One reading of each hold, and one rule for the line.
  {
    assert.equal(holdOf(row("a", "queued")), undefined)
    assert.equal(holdOf(row("a", "held", { editing: true, retry }))?.kind, "edit", "the person's edit is the hold, whatever else it carries")
    assert.equal(holdOf(row("a", "held", { signIn, editing: true }))?.kind, "sign-in")
    assert.equal(holdOf(row("a", "held", { retry }))?.kind, "retry")
    assert.equal(holdOf(row("a", "held", { wake: { at: 9, after: "x" } }))?.kind, "until")
    assert.deepEqual(holdOf(row("a", "held", { pause: "stop" })), { kind: "paused", by: "stop" })
    assert.deepEqual(holdOf(row("a", "held")), { kind: "paused", by: "mako" })
    assert.deepEqual(holdOf(row("a", "held", { pause: "stop", retry })), { kind: "paused", by: "stop" }, "a Stop overrides a retry")
    assert.deepEqual(holdOf(row("a", "held", { pause: "stop", wake: { at: 9, after: "x" } })), { kind: "paused", by: "stop" }, "and a timed send")
    // A send the Stop latched as it went, whose 429 came back after: written held as the Stop's pause, no time left on it.
    const [late] = latchedByStop([{ ...row("l", "held", { pause: "stop", retry }), text: "", attachments: [] }])
    assert.deepEqual([holdOf(late!), late!.retry], [{ kind: "paused", by: "stop" }, undefined], "a late refusal after a Stop is the Stop's pause")
    const next = (rows: Row[], newestOnly = false) => nextInLine(rows, newestOnly)?.id
    assert.equal(next([row("p", "held", { pause: "stop" }), row("q", "queued")]), "q", "what a Stop paused lets a later message go")
    assert.equal(next([row("p", "held"), row("q", "queued")]), undefined, "what Mako's exit or a crash paused keeps its place")
    assert.equal(next([row("u", "held", { wake: { at: 9, after: "x" } }), row("q", "queued")]), "q", "a timed resume lets one go too")
    assert.equal(next([row("e", "held", { editing: true }), row("q", "queued")]), undefined, "nothing goes ahead of an edit")
    assert.equal(next([row("s", "held", { signIn }), row("q", "queued")]), undefined, "nor ahead of a sign-out's pause")
    assert.equal(next([row("r", "held", { retry }), row("q", "queued")]), undefined, "nor ahead of a message about to go again")
    assert.equal(next([row("q1", "queued"), row("e", "held", { editing: true }), row("q2", "queued")], true), "q1", "after a failure, the newest before the line's hold")
    assert.equal(next([row("q1", "queued"), row("p", "held", { pause: "stop" }), row("q2", "queued")], true), "q2")
  }
  console.log("holds: one reading; an edit, a sign-out, a retry or Mako's own pause keeps the line, a Stop's lets later messages go")

  for (const harness of HARNESSES) {
    // After a Stop, a new message goes while what the Stop paused waits for Resume.
    {
      const world = new AgentsWorld({ root: join(root, `${harness}-stop`), script })
      const { conversation } = await world.apex(harness, "full")
      const held = world.say(conversation, "Hold.")
      await until("the turn", () => world.live.session(conversation)?.status === "running")
      world.say(conversation, "One.")
      assert.equal(await world.live.stopRequest(conversation, held), true)
      await until("the stop", () => requestOf(world, conversation, "One.")?.status === "held")
      assert.deepEqual(holdOf(requestOf(world, conversation, "One.")!), { kind: "paused", by: "stop" })
      world.say(conversation, "Two.")
      await until(`${harness}: the new message to go`, () => requestOf(world, conversation, "Two.")?.status === "completed")
      assert.equal(requestOf(world, conversation, "One.")?.status, "held", "what the Stop paused waits")
      const one = requestOf(world, conversation, "One.")!
      world.live.editQueued(conversation, { requestId: one.id, expectedText: one.text, change: { kind: "resume" } })
      await until("Resume to send it", () => requestOf(world, conversation, "One.")?.status === "completed")
      assert.deepEqual(sent(world, conversation), ["Hold", "Two", "One"])
      await world.close()
    }

    // The person's Stop overrides every hold: a message about to go again and one timed both pause, and nothing sends by itself, across a restart too.
    {
      let fails = true
      const world = new AgentsWorld({ root: join(root, `${harness}-stop-overrides`), script, refusePrompt: () => (fails ? ((fails = false), "429 Too Many Requests") : undefined) })
      const { conversation } = await world.apex(harness, "full")
      world.live.submit(conversation, randomUUID(), "Two.", [], undefined, undefined, undefined, undefined, { wake: { at: Date.now() + 60_000, after: "earlier" } })
      world.say(conversation, "One.")
      await until("One to wait to go again", () => holdOf(requestOf(world, conversation, "One.") ?? row("x", "queued"))?.kind === "retry")
      await world.live.cancel(conversation)
      for (const words of ["One.", "Two."]) assert.deepEqual(holdOf(requestOf(world, conversation, words)!), { kind: "paused", by: "stop" }, `${harness}: ${words} paused by the Stop`)
      world.live.wakeDue(Date.now() + 11 * 60_000)
      await pause(300)
      await world.restart()
      world.live.wakeDue(Date.now() + 11 * 60_000)
      await pause(500)
      assert.deepEqual(sent(world, conversation), [], `${harness}: nothing after the Stop, nor after a restart`)
      for (const words of ["One.", "Two."]) {
        const request = requestOf(world, conversation, words)!
        world.live.editQueued(conversation, { requestId: request.id, expectedText: request.text, change: { kind: "resume" } })
      }
      await until(`${harness}: Resume to send them`, () => requestOf(world, conversation, "Two.")?.status === "completed")
      assert.deepEqual([...sent(world, conversation)].sort(), ["One", "Two"])
      await world.close()
    }

    // A provider wait keeps its place and its due time when another message arrives.
    {
      let fail = false
      const world = new AgentsWorld({
        root: join(root, `${harness}-retry-first`),
        script,
        starting: () => {
          if (!fail) return
          fail = false
          throw new Error("[unavailable] Server at capacity")
        },
      })
      const { conversation } = await world.apex(harness, "full")
      world.say(conversation, "Hold.")
      await until("the turn", () => world.live.session(conversation)?.status === "running")
      world.release(conversation)
      await until("it to end", () => requestOf(world, conversation, "Hold.")?.status === "completed")
      world.live.hibernateIfIdle(conversation, "test")
      await until("it to sleep", () => world.live.session(conversation)?.connection === "hibernated")
      fail = true
      world.say(conversation, "One.")
      await until("the wake to fail", () => holdOf(requestOf(world, conversation, "One.") ?? row("x", "queued"))?.kind === "retry")
      world.say(conversation, "Two.")
      const waiting = requestOf(world, conversation, "One.")!
      assert.equal(waiting.status, "held", "new words cannot make capacity return sooner")
      world.live.wakeDue(waiting.retry!.at + 1)
      await until(`${harness}: both to go`, () => requestOf(world, conversation, "Two.")?.status === "completed")
      assert.deepEqual(sent(world, conversation), ["Hold", "One", "Two"], "the message waiting to go again went first")
      await world.close()
    }

    // One timer sends a held message at its time, nothing polling.
    {
      const world = new AgentsWorld({ root: join(root, `${harness}-timer`), script })
      const { conversation } = await world.apex(harness, "full")
      world.say(conversation, "One.")
      await until("One", () => requestOf(world, conversation, "One.")?.status === "completed")
      // As the person's "Resume at", a time 300 ms out.
      world.live.submit(conversation, randomUUID(), "Three.", [], undefined, undefined, undefined, undefined, { wake: { at: Date.now() + 300, after: requestOf(world, conversation, "One.")!.id } })
      assert.equal(requestOf(world, conversation, "Three.")?.status, "held")
      await until(`${harness}: the timer to send it`, () => requestOf(world, conversation, "Three.")?.status === "completed", 3_000)
      await world.close()
    }

    // The queue's order, moved by an interrupt, is the order the journal reads back.
    {
      const world = new AgentsWorld({ root: join(root, `${harness}-order`), script })
      const { conversation } = await world.apex(harness, "full")
      world.say(conversation, "Hold.")
      await until("the turn", () => world.live.session(conversation)?.status === "running")
      world.say(conversation, "One.")
      world.say(conversation, "Two.")
      const three = randomUUID()
      assert.equal(world.live.interrupt(conversation, three, "Three.", []), true)
      const order = world.live.snapshot(conversation)!.requests.map((request) => request.id)
      const journal = new LiveJournal(join(world.root, "journals"), conversation)
      assert.deepEqual(journal.read()?.requests.map((request) => request.id), order, `${harness}: the journal keeps the order an interrupt made`)
      journal.close()
      await until("all to go", () => requestOf(world, conversation, "Two.")?.status === "completed")
      assert.deepEqual(sent(world, conversation), ["Hold", "Three", "One", "Two"])
      await world.close()
    }

    // A message waiting to go again survives SIGKILL, and goes once.
    {
      const dir = join(root, `${harness}-kill`)
      const child = spawn(process.execPath, ["--import", "tsx", import.meta.filename, "--host", dir, harness], { stdio: "ignore" })
      await until("the child host", () => { try { return Boolean(readFileSync(join(dir, "ready"), "utf8")) } catch { return false } }, 30_000)
      const conversation = readFileSync(join(dir, "ready"), "utf8")
      child.kill("SIGKILL")
      await new Promise((resolve) => child.once("exit", resolve))
      const world = new AgentsWorld({ root: dir, script })
      const two = requestOf(world, conversation, "Two.")
      assert.equal(holdOf(two ?? row("x", "queued"))?.kind, "retry", `${harness}: the next host reads it waiting to go again`)
      world.live.wakeDue(Date.now() + 11 * 60_000)
      await until(`${harness}: it to go after the kill`, () => requestOf(world, conversation, "Two.")?.status === "completed")
      assert.equal(world.prompts.filter((prompt) => prompt.conversation === conversation && prompt.text.includes("Two.")).length, 1, "once")
      await world.close()
    }
    console.log(`${harness}: after a Stop a new message went and Resume sent the paused one; a retry went first; one timer sent a held message; the journal kept an interrupt's order; a retry survived SIGKILL and went once`)
  }
} finally {
  if (process.argv[2] !== "--host") rmSync(root, { recursive: true, force: true })
}
if (process.argv[2] !== "--host") console.log("request holds: ok")
