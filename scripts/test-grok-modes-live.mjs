// Grok's access and Plan modes through Mako's ACP host, against the real
// grok binary and a scripted model in an isolated HOME: no account, no
// usage, no user configuration. Covers what `test-access-modes.ts` assumes:
// a session started in Plan beside a launch tier, the approved plan
// returning to that tier, Plan set and left live, and Ask's edits asking.
import assert from "node:assert/strict"
import { execFileSync, spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { once } from "node:events"
import { createServer } from "node:http"
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { setTimeout as delay } from "node:timers/promises"

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const installed = () => { try { execFileSync("grok", ["--version"], { stdio: "ignore" }); return true } catch { return false } }
if (!process.versions.electron && !installed()) {
  console.log("Grok modes: skipped, grok is not installed")
} else if (!process.versions.electron) {
  const root = mkdtempSync(join(tmpdir(), "grok-mako-e2e-"))
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "grok-mako-e2e", main: fileURLToPath(import.meta.url) }))
  const home = join(root, "home")
  mkdirSync(join(home, ".grok"), { recursive: true })
  const env = { PATH: process.env.PATH, HOME: home, GROK_HOME: join(home, ".grok"), GROK_TELEMETRY_ENABLED: "0", E2E_ROOT: root }
  const child = spawn(join(repo, "node_modules/.bin/electron"), [root], { stdio: "inherit", env })
  const deadline = setTimeout(() => child.kill("SIGTERM"), 120_000)
  const [code] = await once(child, "exit")
  clearTimeout(deadline)
  process.exitCode = code ?? 1
} else {
  const { app } = await import("electron")
  void check().then(() => app.exit(0), (error) => { console.error(error); app.exit(1) })
}

function modelServer(port) {
  let calls = 0
  const server = createServer(async (req, res) => {
    let body = ""
    for await (const chunk of req) body += chunk
    if (req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ object: "list", data: [{ id: "double", object: "model" }] }))
      return
    }
    const request = JSON.parse(body || "{}")
    const names = (request.tools ?? []).map((t) => t.function?.name ?? t.name)
    const messages = request.messages ?? []
    const last = messages.at(-1)
    const lastText = JSON.stringify(last?.content ?? "")
    const userText = JSON.stringify(messages.findLast((m) => m.role === "user")?.content ?? "")
    const cwd = globalThis.e2eCwd
    calls++
    let reply
    if (names.length <= 1) reply = { text: "Probe" }
    else if (last?.role === "user" && userText.includes("PLAN")) reply = { tool: "exit_plan_mode", args: { planContent: "# Plan\n\n1. Write approved.txt\n" } }
    else if (last?.role === "user" && userText.includes("WRITE")) reply = { tool: "write", args: { file_path: join(cwd, "written.txt"), content: "hi\n" } }
    else if (last?.role === "tool" && /exit approved|approved/i.test(lastText) && !/Rejected/.test(lastText)) reply = { tool: "write", args: { file_path: join(cwd, "approved.txt"), content: "hi\n" } }
    else { globalThis.lastToolResult = last?.role === "tool" ? lastText.slice(0, 160) : undefined; reply = { text: "Done." } }
    res.writeHead(200, { "content-type": "text/event-stream" })
    const chunk = (delta, finish = null) => res.write(`data: ${JSON.stringify({ id: `c${calls}`, object: "chat.completion.chunk", created: 0, model: "double", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`)
    if (reply.text) { chunk({ role: "assistant", content: reply.text }); chunk({}, "stop") }
    else { chunk({ role: "assistant", tool_calls: [{ index: 0, id: `call_${calls}`, type: "function", function: { name: reply.tool, arguments: JSON.stringify(reply.args) } }] }); chunk({}, "tool_calls") }
    res.write(`data: ${JSON.stringify({ id: `c${calls}`, object: "chat.completion.chunk", created: 0, model: "double", choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`)
    res.end("data: [DONE]\n\n")
  })
  return new Promise((done) => server.listen(port, "127.0.0.1", () => done(server)))
}

