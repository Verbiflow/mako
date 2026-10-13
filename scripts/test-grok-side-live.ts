import "./lib/scratch-git.mjs"
// Grok's own side question against the real grok binary in a sealed HOME,
// asked through Mako's Grok source with a stand-in model: answered while a
// main turn runs, a follow-up carrying the exchange before it, and neither
// in the history the next main turn sends the model.
import assert from "node:assert/strict"
import { execFileSync, spawn } from "node:child_process"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { createServer, type IncomingMessage } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ClientSideConnection, ndJsonStream, PROTOCOL_VERSION, type Client } from "@agentclientprotocol/sdk"
import { z } from "zod"
import { acpReadable, acpWritable } from "@mako/host/harnesses/acp-stream"
import { acpClientCapabilities, type AcpSidePeer } from "@mako/host/harnesses/acp-source"
import { createGrokAcpSource } from "@mako/host/harnesses/grok/acp"

const source = createGrokAcpSource()
const side = source.sideQuestions
assert.ok(side?.kind === "native", "Grok answers its own side questions")

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

const read = async (request: IncomingMessage) => {
  let body = ""
  for await (const chunk of request) body += chunk
  return body
}

if (!installed) {
  console.log("Grok side questions: skipped, grok is not installed")
} else {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "mako-grok-side-")))
  const home = join(root, "home")
  const project = join(root, "project")
  mkdirSync(join(home, ".grok"), { recursive: true })
  mkdirSync(project, { recursive: true })
  execFileSync("git", ["init", "-q", project])
  /** Every request the model saw, as its messages' text. */
  const seen: string[] = []
  let release: (() => void) | undefined
  const models = createServer(async (request, response) => {
    if (request.method !== "POST") {
      response.writeHead(200, { "content-type": "application/json" })
      response.end(JSON.stringify({ object: "list", data: [{ id: "double", object: "model" }] }))
      return
    }
    const body = ChatRequest.parse(JSON.parse(await read(request)))
    const all = JSON.stringify(body.messages)
    seen.push(all)
    const last = JSON.stringify(body.messages.at(-1)?.content ?? "")
    let content = "Main answer."
    if (last.includes("codename did I give")) content = all.includes("My side codename is KESTREL") ? "Your side codename is KESTREL." : "I don't know."
    else if (last.includes("marker")) content = all.includes("ORBIT-7") ? "The marker is ORBIT-7." : "I don't know."
    else if (last.includes("SLOW")) await new Promise<void>((resolve) => { release = resolve })
    const usage = { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 }
    if (body.stream) {
      response.writeHead(200, { "content-type": "text/event-stream" })
      response.write(`data: ${JSON.stringify({ id: "double", object: "chat.completion.chunk", created: 0, model: "double", choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }] })}\n\n`)
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
  const client: Client = {
    async requestPermission() { return { outcome: { outcome: "cancelled" } } },
    async sessionUpdate() {},
  }
  const connection = new ClientSideConnection(() => client, ndJsonStream(acpWritable(child.stdin), acpReadable(child.stdout)))
  try {
    await connection.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: acpClientCapabilities(source) })
    const { sessionId } = await connection.newSession({ cwd: project, mcpServers: [] })
    await connection.prompt({ sessionId, prompt: [{ type: "text", text: "Remember the marker ORBIT-7." }] })
    const peer: AcpSidePeer = {
      sessionId,
      extMethod: async (method, params) => z.json().parse(await connection.extMethod(method, params)),
      prompt: (params) => connection.prompt(params),
      listen: () => () => {},
    }
    const ask = (question: string, earlier: { question: string; answer: string }[] = []) =>
      side.ask(peer, { side: "side", question, earlier, stream: () => {}, signal: new AbortController().signal })

    let mainEnded = false
    const main = connection.prompt({ sessionId, prompt: [{ type: "text", text: "SLOW work" }] }).then((result) => { mainEnded = true; return result })
    const deadline = Date.now() + 30_000
    while (!release && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20))
    assert.ok(release, "the main turn reached the model")
    const first = "My side codename is KESTREL. What marker did I ask you to remember?"
    const answer = await ask(first)
    assert.match(answer, /ORBIT-7/, "the side answer reads the conversation")
    assert.equal(mainEnded, false, "the side question was answered while the main turn ran")
    const follow = await ask("What side codename did I give you?", [{ question: first, answer }])
    assert.match(follow, /KESTREL/, "a follow-up carries the exchange before it")
    release?.()
    assert.equal((await main).stopReason, "end_turn")

    const before = seen.length
    await connection.prompt({ sessionId, prompt: [{ type: "text", text: "CHECK history" }] })
    const next = seen.slice(before).join("\n")
    assert.ok(next.includes("CHECK history"), "the next turn reached the model")
    assert.equal(next.includes("KESTREL"), false, "no side question or answer joins the conversation's history")
    console.log("Grok side questions: answered mid-turn through _x.ai/btw, a follow-up with its earlier exchange, and none of it in the next turn's history")
  } finally {
    child.kill("SIGTERM")
    models.close()
    rmSync(root, { recursive: true, force: true })
  }
}
