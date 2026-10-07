// Plan feedback against the real grok binary in a sealed HOME. A stand-in
// model calls `exit_plan_mode` over a written plan; Mako's Grok source keeps
// planning with the person's words, and the stand-in's next request carries
// them as the tool's result, in the wording `planFeedbackOf` reads back. The
// call's live update and the saved session say the same.
import assert from "node:assert/strict"
import { execFileSync, spawn } from "node:child_process"
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { createServer, type IncomingMessage } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ClientSideConnection, ndJsonStream, PROTOCOL_VERSION, type Client, type SessionNotification } from "@agentclientprotocol/sdk"
import { planFeedbackOf } from "@mako/sessions/harnesses"
import { z } from "zod"
import { acpAnswer } from "../electron/acp-decoder.ts"
import { acpReadable, acpWritable } from "../electron/acp-stream.ts"
import type { JsonObject } from "../electron/codex-app-json.ts"
import { acpClientCapabilities } from "../electron/providers/acp-source.ts"
import { grokAcpSource } from "../electron/providers/grok/acp.ts"

const WORDS = "Split the migration into two steps"
const EXIT_CALL = "call_exit_plan"

const installed = (() => {
  try {
    execFileSync("grok", ["--version"], { stdio: "ignore" })
    return true
  } catch {
    return false
  }
})()

const MessageText = z.string()
  .or(z.array(z.looseObject({ text: z.string().optional() })).transform((parts) => parts.map((part) => part.text ?? "").join("")))

const ChatRequest = z.object({
  stream: z.boolean().optional(),
  tools: z.array(z.object({ function: z.object({ name: z.string() }) })).optional(),
  messages: z.array(z.looseObject({ role: z.string(), content: MessageText.nullish(), tool_call_id: z.string().optional() })),
})

interface Delta {
  role?: "assistant"
  content?: string
  tool_calls?: { index: number; id: string; type: "function"; function: { name: string; arguments: string } }[]
}

interface StreamChoice {
  index: number
  delta: Delta
  finish_reason: string | null
}

const read = async (request: IncomingMessage) => {
  let body = ""
  for await (const chunk of request) body += chunk
  return body
}

