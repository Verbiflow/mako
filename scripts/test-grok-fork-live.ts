// Grok's native fork against the real grok binary in a sealed HOME, with a
// stand-in model. Each turn's checkpoint is Grok's own count of the turns
// its saved updates hold. A fork after the second of three turns, made while
// the first process still holds the session, loads with the first two turns
// and not the third, and the model's context for the fork's next turn
// matches.
import assert from "node:assert/strict"
import { execFileSync, spawn } from "node:child_process"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { createServer, type IncomingMessage } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ClientSideConnection, ndJsonStream, PROTOCOL_VERSION, type Client, type SessionNotification } from "@agentclientprotocol/sdk"
import { z } from "zod"
import { acpReadable, acpWritable } from "../electron/acp-stream.ts"
import { acpClientCapabilities } from "../electron/providers/acp-source.ts"
import { grokAcpSource } from "../electron/providers/grok/acp.ts"
import { grokCheckpoint, grokFork } from "../electron/providers/grok/fork.ts"

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
  messages: z.array(z.looseObject({ role: z.string(), content: MessageText.nullish() })),
})

const read = async (request: IncomingMessage) => {
  let body = ""
  for await (const chunk of request) body += chunk
  return body
}

if (!installed) console.log("Grok fork: skipped, grok is not installed")
else {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "grok-fork-")))
  const after: (() => void)[] = []
  try {
    const home = join(root, "home")
    const project = join(root, "project")
    mkdirSync(join(home, ".grok"), { recursive: true })
    mkdirSync(project, { recursive: true })
    execFileSync("git", ["init", "-q", project])

    /** The user messages of each request the model got, in order. */
    const contexts: string[][] = []
    const models = createServer(async (request, res) => {
      if (request.method !== "POST") {
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify({ object: "list", data: [{ id: "double", object: "model" }] }))
        return
      }
      const body = ChatRequest.parse(JSON.parse(await read(request)))
      const said = body.messages.filter((message) => message.role === "user").map((message) => message.content ?? "")
      const word = said.at(-1)?.match(/\b(first|second|third|fourth)\b/)?.[1]
      contexts.push(said)
      const answer = word ? `Noted ${word}.` : "Title"
      const usage = { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 }
      if (body.stream) {
        res.writeHead(200, { "content-type": "text/event-stream" })
        const chunk = (delta: { role?: "assistant"; content?: string }, finish: string | null, last = false) =>
          res.write(`data: ${JSON.stringify({ id: "double", object: "chat.completion.chunk", created: 0, model: "double", choices: [{ index: 0, delta, finish_reason: finish }], usage: last ? usage : undefined })}\n\n`)
        chunk({ role: "assistant", content: answer }, null)
        chunk({}, "stop", true)
        res.end("data: [DONE]\n\n")
        return
      }
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ id: "double", object: "chat.completion", created: 0, model: "double", usage,
        choices: [{ index: 0, message: { role: "assistant", content: answer }, finish_reason: "stop" }] }))
    })
    await new Promise<void>((listening) => models.listen(0, "127.0.0.1", listening))
    after.push(() => models.close())
    const port = z.object({ port: z.number() }).parse(models.address()).port
    writeFileSync(join(home, ".grok", "config.toml"), `[models]\ndefault = "double"\n\n[model.double]\nmodel = "double"\nbase_url = "http://127.0.0.1:${port}/v1"\nname = "Double"\napi_key = "double-key"\napi_backend = "chat_completions"\ncontext_window = 128000\n`)
    const env = { PATH: process.env.PATH, HOME: home, GROK_HOME: join(home, ".grok"), GROK_TELEMETRY_ENABLED: "0", GROK_DISABLE_AUTOUPDATER: "1" }
    const launch = await grokAcpSource.launch({ appPath: "/app", execPath: process.execPath, cwd: project, env, access: "ask" })
    assert.ok(launch)

    const agent = () => {
      const child = spawn(launch.command, launch.args, { cwd: project, env, stdio: ["pipe", "pipe", "ignore"] })
      after.push(() => child.kill("SIGTERM"))
      const updates: SessionNotification[] = []
      const client: Client = {
        async requestPermission() {
          return { outcome: { outcome: "cancelled" } }
        },
        async sessionUpdate(notification) {
          updates.push(notification)
        },
      }
      const connection = new ClientSideConnection(() => client, ndJsonStream(acpWritable(child.stdin), acpReadable(child.stdout)))
      return { connection, updates }
    }
    const said = (updates: SessionNotification[]) => updates.flatMap(({ update }) =>
      update.sessionUpdate === "user_message_chunk" && update.content.type === "text" ? [update.content.text] : [])

    const source = agent()
    await source.connection.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: acpClientCapabilities(grokAcpSource) })
    const { sessionId } = await source.connection.newSession({ cwd: project, mcpServers: [] })
    const checkpoints: (string | undefined)[] = []
    for (const word of ["first", "second", "third"]) {
      const turn = await source.connection.prompt({ sessionId, prompt: [{ type: "text", text: `Remember the word ${word}.` }] })
      assert.equal(turn.stopReason, "end_turn")
      checkpoints.push(grokCheckpoint({ nativeId: sessionId, env, cwd: project }))
    }
    assert.deepEqual(checkpoints, ["0", "1", "2"], "each turn's checkpoint is Grok's count of the turns saved when it ended")

    const started = performance.now()
    const forked = await grokFork({
      nativeId: sessionId,
      checkpoint: checkpoints[1]!,
      executable: launch.command,
      args: launch.args,
      env,
      cwd: project,
      clientCapabilities: acpClientCapabilities(grokAcpSource),
      owner: "fork-test",
      signal: new AbortController().signal,
    })
    assert.notEqual(forked, sessionId)
    const took = Math.round(performance.now() - started)

    const copy = agent()
    await copy.connection.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: acpClientCapabilities(grokAcpSource) })
    await copy.connection.loadSession({ sessionId: forked, cwd: project, mcpServers: [] })
    const replayed = said(copy.updates).join("\n")
    assert.match(replayed, /first/)
    assert.match(replayed, /second/)
    assert.doesNotMatch(replayed, /third/, "the fork ends after the second turn")
    const before = contexts.length
    const turn = await copy.connection.prompt({ sessionId: forked, prompt: [{ type: "text", text: "Remember the word fourth." }] })
    assert.equal(turn.stopReason, "end_turn")
    const sent = contexts.slice(before).map((context) => context.join("\n"))
    assert.ok(sent.some((context) => /second/.test(context) && /fourth/.test(context)), "the fork's turn carries the turns it kept")
    assert.ok(sent.every((context) => !/third/.test(context)), "no request from the fork mentions the third turn")
    assert.equal(grokCheckpoint({ nativeId: forked, env, cwd: project }), "2", "the fork's own turns count on from the copy")
    assert.equal(grokCheckpoint({ nativeId: sessionId, env, cwd: project }), "2", "the source is untouched")

    console.log(`Grok fork: ${took} ms with the source held by its own process; checkpoints follow Grok's turn count, and a fork after turn two loads and continues without turn three`)
  } finally {
    for (const done of after.reverse()) done()
    rmSync(root, { recursive: true, force: true })
  }
}
