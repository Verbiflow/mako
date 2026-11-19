// Stop on Claude Code keeps its process (`keepStopped` in `harnesses/claude/sdk-driver.ts`) and still means what it
// meant when it closed it: the turn ends, what the process had queued is gone, its background work ends, and nothing
// goes by itself afterwards. Held here on the real Claude Code CLI through Mako's own driver, in a sealed home against
// the scripted model (no account; nothing leaves this machine):
//
// - mid-text: a slow answer stops, the session is ready and still connected, and the next message is answered by the
//   same process;
// - mid-tool: a command that would write a file after six seconds never writes it;
// - with a message queued in the process (a steer it holds until the command returns): the model never hears it and
//   the command never finishes. This is the one case Stop still closes the process for: the CLI, asked to interrupt
//   with a message queued, drops the message but lets the command run to its end, and Stop doesn't wait for that. The
//   session then resumes on a new process, as it always did after a Stop;
// - with a background task running: its process is gone, and Claude starts no turn of its own on its end;
// - twice in a row, and with no turn running: each Stop answers, and the session stays connected;
// - Stop then a message at once: the model is asked with that message, in the time a message takes.
//
// "Still connected" is the proof the process was kept: the driver says `disconnected` when it closes one, and a
// message after that would have started another (`initialized` in the host log, counted here).
//
//   npx tsx --tsconfig tsconfig.scripts.json scripts/test-claude-stop-live.ts
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { followHostLog } from "@mako/host/base/host-log"
import type { LiveDriverEvent } from "@mako/host/contracts/live-conversations"
import { installClaude } from "@mako/host/harnesses/claude/index"
import { admitted } from "./fixtures/admitted-start.ts"
import { sealedDrivers } from "./fixtures/sealed-drivers.ts"
import { sandboxed } from "./harness-sandbox.ts"
import { pointAt, SCRIPTED_GETS } from "./scripted-harness-env.ts"
import { scriptedModel, type ScriptedReply } from "./scripted-model.ts"

const driver = sealedDrivers([installClaude]).get("claude")
assert.ok(driver)
if (!driver.available(process.cwd())) {
  console.log("SKIP: Claude Code isn't installed here")
  process.exit(0)
}

