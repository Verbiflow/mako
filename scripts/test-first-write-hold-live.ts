import "./lib/scratch-git.mjs"
// A turn's first write held on the real Claude Code CLI: Mako's own live driver, in a sealed home, against the
// scripted model (no account; nothing leaves this machine). While the binding's write hold stands, the model's
// `Write` call doesn't run: the file isn't there and the model hears no result. Once the hold lets go, the call runs.
// A `Read` asked for while the hold stands runs at once.
//
//   npm run test:first-write-hold-live [-- --evidence <dir>]
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { mkdir, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import type { LiveDriverEvent } from "@mako/host/contracts/live-conversations"
import { installClaude } from "@mako/host/harnesses/claude/index"
import { WriteHolds } from "@mako/host/harnesses/write-holds"
import { admitted } from "./fixtures/admitted-start.ts"
import { sealedDrivers } from "./fixtures/sealed-drivers.ts"
import { sandboxed } from "./harness-sandbox.ts"
import { pointAt, SCRIPTED_GETS } from "./scripted-harness-env.ts"
import { scriptedModel, type ScriptedReply } from "./scripted-model.ts"

const args = process.argv.slice(2)
const evidenceAt = args.indexOf("--evidence")
const evidence = evidenceAt === -1 ? undefined : args[evidenceAt + 1]

/** How long the held write must stay unrun: well past the CLI's own turnaround for a call. */
const HELD_FOR_MS = 4_000

const holds = new WriteHolds()
const driver = sealedDrivers([installClaude], { writeHolds: holds }).get("claude")
assert.ok(driver, "Claude's live driver registered")
assert.ok(driver.firstWrite, "Claude declares that it holds its agent's writes when the host gives it write holds")

await sandboxed("mako-first-write", "claude", async (sandbox) => {
  const target = join(sandbox.project, "held.txt")
  const readable = join(sandbox.project, "notes.txt")
  writeFileSync(readable, "already here")
  const heard: { at: number; body: string }[] = []
  const replies: ScriptedReply[] = [
    { call: { id: "call_read", name: "Read", arguments: { file_path: readable } } },
    { call: { id: "call_write", name: "Write", arguments: { file_path: target, content: "written by the agent" } } },
  ]
  const model = await scriptedModel({
    reply: (body) => {
      heard.push({ at: Date.now(), body })
      return replies.shift() ?? { text: "Done." }
    },
    answers: SCRIPTED_GETS,
  })
  const env = { ...sandbox.env }
  await pointAt("claude", sandbox, model.url, env, "first-write-hold")
  Object.assign(env, { CLAUDE_CONFIG_DIR: join(sandbox.home, ".claude"), ANTHROPIC_BASE_URL: model.url, ANTHROPIC_API_KEY: "first-write-hold" })
  for (const key of ["HOME", "CLAUDE_CONFIG_DIR"] as const)
    if (!env[key]?.startsWith(sandbox.home)) throw new Error(`Claude's ${key} is outside its sealed home; nothing was started`)
  const id = randomUUID()
  const events: LiveDriverEvent[] = []
  const emit = (event: LiveDriverEvent) => events.push(event)
  const status = () => events.findLast((event) => event.type === "live-session")?.session.status
  const gate = Promise.withResolvers<void>()
  const unhold = holds.hold(id, gate.promise)
  const timeline: Record<string, number> = {}
  try {
    await driver.start(sandbox.project, admitted("claude", {
      conversationId: id, emit, modeId: "bypassPermissions",
      mcpSnapshot: async () => ({ cwd: sandbox.project, generatedAt: Date.now(), servers: [], providers: [] }),
    }, { env }))
    if (events.some((event) => event.type === "live-session" && event.session.executionContext?.identity.kind === "reported"))
      throw new Error("Claude started signed in to an account, not the stand-in; nothing was sent")
    timeline.prompted = Date.now()
    await driver.prompt(id, "Read notes.txt, then write held.txt.", [], undefined, { operationId: randomUUID(), attemptId: randomUUID(), report: () => {} })
    // The model asked for the read, heard its result, then asked for the write.
    const deadline = Date.now() + 60_000
    while (heard.length < 2 && Date.now() < deadline) await delay(50)
    assert.ok(heard.length >= 2, "the read ran while the write hold stood: the model heard its result and asked for the write")
    assert.ok(heard[1]!.body.includes("already here"), "the read's result is what the file holds")
    timeline.writeAsked = heard[1]!.at
    await delay(HELD_FOR_MS)
    assert.equal(existsSync(target), false, `the held write hasn't run ${HELD_FOR_MS} ms after the model asked for it`)
    assert.equal(heard.length, 2, "the model has heard no result for the held write")
    timeline.released = Date.now()
    gate.resolve()
    while (!existsSync(target) && Date.now() < deadline + 30_000) await delay(20)
    timeline.written = Date.now()
    assert.equal(readFileSync(target, "utf8"), "written by the agent", "once the hold lets go, the write runs")
    while (Date.now() < deadline + 60_000 && !(heard.length >= 3 && status() !== "running" && status() !== "starting")) await delay(100)
    assert.ok(heard.length >= 3, "the model heard the write's result after the hold let go")
  } finally {
    gate.resolve()
    unhold()
    await Promise.resolve(driver.close(id)).catch(() => {})
    await model.close()
    if (evidence) {
      await mkdir(evidence, { recursive: true })
      await writeFile(join(evidence, "claude-first-write.json"), sandbox.scrub(JSON.stringify({ timeline, heard: heard.map(({ at }) => at), events }, null, 1)).replaceAll(homedir(), "~"))
    }
  }
  console.log(`PASS: Claude Code's held Write stayed unrun ${HELD_FOR_MS} ms after the model asked for it; its Read ran at once; released, the write ran ${timeline.written! - timeline.released!} ms later`)
})
await driver.stop?.()
