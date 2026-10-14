import "./lib/scratch-git.mjs"
// Grok's shell approvals against the real grok binary in a sealed HOME, with
// a scripted model and no account: for each of Grok's four answers to a
// command, the observer confirms the answer Grok applied from Grok's own
// records (the run or the refusal, and its project's permission.toml), and
// confirms nothing it can't tell apart.
import assert from "node:assert/strict"
import { execFileSync, spawn } from "node:child_process"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { ClientSideConnection, ndJsonStream, PROTOCOL_VERSION, type Client, type RequestPermissionRequest } from "@agentclientprotocol/sdk"
import { z } from "zod"
import type { JsonObject } from "@mako/host/contracts/json"
import type { NativeApprovalDecision } from "@mako/host/contracts/approval-response"
import { acpReadable, acpWritable } from "@mako/host/harnesses/acp-stream"
import { approvalAnswerDigest } from "@mako/host/harnesses/approval-evidence"
import { GrokApprovalObserver, grokPermissionFile } from "@mako/host/harnesses/grok/approval-observer"

const installed = (() => {
  try { execFileSync("grok", ["--version"], { stdio: "ignore" }); return true } catch { return false }
})()

const ChatRequest = z.object({ messages: z.array(z.object({ role: z.string(), content: z.json() })).default([]), tools: z.array(z.json()).default([]) })

if (!installed) console.log("Grok approvals: skipped, grok is not installed")
else {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "grok-approvals-")))
  const home = join(root, "home")
  const project = join(root, "project")
  mkdirSync(join(home, ".grok"), { recursive: true })
  mkdirSync(project, { recursive: true })
  execFileSync("git", ["init", "-q", project])
  // A stand-in model that runs whatever command the prompt names, so Grok asks to run it.
  let call = 0
  const models = createServer(async (request, response) => {
    let body = ""
    for await (const chunk of request) body += chunk
    if (request.method === "GET") { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ object: "list", data: [{ id: "double", object: "model" }] })); return }
    const chat = ChatRequest.parse(JSON.parse(body || "{}"))
    const last = chat.messages.at(-1)
    const command = last?.role === "user" ? /RUN<<(.+?)>>/.exec(JSON.stringify(last.content))?.[1] : undefined
    call += 1
    const chunk = (delta: JsonObject, finish: string | null) => `data: ${JSON.stringify({ id: `c${call}`, object: "chat.completion.chunk", created: 0, model: "double", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
    response.writeHead(200, { "content-type": "text/event-stream" })
    if (command && chat.tools.length > 1) {
      response.write(chunk({ role: "assistant", tool_calls: [{ index: 0, id: `call_${call}`, type: "function", function: { name: "run_terminal_command", arguments: JSON.stringify({ command, description: "probe" }) } }] }, null))
      response.write(chunk({}, "tool_calls"))
    } else {
      response.write(chunk({ role: "assistant", content: "Done." }, null))
      response.write(chunk({}, "stop"))
    }
    response.end("data: [DONE]\n\n")
  })
  await new Promise<void>((listening) => models.listen(0, "127.0.0.1", listening))
  try {
    const port = z.object({ port: z.number() }).parse(models.address()).port
    writeFileSync(join(home, ".grok", "config.toml"), `[models]\ndefault = "double"\n\n[model.double]\nmodel = "double"\nbase_url = "http://127.0.0.1:${port}/v1"\nname = "Double"\napi_key = "double-key"\napi_backend = "chat_completions"\ncontext_window = 128000\n`)
    const env = { PATH: process.env.PATH, HOME: home, GROK_HOME: join(home, ".grok"), GROK_TELEMETRY_ENABLED: "0", GROK_DISABLE_AUTOUPDATER: "1" }
    const published: NativeApprovalDecision[] = []
    const observer = new GrokApprovalObserver({ root: join(root, "evidence"), file: await grokPermissionFile(join(home, ".grok"), project), previous: [], publish: (decision) => published.push(decision) })
    let answer = "allow-once"
    const asked: RequestPermissionRequest[] = []
    const client: Client = {
      async requestPermission(request) {
        asked.push(request)
        assert.ok(await observer.identify(request), "a shell approval with Grok's four answers is identified")
        return { outcome: { outcome: "selected", optionId: answer } }
      },
      async sessionUpdate(notification) { observer.observe(notification) },
      async extNotification() {},
      async extMethod() { return { outcome: "trust" } },
    }
    const child = spawn("grok", ["agent", "--no-leader", "stdio"], { cwd: project, env, stdio: ["pipe", "pipe", "ignore"] })
    const connection = new ClientSideConnection(() => client, ndJsonStream(acpWritable(child.stdin), acpReadable(child.stdout)))
    try {
      await connection.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: { _meta: { "x.ai/folderTrust": { interactive: true } } } })
      const { sessionId } = await connection.newSession({ cwd: project, mcpServers: [] })
      for (const [command, option] of [["rm -f always.txt", "always-allow"], ["rm -f once.txt", "allow-once"], ["rm -f refused.txt", "reject-once"], ["rm -f never.txt", "reject-always"]] as const) {
        answer = option
        const before = published.length
        await connection.prompt({ sessionId, prompt: [{ type: "text", text: `RUN<<${command}>>` }] })
        for (let waited = 0; waited < 3_000 && published.length === before; waited += 100) await delay(100)
        assert.equal(published.length, before + 1, `Grok's own record confirms "${option}" for ${command}`)
        assert.equal(published.at(-1)?.answerDigest, approvalAnswerDigest({ kind: "choice", optionId: option }), `the confirmed answer is "${option}"`)
      }
      assert.equal(asked.length, 4)
    } finally {
      child.kill("SIGTERM")
      await observer.dispose()
    }
    console.log("Grok approvals: always-allow, allow-once, reject-once and reject-always each confirmed from Grok's own run, refusal and permission.toml")
  } finally {
    models.close()
    rmSync(root, { recursive: true, force: true })
  }
}
