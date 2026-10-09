// A Claude session going on in another folder, as a Thread's move into its
// worktree needs: the real `claude` CLI the Agent SDK drives, in a sealed
// HOME, with a stand-in model. A session made in one folder resumes in
// another under the same ID, its next turn carries the first, and Claude
// keeps writing the one session file it started.
import assert from "node:assert/strict"
import { execFile, execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { z } from "zod"

const MessageText = z.string()
  .or(z.array(z.looseObject({ text: z.string().optional() })).transform((parts) => parts.map((part) => part.text ?? "").join("")))
const MessagesRequest = z.looseObject({
  model: z.string(),
  stream: z.boolean().optional(),
  messages: z.array(z.looseObject({ role: z.string(), content: MessageText })),
})

try {
  execFileSync("claude", ["--version"], { stdio: "ignore" })
} catch {
  console.log("claude resume elsewhere: skipped, claude is not installed")
  process.exit(0)
}

const root = realpathSync(mkdtempSync(join(tmpdir(), "mako-claude-elsewhere-")))
const home = join(root, "home")
const main = join(root, "main")
const worktree = join(root, "worktree")
for (const folder of [home, main, worktree]) mkdirSync(folder, { recursive: true })
const contexts = []
const server = createServer(async (request, response) => {
  let body = ""
  for await (const chunk of request) body += chunk
  if (request.method !== "POST" || !request.url.startsWith("/v1/messages")) {
    response.writeHead(404).end("{}")
    return
  }
  if (request.url.includes("count_tokens")) {
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ input_tokens: 10 }))
    return
  }
  const parsed = MessagesRequest.parse(JSON.parse(body))
  const said = parsed.messages.filter((message) => message.role === "user").map((message) => message.content)
  contexts.push(said.join("\n"))
  const word = said.at(-1)?.match(/\b(first|second)\b/)?.[1]
  const text = word ? `Noted ${word}.` : "Title"
  const usage = { input_tokens: 10, output_tokens: 2 }
  const message = { id: "msg_1", type: "message", role: "assistant", model: parsed.model, content: [], stop_reason: null, stop_sequence: null, usage }
  if (!parsed.stream) {
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ...message, content: [{ type: "text", text }], stop_reason: "end_turn" }))
    return
  }
  response.writeHead(200, { "content-type": "text/event-stream" })
  const send = (event, data) => response.write(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`)
  send("message_start", { message })
  send("content_block_start", { index: 0, content_block: { type: "text", text: "" } })
  send("content_block_delta", { index: 0, delta: { type: "text_delta", text } })
  send("content_block_stop", { index: 0 })
  send("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 2 } })
  send("message_stop", {})
  response.end()
})
await new Promise((ready) => server.listen(0, "127.0.0.1", ready))
const env = {
  PATH: process.env.PATH, HOME: home, CLAUDE_CONFIG_DIR: join(home, ".claude"),
  ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`, ANTHROPIC_API_KEY: "stand-in",
  DISABLE_TELEMETRY: "1", DISABLE_AUTOUPDATER: "1", DISABLE_ERROR_REPORTING: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
}
const run = (cwd, args) => new Promise((resolve, reject) => {
  const child = execFile("claude", ["-p", "--output-format", "json", "--model", "claude-haiku-4-5", ...args], { cwd, env, encoding: "utf8", timeout: 60_000 }, (error, stdout, stderr) => {
    if (error) reject(Object.assign(error, { stdout, stderr }))
    else resolve(JSON.parse(stdout))
  })
  child.stdin.end()
})
const files = () => readdirSync(join(home, ".claude", "projects")).flatMap((slug) => readdirSync(join(home, ".claude", "projects", slug)).filter((file) => file.endsWith(".jsonl")).map((file) => `${slug}/${file}`))
try {
  const first = await run(main, ["Remember the word first."])
  assert.equal(first.is_error, false, first.result)
  const saved = files()
  const before = contexts.length
  const second = await run(worktree, ["--resume", first.session_id, "Remember the word second."])
  assert.equal(second.is_error, false, second.result)
  assert.equal(second.session_id, first.session_id, "the same session goes on")
  assert.ok(contexts.slice(before).some((context) => context.includes("first") && context.includes("second")), "the next turn carries the first folder's turns")
  assert.deepEqual(files(), saved, "Claude keeps writing the session file it started")
  console.log("claude resume elsewhere: the same session resumed in the new folder with its turns, in its own file")
} finally {
  server.close()
  rmSync(root, { recursive: true, force: true, maxRetries: 5 })
}
