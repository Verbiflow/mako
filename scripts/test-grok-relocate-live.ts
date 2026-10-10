import "./lib/scratch-git.mjs"
// A Grok session going on in another folder, as a Thread's move into its
// worktree needs: the real grok binary in a sealed HOME, with a stand-in
// model. A session made in one folder loads in another under the same ID,
// with its turns, and its next turn carries them.
import assert from "node:assert/strict"
import { execFileSync, spawn } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { createServer, type IncomingMessage } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ClientSideConnection, ndJsonStream, PROTOCOL_VERSION, type Client, type SessionNotification } from "@agentclientprotocol/sdk"
import { z } from "zod"
import { acpReadable, acpWritable } from "@mako/host/harnesses/acp-stream"
import { acpClientCapabilities } from "@mako/host/harnesses/acp-source"
import { createGrokAcpSource } from "@mako/host/harnesses/grok/acp"
import { grokSessionSource, relocateGrokSession } from "@mako/host/harnesses/grok/session-source"
import { emitGrokSession } from "../packages/sessions/src/emit.ts"
import { GrokProvider } from "../packages/sessions/src/providers/grok.ts"
import { assertSeedHolds, seeded, seedThread } from "./lib/seed-readback.ts"

const grokAcpSource = createGrokAcpSource()

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

if (!installed) console.log("Grok relocate: skipped, grok is not installed")
else {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "grok-relocate-")))
  const after: (() => void)[] = []
  try {
    const home = join(root, "home")
    const main = join(root, "main")
    const worktree = join(root, "worktree")
    mkdirSync(join(home, ".grok"), { recursive: true })
    for (const folder of [main, worktree]) {
      mkdirSync(folder, { recursive: true })
      execFileSync("git", ["init", "-q", folder])
    }

    const contexts: string[][] = []
    const systems: string[] = []
    const models = createServer(async (request, res) => {
      if (request.method !== "POST") {
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify({ object: "list", data: [{ id: "double", object: "model" }] }))
        return
      }
      const body = ChatRequest.parse(JSON.parse(await read(request)))
      const said = body.messages.filter((message) => message.role === "user").map((message) => message.content ?? "")
      const word = said.at(-1)?.match(/\b(first|second|third)\b/)?.[1]
      contexts.push(said)
      if (word) systems.push(JSON.stringify(body.messages))
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
    const launch = await grokAcpSource.launch({ appPath: "/app", execPath: process.execPath, cwd: main, env, access: "ask" })
    assert.ok(launch)

    const agent = (cwd: string) => {
      const child = spawn(launch.command, launch.args, { cwd, env, stdio: ["pipe", "pipe", "ignore"] })
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
      return { child, connection, updates }
    }
    const said = (updates: SessionNotification[]) => updates.flatMap(({ update }) =>
      update.sessionUpdate === "user_message_chunk" && update.content.type === "text" ? [update.content.text] : [])

    const source = agent(main)
    await source.connection.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: acpClientCapabilities(grokAcpSource) })
    const { sessionId } = await source.connection.newSession({ cwd: main, mcpServers: [] })
    for (const word of ["first", "second"]) {
      const turn = await source.connection.prompt({ sessionId, prompt: [{ type: "text", text: `Remember the word ${word}.` }] })
      assert.equal(turn.stopReason, "end_turn")
    }
    source.child.kill("SIGTERM")
    await new Promise((exited) => source.child.once("exit", exited))

    const sessions = join(home, ".grok", "sessions")
    const unmoved = agent(worktree)
    await unmoved.connection.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: acpClientCapabilities(grokAcpSource) })
    await assert.rejects(unmoved.connection.loadSession({ sessionId, cwd: worktree, mcpServers: [] }), /Path not found/, "Grok keeps a session under the folder it started in")
    unmoved.child.kill("SIGTERM")
    assert.ok(grokAcpSource.resume.kind === "native" && grokAcpSource.resume.beforeLoad && grokAcpSource.resume.elsewhere)
    await grokAcpSource.resume.beforeLoad({ nativeId: sessionId, cwd: worktree, env })
    assert.ok(existsSync(join(sessions, encodeURIComponent(worktree), sessionId)), "before loading, Mako moves the session's folder under the new folder's name")

    const moved = agent(worktree)
    await moved.connection.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: acpClientCapabilities(grokAcpSource) })
    await moved.connection.loadSession({ sessionId, cwd: worktree, mcpServers: [] })
    const replayed = said(moved.updates).join("\n")
    assert.match(replayed, /first/, "the session loads in the other folder with its turns")
    assert.match(replayed, /second/)
    const before = contexts.length
    const turn = await moved.connection.prompt({ sessionId, prompt: [{ type: "text", text: "Remember the word third." }] })
    assert.equal(turn.stopReason, "end_turn")
    assert.ok(contexts.slice(before).some((context) => /first/.test(context.join("\n")) && /third/.test(context.join("\n"))), "its next turn carries the turns from the first folder")
    assert.ok(!systems.at(-1)!.includes(main), "nothing the model gets after the move names the first folder")

    assert.deepEqual(readdirSync(sessions).filter((name) => existsSync(join(sessions, name, sessionId))), [encodeURIComponent(worktree)], "the session is saved under the new folder alone")
    assert.equal(grokSessionSource(sessionId, worktree, sessions), join(sessions, encodeURIComponent(worktree), sessionId, "updates.jsonl"))
    assert.equal(await relocateGrokSession({ nativeId: sessionId, to: worktree, root: sessions }), join(sessions, encodeURIComponent(worktree), sessionId, "updates.jsonl"), "moving it again where it is changes nothing")
    moved.child.kill("SIGTERM")

    // A session Mako wrote to start a fork on Grok: resumed and answered in, it still begins with what Mako wrote.
    const thread = seedThread(main)
    const emitted = await emitGrokSession(thread, { cwd: main, home })
    const grok = new GrokProvider(home)
    const seed = seeded(thread, await grok.read(emitted.path))
    const summary = join(emitted.path, "..", "summary.json")
    writeFileSync(summary, JSON.stringify({ ...z.looseObject({}).parse(JSON.parse(readFileSync(summary, "utf8"))), current_model_id: "double" }))
    const resumed = agent(main)
    await resumed.connection.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: acpClientCapabilities(grokAcpSource) })
    await resumed.connection.loadSession({ sessionId: emitted.sessionId, cwd: main, mcpServers: [] })
    const answered = await resumed.connection.prompt({ sessionId: emitted.sessionId, prompt: [{ type: "text", text: "Remember the word third." }] })
    assert.equal(answered.stopReason, "end_turn")
    resumed.child.kill("SIGTERM")
    await new Promise((exited) => resumed.child.once("exit", exited))
    assertSeedHolds("grok", thread, await grok.read(emitted.path), seed)
    console.log("Grok relocate: a session saved under one folder refuses to load from another; moved under the new folder's name, the same session loads there with its turns and goes on; a seeded session resumed still begins with its seed")
  } finally {
    for (const done of after.reverse()) done()
    rmSync(root, { recursive: true, force: true })
  }
}