if (!installed) console.log("Grok plan feedback: skipped, grok is not installed")
else {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "grok-plan-feedback-")))
  const after: (() => void)[] = []
  try {
    const home = join(root, "home")
    const project = join(root, "project")
    mkdirSync(join(home, ".grok"), { recursive: true })
    mkdirSync(project, { recursive: true })
    execFileSync("git", ["init", "-q", project])

    let exitOffered = false
    let toolResult: string | undefined
    const models = createServer(async (request, res) => {
      if (request.method !== "POST") {
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify({ object: "list", data: [{ id: "double", object: "model" }] }))
        return
      }
      const body = ChatRequest.parse(JSON.parse(await read(request)))
      const answered = body.messages.find((message) => message.role === "tool" && message.tool_call_id === EXIT_CALL)
      if (answered) toolResult = answered.content ?? ""
      const callsExit = !answered && body.tools?.some((tool) => tool.function.name === "exit_plan_mode")
      if (callsExit) exitOffered = true
      const delta: Delta = callsExit
        ? { role: "assistant", tool_calls: [{ index: 0, id: EXIT_CALL, type: "function", function: { name: "exit_plan_mode", arguments: "{}" } }] }
        : { role: "assistant", content: "Revising." }
      const finish = callsExit ? "tool_calls" : "stop"
      const usage = { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 }
      if (body.stream) {
        res.writeHead(200, { "content-type": "text/event-stream" })
        const chunk = (choice: StreamChoice, last = false) =>
          res.write(`data: ${JSON.stringify({ id: "double", object: "chat.completion.chunk", created: 0, model: "double", choices: [choice], usage: last ? usage : undefined })}\n\n`)
        chunk({ index: 0, delta, finish_reason: null })
        chunk({ index: 0, delta: {}, finish_reason: finish }, true)
        res.end("data: [DONE]\n\n")
        return
      }
      const { role, ...message } = delta
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ id: "double", object: "chat.completion", created: 0, model: "double", usage,
        choices: [{ index: 0, message: { role, ...message }, finish_reason: finish }] }))
    })
    await new Promise<void>((listening) => models.listen(0, "127.0.0.1", listening))
    after.push(() => models.close())
    const port = z.object({ port: z.number() }).parse(models.address()).port
    writeFileSync(join(home, ".grok", "config.toml"), `[models]\ndefault = "double"\n\n[model.double]\nmodel = "double"\nbase_url = "http://127.0.0.1:${port}/v1"\nname = "Double"\napi_key = "double-key"\napi_backend = "chat_completions"\ncontext_window = 128000\n`)
    const env = { PATH: process.env.PATH, HOME: home, GROK_HOME: join(home, ".grok"), GROK_TELEMETRY_ENABLED: "0", GROK_DISABLE_AUTOUPDATER: "1" }
    const launch = await grokAcpSource.launch({ appPath: "/app", execPath: process.execPath, cwd: project, env, access: "ask" })
    assert.ok(launch)

    const child = spawn(launch.command, launch.args, { cwd: project, env, stdio: ["pipe", "pipe", "ignore"] })
    after.push(() => child.kill("SIGTERM"))
    const asked: { method: string; feedbackOption?: string }[] = []
    const updates: SessionNotification[] = []
    const client: Client = {
      async requestPermission(params) {
        const allow = params.options.find((option) => option.kind === "allow_once")
        return allow ? { outcome: { outcome: "selected", optionId: allow.optionId } } : { outcome: { outcome: "cancelled" } }
      },
      async sessionUpdate(notification) {
        updates.push(notification)
      },
      async extNotification() {},
      async extMethod(method: string, params: JsonObject) {
        const request = grokAcpSource.requests?.decode(method, params)
        assert.ok(request, `Mako reads ${method}`)
        asked.push({ method, feedbackOption: request.ask.request.feedbackOption })
        const keep = request.ask.request.feedbackOption
        return acpAnswer(request.ask, keep ? { kind: "choice", optionId: keep, feedback: WORDS } : { kind: "choice", optionId: null })
      },
    }
    const connection = new ClientSideConnection(() => client, ndJsonStream(acpWritable(child.stdin), acpReadable(child.stdout)))
    await connection.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: acpClientCapabilities(grokAcpSource) })
    const session = await connection.newSession({ cwd: project, mcpServers: [] })
    // Grok lists no session modes, but session/set_mode takes `plan`.
    await connection.setSessionMode({ sessionId: session.sessionId, modeId: "plan" })
    const sessionDir = join(home, ".grok", "sessions", encodeURIComponent(project), session.sessionId)
    mkdirSync(sessionDir, { recursive: true })
    writeFileSync(join(sessionDir, "plan.md"), "# Migrate the store\n\n1. Add the column.\n2. Backfill it.\n")

    const turn = await connection.prompt({ sessionId: session.sessionId, prompt: [{ type: "text", text: "Plan the migration." }] })
    assert.equal(turn.stopReason, "end_turn")
    assert.ok(exitOffered, "the stand-in called exit_plan_mode")
    assert.deepEqual(asked, [{ method: "_x.ai/exit_plan_mode", feedbackOption: "keep-planning" }], "Mako was asked once, and offered words on keep planning")
    assert.equal(planFeedbackOf(toolResult), WORDS, "the model got the person's words as exit_plan_mode's result")

    const shown = updates.flatMap(({ update }) =>
      update.sessionUpdate === "tool_call_update"
        ? (update.content ?? []).flatMap((item) => item.type === "content" && item.content.type === "text" ? [item.content.text] : [])
        : [])
    assert.ok(shown.some((text) => planFeedbackOf(text) === WORDS), "the call's live update carries the words for its row")

    const saved = readdirSync(sessionDir).filter((name) => name.endsWith(".jsonl"))
      .map((name) => readFileSync(join(sessionDir, name), "utf8")).join("\n")
    assert.ok(saved.includes(JSON.stringify(`The user wants to revise the plan. The user said:\n${WORDS}`).slice(1, -1)),
      "the saved session keeps the same words, so a reopened transcript shows them too")

    console.log("Grok plan feedback: the person's words reached the model inside exit_plan_mode's result, live and saved")
  } finally {
    for (const done of after.reverse()) done()
    rmSync(root, { recursive: true, force: true })
  }
}
