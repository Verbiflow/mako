import "./lib/scratch-git.mjs"
// Mako's review on a harness without one: the real grok binary in a sealed
// HOME, a stand-in model, and the prompt Mako's review sends. The model
// reads the target, the read-only rule and the block to end with; its reply
// streams back through Grok with the block intact, and the block parses into
// the findings the transcript draws as the review's card.
import assert from "node:assert/strict"
import { execFileSync, spawn } from "node:child_process"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { createServer, type IncomingMessage } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ClientSideConnection, ndJsonStream, PROTOCOL_VERSION, type Client } from "@agentclientprotocol/sdk"
import { z } from "zod"
import { makoReviewPrompt } from "@mako/host/contracts/live-reviews"
import { acpReadable, acpWritable } from "@mako/host/harnesses/acp-stream"
import { acpClientCapabilities } from "@mako/host/harnesses/acp-source"
import { createGrokAcpSource } from "@mako/host/harnesses/grok/acp"
import { REVIEW_FENCE, makoReviewReport } from "@mako/sessions/review"

const source = createGrokAcpSource()
assert.equal(source.review.kind, "mako", "Grok has no review of its own")

const installed = (() => {
  try {
    execFileSync("grok", ["--version"], { stdio: "ignore" })
    return true
  } catch {
    return false
  }
})()

const ChatRequest = z.object({
  stream: z.boolean().optional(),
  messages: z.array(z.looseObject({ role: z.string(), content: z.unknown() })),
})

const FINDINGS = {
  summary: "The change drops the empty-window guard.",
  findings: [{ title: "Dividing by an empty window", body: "`rate([])` returns `NaN`.", path: "src/rate.ts", line: 2, priority: 1 }],
}
const REPLY = `I read the commit and the code around it.\n\n\`\`\`${REVIEW_FENCE}\n${JSON.stringify(FINDINGS, null, 2)}\n\`\`\``

const read = async (request: IncomingMessage) => {
  let body = ""
  for await (const chunk of request) body += chunk
  return body
}

if (!installed) {
  console.log("Grok review: skipped, grok is not installed")
} else {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "mako-grok-review-")))
  const home = join(root, "home")
  const project = join(root, "project")
  mkdirSync(join(home, ".grok"), { recursive: true })
  mkdirSync(project, { recursive: true })
  execFileSync("git", ["init", "-q", project])
  const seen: string[] = []
  const models = createServer(async (request, response) => {
    if (request.method !== "POST") {
      response.writeHead(200, { "content-type": "application/json" })
      response.end(JSON.stringify({ object: "list", data: [{ id: "double", object: "model" }] }))
      return
    }
    const body = ChatRequest.parse(JSON.parse(await read(request)))
    const last = JSON.stringify(body.messages.at(-1)?.content ?? "")
    seen.push(last)
    const content = last.includes(REVIEW_FENCE) ? REPLY : "Title"
    const usage = { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 }
    if (body.stream) {
      response.writeHead(200, { "content-type": "text/event-stream" })
      // A model streams the block in pieces; it has to arrive whole all the same.
      for (const piece of content.match(/[\s\S]{1,24}/g) ?? [])
        response.write(`data: ${JSON.stringify({ id: "double", object: "chat.completion.chunk", created: 0, model: "double", choices: [{ index: 0, delta: { role: "assistant", content: piece }, finish_reason: null }] })}\n\n`)
      response.write(`data: ${JSON.stringify({ id: "double", object: "chat.completion.chunk", created: 0, model: "double", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage })}\n\n`)
      response.end("data: [DONE]\n\n")
      return
    }
    response.writeHead(200, { "content-type": "application/json" })
    response.end(JSON.stringify({ id: "double", object: "chat.completion", created: 0, model: "double", usage, choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }] }))
  })
  await new Promise<void>((listening) => models.listen(0, "127.0.0.1", listening))
  const port = z.object({ port: z.number() }).parse(models.address()).port
  writeFileSync(join(home, ".grok", "config.toml"), `[models]\ndefault = "double"\n\n[model.double]\nmodel = "double"\nbase_url = "http://127.0.0.1:${port}/v1"\nname = "Double"\napi_key = "double-key"\napi_backend = "chat_completions"\ncontext_window = 128000\n`)
  const env = { PATH: process.env.PATH, HOME: home, GROK_HOME: join(home, ".grok"), GROK_TELEMETRY_ENABLED: "0", GROK_DISABLE_AUTOUPDATER: "1" }
  const launch = await source.launch({ appPath: "/app", execPath: process.execPath, cwd: project, env, access: "ask" })
  assert.ok(launch)
  const child = spawn(launch.command, launch.args, { cwd: project, env, stdio: ["pipe", "pipe", "ignore"] })
  let said = ""
  const client: Client = {
    async requestPermission() { return { outcome: { outcome: "cancelled" } } },
    async sessionUpdate({ update }) {
      if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") said += update.content.text
    },
  }
  const connection = new ClientSideConnection(() => client, ndJsonStream(acpWritable(child.stdin), acpReadable(child.stdout)))
  try {
    await connection.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: acpClientCapabilities(source) })
    const { sessionId } = await connection.newSession({ cwd: project, mcpServers: [] })
    const prompt = makoReviewPrompt({ kind: "commit", sha: "4f1c2e9", title: "Drop the guard" }, source.review.kind === "mako" ? source.review.reviewer : undefined)
    const result = await connection.prompt({ sessionId, prompt: [{ type: "text", text: prompt }] })
    assert.equal(result.stopReason, "end_turn")

    const asked = seen.find((text) => text.includes(REVIEW_FENCE)) ?? ""
    assert.match(asked, /git show 4f1c2e9/, "the model is told how to read the commit")
    assert.match(asked, /Don't change any files\./, "the model is told the review is read-only")
    const block = new RegExp(`\`\`\`${REVIEW_FENCE}\\n([\\s\\S]*?)\\n\`\`\``).exec(said)?.[1]
    assert.ok(block, `the reply streamed back with its block whole: ${said.slice(0, 200)}`)
    assert.deepEqual(makoReviewReport(block), FINDINGS, "the block parses into the review's findings")
    console.log("Grok review: Mako's prompt reached the model with the commit, the read-only rule and the block to end with, and the streamed block parsed into the findings")
  } finally {
    child.kill("SIGTERM")
    models.close()
    rmSync(root, { recursive: true, force: true })
  }
}