await sandboxed("mako-claude-stop", "claude", async (sandbox) => {
  /** Every conversation request the model got, and when. */
  const heard: { at: number; text: string }[] = []
  /** What the model answers a request carrying each tag, once. */
  const replies = new Map<string, ScriptedReply>()
  const model = await scriptedModel({
    reply: (text) => {
      heard.push({ at: Date.now(), text })
      for (const [tag, reply] of replies) {
        if (!text.includes(tag)) continue
        replies.delete(tag)
        return reply
      }
      return { text: "Done." }
    },
    answers: SCRIPTED_GETS,
  })
  const env = { ...sandbox.env }
  await pointAt("claude", sandbox, model.url, env, "claude-stop-test")
  Object.assign(env, { CLAUDE_CONFIG_DIR: join(sandbox.home, ".claude"), ANTHROPIC_BASE_URL: model.url, ANTHROPIC_API_KEY: "claude-stop-test" })
  for (const key of ["HOME", "CLAUDE_CONFIG_DIR"] as const)
    if (!env[key]?.startsWith(sandbox.home)) throw new Error(`Claude's ${key} is outside its sealed home; nothing was started`)

  const id = randomUUID()
  const events: LiveDriverEvent[] = []
  let launches = 0
  const closes: string[] = []
  const unlog = followHostLog((line) => {
    if (line.scope !== "claude-sdk") return
    if (line.message === "initialized") launches += 1
    if (line.message === "stop closes the process" || line.message === "a stop couldn't keep the process") closes.push(`${line.message} ${JSON.stringify(line.fields)}`)
  })
  const session = () => events.findLast((event) => event.type === "live-session")?.session
  const until = async (ready: () => boolean, what: string, timeoutMs = 30_000) => {
    for (const deadline = Date.now() + timeoutMs; !ready(); await delay(10))
      if (Date.now() > deadline) throw new Error(`Timed out: ${what} (${session()?.status}/${session()?.connection})`)
  }
  const prompt = (text: string) => driver.prompt(id, text, [], undefined, { operationId: randomUUID(), attemptId: randomUUID(), report: () => {} })
  /** Starts a turn and answers once the model was asked with `tag`. */
  const turn = async (tag: string, text: string) => {
    const from = heard.length
    await prompt(`${tag} ${text}`)
    await until(() => heard.slice(from).some((each) => each.text.includes(tag)), `the model to be asked with ${tag}`)
  }
  /** Stop, and what a Stop that kept the process leaves: ready, connected, interrupted, with no background work. */
  const stop = async (what: string) => {
    const began = performance.now()
    await driver.cancel(id)
    const took = performance.now() - began
    assert.equal(session()?.status, "ready", `${what}: the turn ended`)
    assert.equal(session()?.connection, "connected", `${what}: the process was kept (${closes.join("; ")})`)
    assert.equal(session()?.lastStop, "interrupted", `${what}: it ended as a Stop`)
    assert.equal(session()?.error, undefined, `${what}: an interrupted turn's own result is not an error`)
    assert.ok(!session()?.backgroundTasks, `${what}: no background work is left`)
    assert.deepEqual(closes, [], `${what}: Stop closed nothing`)
    return took
  }
  const bash = (command: string, background = false) => ({ id: `call_${randomUUID().slice(0, 8)}`, name: "Bash", arguments: { command, description: "Run it", timeout: 120_000, ...background && { run_in_background: true } } })
  const running = (marker: string) => {
    try { return execFileSync("pgrep", ["-f", marker], { encoding: "utf8" }).trim().split("\n").filter(Boolean).length } catch { return 0 }
  }

  try {
    await driver.start(sandbox.project, admitted("claude", {
      conversationId: id, emit: (event) => events.push(event), modeId: "bypassPermissions",
      mcpSnapshot: async () => ({ cwd: sandbox.project, generatedAt: Date.now(), servers: [], providers: [] }),
    }, { env }))
    await turn("STOP-WARM", "say done.")
    await until(() => session()?.status === "ready", "the first turn to end")
    assert.equal(launches, 1)

    // 1. Mid-text: an answer of sixty words, one every 150 ms.
    replies.set("STOP-TEXT", { text: Array.from({ length: 60 }, (_, index) => `word${index}`).join(" "), pace: 150 })
    await turn("STOP-TEXT", "say a lot.")
    await delay(1_000)
    const tookText = await stop("mid-text")
    const words = events.flatMap((event) => event.type === "live-update" ? [event.update] : event.type === "live-updates" ? event.updates : []).filter((update) => update.kind === "text").map((update) => update.text).join("")
    assert.ok(words.includes("word1") && !words.includes("word59"), "the answer stopped partway")

    // 2. Stop then a message at once: the same process answers it, in the time a message takes.
    const sent = Date.now()
    await turn("STOP-NEXT", "say done.")
    const nextMs = heard.findLast((each) => each.text.includes("STOP-NEXT"))!.at - sent
    await until(() => session()?.status === "ready" && session()?.lastStop === "completed", "the message after a Stop to be answered")
    assert.equal(launches, 1, "no process was started for it")

    // 3. A background task running, and no turn: Stop ends it, and Claude starts no turn on its end.
    const marker = `31${Math.floor(Math.random() * 9000 + 1000)}`
    replies.set("STOP-BACKGROUND", { text: "Started.", call: bash(`sleep ${marker}`, true) })
    await turn("STOP-BACKGROUND", "start the command you are given in the background, then say done.")
    await until(() => session()?.status === "ready" && running(`sleep ${marker}`) > 0, "the background command to run")
    assert.ok((session()?.backgroundTasks ?? 0) > 0, "the session counts its background work")
    const asked = heard.length
    const tookBackground = await stop("with a background task")
    await until(() => running(`sleep ${marker}`) === 0, "the background command's process to end", 5_000)
    await delay(3_000)
    assert.equal(heard.length, asked, "Claude asked its model nothing by itself after the Stop")
    assert.equal(session()?.status, "ready")

    // 4. Mid-tool with a background task running too, then Stop twice in a row.
    const second = `32${Math.floor(Math.random() * 9000 + 1000)}`
    replies.set("STOP-BOTH", { text: "Started.", call: bash(`sleep ${second}`, true) })
    const alsoWritten = join(sandbox.project, "also-written-after-six-seconds.txt")
    replies.set("Command running in background", { text: "Now the long one.", call: bash(`sleep 6 && echo late > ${alsoWritten}`) })
    await turn("STOP-BOTH", "start the first command in the background, then run the second.")
    await until(() => running(`sleep ${second}`) > 0, "the second background command to run")
    await delay(1_500)
    assert.equal(session()?.status, "running")
    const tookBoth = await stop("mid-tool with a background task")
    const tookAgain = await stop("a second Stop with nothing running")
    await until(() => running(`sleep ${second}`) === 0, "the second background command's process to end", 5_000)
    await delay(6_500)
    assert.equal(existsSync(alsoWritten), false, "the stopped command never finished")
    assert.equal(launches, 1, "one process served all of it so far")

    // 5. Mid-tool, with a message queued in the process: a steer it holds until the command returns.
    const written = join(sandbox.project, "written-after-six-seconds.txt")
    replies.set("STOP-TOOL", { text: "Running it.", call: bash(`sleep 6 && echo late > ${written}`) })
    await turn("STOP-TOOL", "run the command you are given.")
    await delay(1_200)
    const steering = driver.steering
    assert.ok(steering.kind === "supported")
    const steered = steering.steer(id, { id: randomUUID(), expectedRunId: session()?.nativeRunId ?? "", text: "STOP-QUEUED never hear this", attachments: [] })
      .then((result) => result.kind, (error: Error) => `rejected: ${error.message}`)
    await delay(300)
    const beganQueued = performance.now()
    await driver.cancel(id)
    const tookTool = performance.now() - beganQueued
    assert.equal(session()?.status, "ready", "with a message queued: the turn ended")
    assert.equal(session()?.lastStop, "interrupted")
    assert.equal(session()?.connection, "disconnected", "with a message queued the process is closed, as Stop always did")
    assert.equal(closes.length, 1, `and only then: ${closes.join("; ")}`)
    const steerEnded = await Promise.race([steered, delay(3_000).then(() => "still waiting")])
    assert.notEqual(steerEnded, "still waiting", "the queued steer's fate is said, one way or the other")
    await delay(6_500)
    assert.equal(existsSync(written), false, "the stopped command never finished")
    // The session goes on from its record, on a new process.
    await driver.start(sandbox.project, admitted("claude", {
      conversationId: id, resume: session()?.nativeId, emit: (event) => events.push(event), modeId: "bypassPermissions",
      mcpSnapshot: async () => ({ cwd: sandbox.project, generatedAt: Date.now(), servers: [], providers: [] }),
    }, { env }))


    // 6. And the session goes on: what the model is asked next holds the stopped turns, never the queued steer.
    await turn("STOP-LAST", "say done.")
    await until(() => session()?.status === "ready" && session()?.lastStop === "completed", "the last turn to end")
    assert.equal(heard.some((each) => each.text.includes("STOP-QUEUED")), false, "the model never heard the message Stop dropped from the queue")
    assert.equal(heard.at(-1)?.text.includes("STOP-TOOL"), true, "the session's history is whole: the same session went on")
    assert.equal(launches, 2, "one process served everything but the Stop with a message queued")
    const round = (value: number) => Math.round(value)
    console.log(`PASS: Stop on Claude Code keeps its process: mid-text ${round(tookText)} ms, mid-tool with a queued steer ${round(tookTool)} ms by closing the process (the steer ${steerEnded}), with a background task ${round(tookBackground)} ms, both ${round(tookBoth)} ms, again ${round(tookAgain)} ms; the next message reached the model ${nextMs} ms after it was sent; two launches, the second after the Stop that closed`)
  } finally {
    unlog()
    await Promise.resolve(driver.close(id)).catch(() => {})
    await driver.stop?.()
    await model.close()
  }
})