async function check() {
  const { app } = await import("electron")
  const root = process.env.E2E_ROOT
  app.setPath("userData", join(root, "profile"))
  await app.whenReady()
  const server = await modelServer(0)
  const port = server.address().port
  writeFileSync(join(process.env.GROK_HOME, "config.toml"), `[features]\ntelemetry = false\n\n[models]\ndefault = "double"\n\n[model.double]\nmodel = "double"\nbase_url = "http://127.0.0.1:${port}/v1"\nname = "Double"\napi_key = "double-key"\napi_backend = "chat_completions"\ncontext_window = 128000\n`)
  await import(join(repo, "dist-electron/providers/index.js"))
  const { liveStart, livePrompt, liveSetMode, liveClose, acpRespondPermission } = await import(join(repo, "dist-electron/acp.js"))
  const { installHostLog } = await import(join(repo, "dist-electron/host-log.js"))
  installHostLog(join(root, "host.log"))
  const report = []

  async function conversation(options, answer) {
    const id = randomUUID()
    const cwd = mkdtempSync(join(tmpdir(), "grok-mako-e2e-cwd-"))
    globalThis.e2eCwd = cwd
    const events = []
    const asked = []
    const emit = (event) => {
      events.push(event)
      if (event.type === "live-permission") {
        asked.push({ title: event.request.title, kind: event.request.kind, implementsPlan: Boolean(event.request.implementsPlan) })
        const optionId = answer(event.request)
        setTimeout(() => acpRespondPermission(id, event.request.id, { kind: "choice", optionId }), 50)
      }
    }
    const started = await liveStart("grok", cwd, {
      ...options, conversationId: id, emit,
      mcpSnapshot: async () => ({ cwd, generatedAt: Date.now(), servers: [], providers: [] }),
    })
    const session = () => events.findLast((event) => event.type === "live-session")?.session ?? started
    const prompt = async (text) => {
      await livePrompt(id, text, [], undefined, { operationId: randomUUID(), attemptId: randomUUID(), report: () => {} })
      for (let waited = 0; session()?.status !== "ready"; waited += 20) {
        if (waited > 30_000) throw new Error(`timed out on ${text}; status ${session()?.status}`)
        await delay(20)
      }
    }
    return { id, cwd, started, session, prompt, asked, close: () => liveClose(id) }
  }

  // A: started in Plan beside Auto review; approval returns to Auto review, whose edits run unasked.
  const a = await conversation({ modeId: "plan", launchModeId: "access:auto" }, (request) => request.implementsPlan ? request.implementsPlan.approve : "allow-once")
  report.push({ a_started: { currentMode: a.started.currentMode, launchMode: a.started.launchMode, modes: a.started.modes.map((m) => `${m.id}:${m.enforcement}`) } })
  assert.equal(a.started.currentMode, "plan")
  assert.equal(a.started.launchMode, "access:auto")
  await a.prompt("PLAN it")
  report.push({ a_after: { currentMode: a.session().currentMode, asked: a.asked, approvedFile: existsSync(join(a.cwd, "approved.txt")) } })
  assert.equal(a.session().currentMode, "access:auto", "approving the plan reports the launch tier")
  assert.ok(existsSync(join(a.cwd, "approved.txt")))
  assert.deepEqual(a.asked.map((x) => x.implementsPlan), [true], "Auto review ran the edit without asking")
  await liveSetMode(a.id, "plan")
  assert.equal(a.session().currentMode, "plan")
  await a.prompt("WRITE it")
  report.push({ a_replan_write: { currentMode: a.session().currentMode, result: globalThis.lastToolResult, written: existsSync(join(a.cwd, "written.txt")) } })
  assert.ok(!existsSync(join(a.cwd, "written.txt")), "Plan set live refuses the edit")
  await liveSetMode(a.id, "access:auto")
  await delay(200)
  assert.equal(a.session().currentMode, "access:auto")
  await assert.rejects(liveSetMode(a.id, "access:full"), /when its session starts/)
  await a.prompt("WRITE it")
  assert.ok(existsSync(join(a.cwd, "written.txt")), "back in Auto review the edit runs")
  await a.close()

  // B: unchosen session runs under Ask; its edits ask.
  const b = await conversation({}, () => "allow-once")
  report.push({ b_started: { currentMode: b.started.currentMode, launchMode: b.started.launchMode } })
  assert.equal(b.started.currentMode, "access:ask")
  await b.prompt("WRITE it")
  report.push({ b_after: { asked: b.asked.map((x) => x.kind), written: existsSync(join(b.cwd, "written.txt")) } })
  assert.deepEqual(b.asked.map((x) => x.kind), ["edit"])
  await b.close()

  if (process.env.GROK_MODES_REPORT) console.log(JSON.stringify(report, null, 1))
  console.log("Grok modes: Plan beside a launch tier, approval back to it, Plan set and left live, other tiers refused live, Ask's edits asking, verified against grok " + execFileSync("grok", ["--version"]).toString().split(" ")[1])
  server.close()
}
