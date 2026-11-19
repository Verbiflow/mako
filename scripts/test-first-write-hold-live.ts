import "./lib/scratch-git.mjs"
// A turn's first write held on the real Claude Code CLI: Mako's own live driver, in a sealed home, against the
// scripted model (no account; nothing leaves this machine). While the binding's write hold stands, the model's
// `Write` call doesn't run: the file isn't there and the model hears no result. Once the hold lets go, the call runs.
// A `Read` asked for while the hold stands runs at once. The launch carries a stdio MCP server as the person's own
// would be: its writes are held all the same, and its tool's call waits on the hold exactly as the `Write` did.
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
  // A stdio MCP server of the person's: one tool, which writes the file it's given. It notes when it started.
  const served = join(sandbox.project, "served.txt")
  const serverStarted = join(sandbox.home, "server-started")
  const server = join(sandbox.home, "their-server.cjs")
  writeFileSync(server, `const fs = require("node:fs")
fs.writeFileSync(${JSON.stringify(serverStarted)}, String(Date.now()))
const answer = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n")
let buffered = ""
process.stdin.on("data", (chunk) => {
  buffered += chunk
  for (let end = buffered.indexOf("\\n"); end >= 0; end = buffered.indexOf("\\n")) {
    const line = buffered.slice(0, end)
    buffered = buffered.slice(end + 1)
    if (!line.trim()) continue
    const message = JSON.parse(line)
    if (message.id === undefined) continue
    if (message.method === "initialize") answer(message.id, { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "theirs", version: "1" } })
    else if (message.method === "tools/list") answer(message.id, { tools: [{ name: "write_file", description: "Writes a file.", inputSchema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } }] })
    else if (message.method === "tools/call") {
      fs.writeFileSync(message.params.arguments.path, message.params.arguments.content)
      answer(message.id, { content: [{ type: "text", text: "written" }] })
    } else answer(message.id, {})
  }
})
`)
  writeFileSync(readable, "already here")
  const heard: { at: number; body: string }[] = []
  const replies: ScriptedReply[] = [
    { call: { id: "call_read", name: "Read", arguments: { file_path: readable } } },
    { call: { id: "call_write", name: "Write", arguments: { file_path: target, content: "written by the agent" } } },
    { call: { id: "call_server", name: "mcp__theirs__write_file", arguments: { path: served, content: "written by the server" } } },
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
  // As a turn's checkpoint holds it (`LiveCheckpoints`): released before any freeze, so the write counts as early.
  let early = 0
  const unhold = holds.hold(id, { until: gate.promise, frozen: () => false, wrote: () => { early += 1 } })
  const timeline: Record<string, number> = {}
  try {
    await driver.start(sandbox.project, admitted("claude", {
      conversationId: id, emit, modeId: "bypassPermissions",
      // As another harness's stdio server reaches a Claude launch (`acpMcpServers`): the kind that once made the
      // launch hold nothing.
      mcpSnapshot: async () => ({ cwd: sandbox.project, generatedAt: Date.now(), providers: [], servers: [{
        id: "theirs", name: "theirs", transport: "stdio", command: process.execPath, args: [server], envNames: [], headerNames: [], portable: true,
        availability: "available", origins: [{ provider: "codex", account: "default", scope: "user", provenance: "fixture" }],
      }] }),
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
    // The next hold, as the next turn's checkpoint would stand: in place before the write goes, so the server's tool
    // the model asks for after it meets a hold that hasn't let go.
    const serverGate = Promise.withResolvers<void>()
    let serverEarly = 0
    const unholdServer = holds.hold(id, { until: serverGate.promise, frozen: () => false, wrote: () => { serverEarly += 1 } })
    timeline.released = Date.now()
    gate.resolve()
    while (!existsSync(target) && Date.now() < deadline + 30_000) await delay(20)
    timeline.written = Date.now()
    assert.equal(readFileSync(target, "utf8"), "written by the agent", "once the hold lets go, the write runs")
    assert.equal(early, 1, "the write let go before a freeze is said once; the read never was")
    assert.ok(holds.attends(id), "the sealed launch, with a stdio MCP server but none of the person's hooks or plugins, holds its writes")
    while (Date.now() < deadline + 60_000 && heard.length < 3) await delay(50)
    assert.ok(heard.length >= 3, "the model heard the write's result after the hold let go, and asked for the server's tool")
    assert.ok(existsSync(serverStarted), "the person's stdio server is running in this launch")
    timeline.serverAsked = heard[2]!.at
    await delay(HELD_FOR_MS)
    assert.equal(existsSync(served), false, `the server's tool hasn't run ${HELD_FOR_MS} ms after the model asked for it: it never reached the server`)
    assert.equal(heard.length, 3, "the model has heard no result for the held server tool")
    timeline.serverReleased = Date.now()
    serverGate.resolve()
    while (!existsSync(served) && Date.now() < deadline + 90_000) await delay(20)
    timeline.served = Date.now()
    assert.equal(readFileSync(served, "utf8"), "written by the server", "once the hold lets go, the server's tool runs")
    assert.equal(serverEarly, 1, "the server tool's write let go before a freeze is said once")
    unholdServer()
    while (Date.now() < deadline + 120_000 && !(heard.length >= 4 && status() !== "running" && status() !== "starting")) await delay(100)
    assert.ok(heard.length >= 4, "the model heard the server tool's result after the hold let go")
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
  console.log(`PASS: Claude Code's held Write stayed unrun ${HELD_FOR_MS} ms after the model asked for it; its Read ran at once; released, the write ran ${timeline.written! - timeline.released!} ms later; a stdio MCP server's tool stayed unrun as long, and ran ${timeline.served! - timeline.serverReleased!} ms after its hold let go`)
})
await driver.stop?.()
