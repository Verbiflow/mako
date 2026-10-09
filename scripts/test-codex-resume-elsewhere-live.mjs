// A Codex thread going on in another folder, as a Thread's move into its
// worktree needs: the real `codex app-server` in a sealed CODEX_HOME, with a
// stand-in model. A thread started in one folder resumes in another under the
// same ID through `thread/resume { threadId, cwd }`, its next turn carries
// the first, and the model is told the new folder.
import assert from "node:assert/strict"
import { execFileSync, spawn } from "node:child_process"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createInterface } from "node:readline"

try {
  execFileSync("codex", ["--version"], { stdio: "ignore" })
} catch {
  console.log("codex resume elsewhere: skipped, codex is not installed")
  process.exit(0)
}

const root = realpathSync(mkdtempSync(join(tmpdir(), "codex-elsewhere-")))
const home = join(root, "codex")
const a = join(root, "a")
const b = join(root, "b")
for (const folder of [home, a, b]) mkdirSync(folder, { recursive: true })
const bodies = []
const server = createServer(async (request, res) => {
  let body = ""
  for await (const chunk of request) body += chunk
  if (request.method !== "POST") { res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: [] })); return }
  bodies.push(body)
  const word = [...body.matchAll(/Remember the word (\w+)/g)].at(-1)?.[1]
  const text = word ? `Noted ${word}.` : "Title"
  res.writeHead(200, { "content-type": "text/event-stream" })
  const send = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
  send("response.created", { response: { id: "resp_1" } })
  send("response.output_item.done", { item: { type: "message", role: "assistant", id: "msg_1", content: [{ type: "output_text", text }] } })
  send("response.completed", { response: { id: "resp_1", usage: { input_tokens: 10, input_tokens_details: { cached_tokens: 0 }, output_tokens: 2, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 12 } } })
  res.end()
})
await new Promise((ok) => server.listen(0, "127.0.0.1", ok))
writeFileSync(join(home, "config.toml"), `model = "stand-in"\nmodel_provider = "standin"\napproval_policy = "never"\nsandbox_mode = "read-only"\n\n[model_providers.standin]\nname = "standin"\nbase_url = "http://127.0.0.1:${server.address().port}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\n`)
const env = { PATH: process.env.PATH, HOME: root, CODEX_HOME: home }

function appServer(cwd) {
  const child = spawn("codex", ["app-server"], { cwd, env, stdio: ["pipe", "pipe", "pipe"] })
  let stderr = ""
  child.stderr.on("data", (d) => { stderr += d })
  let next = 1
  const pending = new Map()
  const waiting = []
  createInterface({ input: child.stdout }).on("line", (line) => {
    const message = JSON.parse(line)
    if (message.id !== undefined && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id)
      pending.delete(message.id)
      if (message.error) reject(new Error(JSON.stringify(message.error)))
      else resolve(message.result)
    } else if (message.method) {
      const at = waiting.findIndex((wait) => wait.method === message.method)
      if (at >= 0) waiting.splice(at, 1)[0].resolve(message.params)
    }
  })
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = next++
    pending.set(id, { resolve, reject })
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n")
  })
  const notified = (method) => new Promise((resolve) => waiting.push({ method, resolve }))
  return { child, request, notified, stderr: () => stderr }
}

async function open(cwd) {
  const server = appServer(cwd)
  await server.request("initialize", { clientInfo: { name: "probe", title: "Probe", version: "0.0.1" } })
  server.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "initialized" }) + "\n")
  return server
}
async function turn(server, threadId, cwd, text) {
  const done = server.notified("turn/completed")
  await server.request("turn/start", { threadId, cwd, input: [{ type: "text", text }] })
  return Promise.race([done, new Promise((_, reject) => setTimeout(() => reject(new Error(`turn timed out; ${server.stderr().slice(-500)}`)), 30_000))])
}

try {
  const first = await open(a)
  const started = await first.request("thread/start", { cwd: a })
  const threadId = started.thread.id
  await turn(first, threadId, a, "Remember the word first.")
  first.child.kill("SIGTERM")
  await new Promise((r) => first.child.once("exit", r))
  const before = bodies.length
  const second = await open(b)
  const resumed = await second.request("thread/resume", { threadId, cwd: b })
  assert.equal(resumed.thread.id, threadId, "the same thread goes on")
  assert.equal(resumed.cwd ?? resumed.thread?.cwd, b)
  await turn(second, threadId, b, "Remember the word second.")
  const sent = bodies.slice(before).join("\n")
  assert.ok(sent.includes("Remember the word first"), "the next turn carries the first folder's turns")
  assert.equal([...sent.matchAll(/<cwd>([^<]+)<\/cwd>/g)].map((match) => match[1]).at(-1), b, "the model is told the new folder")
  second.child.kill("SIGTERM")
  await new Promise((r) => second.child.once("exit", r))
  console.log("codex resume elsewhere: the same thread resumed in the new folder with its turns, told the new folder")
} finally {
  server.close()
  rmSync(root, { recursive: true, force: true, maxRetries: 5 })
}
