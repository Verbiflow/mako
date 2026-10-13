// Claude Code's own goal as the bar reads it: the real `claude` CLI the Agent
// SDK drives, in a sealed HOME, with a stand-in model that judges the goal
// unmet twice and then met, all in one turn. Each unmet verdict reaches Mako
// while the turn runs, from the Stop hook's feedback, and the turn's result
// carries the met record Claude has written by then, so the bar never lags.
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { query } from "@anthropic-ai/claude-agent-sdk"
import { z } from "zod"
import type { JsonObject } from "@mako/host/contracts/json"
import type { LiveDriverEvent } from "@mako/host/contracts/live-conversations"
import { createClaudeSdkDriver } from "@mako/host/harnesses/claude/sdk-driver"
import { admitted } from "./fixtures/admitted-start.ts"

try {
  execFileSync("claude", ["--version"], { stdio: "ignore" })
} catch {
  console.log("Claude goal: skipped, claude is not installed")
  process.exit(0)
}

const CONDITION = "A file named notes.md exists in the project"
const VERDICTS = [
  { ok: false, reason: "notes.md is still missing." },
  { ok: false, reason: "notes.md exists but is empty." },
  { ok: true, reason: "notes.md exists with notes in it." },
]
const MessagesRequest = z.looseObject({ model: z.string(), stream: z.boolean().optional() })

const root = realpathSync(mkdtempSync(join(tmpdir(), "mako-claude-goal-")))
const home = join(root, "home")
const project = join(root, "project")
for (const folder of [home, project]) mkdirSync(folder, { recursive: true })
let judged = 0
const server = createServer(async (request, response) => {
  let body = ""
  for await (const chunk of request) body += chunk
  if (request.url?.includes("count_tokens")) {
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ input_tokens: 10 }))
    return
  }
  if (request.method !== "POST" || !request.url?.startsWith("/v1/messages")) {
    response.writeHead(404).end("{}")
    return
  }
  const parsed = MessagesRequest.parse(JSON.parse(body))
  const judging = body.includes(String.raw`\"ok\": false, \"impossible\": true`)
  const text = judging ? JSON.stringify(VERDICTS[Math.min(judged++, VERDICTS.length - 1)]) : "Working on the notes."
  const usage = { input_tokens: 10, output_tokens: 2 }
  const message = { id: `msg_${randomUUID()}`, type: "message", role: "assistant", model: parsed.model, content: [], stop_reason: null, stop_sequence: null, usage }
  if (!parsed.stream) {
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ...message, content: [{ type: "text", text }], stop_reason: "end_turn" }))
    return
  }
  response.writeHead(200, { "content-type": "text/event-stream" })
  const send = (event: string, data: JsonObject) => response.write(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`)
  send("message_start", { message })
  send("content_block_start", { index: 0, content_block: { type: "text", text: "" } })
  send("content_block_delta", { index: 0, delta: { type: "text_delta", text } })
  send("content_block_stop", { index: 0 })
  send("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 2 } })
  send("message_stop", {})
  response.end()
})
await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready))
// SAFETY: a server listening on a TCP port reports an AddressInfo.
const { port } = server.address() as AddressInfo
const env = {
  PATH: process.env.PATH, HOME: home, CLAUDE_CONFIG_DIR: join(home, ".claude"),
  ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`, ANTHROPIC_API_KEY: "stand-in",
  DISABLE_TELEMETRY: "1", DISABLE_AUTOUPDATER: "1", DISABLE_ERROR_REPORTING: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
}

const events: LiveDriverEvent[] = []
const id = randomUUID()
const driver = createClaudeSdkDriver({
  available: () => true,
  configure: async () => ({
    options: { env, model: "claude-haiku-4-5", pathToClaudeCodeExecutable: "claude" },
    account: { name: "stand-in" },
  }),
  query: async (input) => query(input),
  configDir: () => join(home, ".claude"),
})
const until = async (label: string, predicate: () => boolean) => {
  const deadline = Date.now() + 60_000
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
    await delay(20)
  }
}

try {
  await driver.start(project, admitted("claude", { conversationId: id, emit: (event) => events.push(event) }))
  await until("the session to start", () => events.some((event) => event.type === "live-session" && event.session.status === "ready"))
  const before = events.length
  await driver.prompt(id, `/goal ${CONDITION}`, [], undefined, { operationId: randomUUID(), attemptId: randomUUID(), report: () => {} })
  await until("the turn's end", () => events.slice(before).some((event) => event.type === "live-session" && event.session.status === "ready"))
  const turn = events.slice(before)
  const end = turn.findIndex((event) => event.type === "live-session" && event.session.status === "ready")
  const goals = turn.flatMap((event, index) => event.type === "live-goal" ? [{ index, goal: event.goal }] : [])
  assert.equal(judged, 3, "Claude judged the goal three times in the one turn")
  assert.deepEqual(
    goals.filter(({ index }) => index < end).map(({ goal }) => goal && [goal.status, goal.note]),
    [
      ["active", VERDICTS[0]!.reason],
      ["active", VERDICTS[1]!.reason],
      ["complete", VERDICTS[2]!.reason],
    ],
    "each unmet verdict reaches the bar while the turn runs, and the met one before the turn ends",
  )
  const met = goals.at(-1)?.goal
  assert.equal(met?.objective, CONDITION)
  assert.equal(met?.turns, 3, "the met record counts Claude's three tries")
  console.log("Claude goal: each unmet verdict reaches the bar mid-turn from the Stop hook's feedback, and the met record is there by the turn's result")
} finally {
  await driver.close(id)
  server.close()
  rmSync(root, { recursive: true, force: true })
}
