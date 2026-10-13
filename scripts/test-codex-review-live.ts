import "./lib/scratch-git.mjs"
// Codex's own review as Mako starts it: the real `codex app-server` in a
// sealed CODEX_HOME with a stand-in model, driven by Mako's Codex engine.
// `review/start` runs inline on the thread against the branch's base; the
// stand-in reviewer answers with Codex's review JSON, and Codex's findings
// reach Mako as a review with its findings as data, in place of the reply
// that repeats them.
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { createCodexEngine } from "@mako/host/harnesses/codex-app"
import type { JsonObject } from "@mako/host/contracts/json"
import type { LiveDriverEvent } from "@mako/host/contracts/live-conversations"
import type { LiveSessionState } from "@mako/host/contracts/providers-acp"
import type { ToolDetail } from "@mako/sessions"
import { admitted } from "./fixtures/admitted-start.ts"

try {
  execFileSync("codex", ["--version"], { stdio: "ignore" })
} catch {
  console.log("Codex review: skipped, codex is not installed")
  process.exit(0)
}

const root = realpathSync(mkdtempSync(join(tmpdir(), "mako-codex-review-")))
const home = join(root, "codex")
const project = join(root, "project")
for (const folder of [home, join(project, "src")]) mkdirSync(folder, { recursive: true })
const git = (...args: string[]) => execFileSync("git", ["-c", "user.email=review@example.com", "-c", "user.name=Review", ...args], { cwd: project })
git("init", "-q", "-b", "main")
writeFileSync(join(project, "src/rate.ts"), "export const rate = (window: number[]) =>\n  window.reduce((a, b) => a + b, 0) / Math.max(window.length, 1)\n")
git("add", ".")
git("commit", "-qm", "Add the rate")
git("checkout", "-qb", "rate-change")
writeFileSync(join(project, "src/rate.ts"), "export const rate = (window: number[]) =>\n  window.reduce((a, b) => a + b, 0) / window.length\n")
git("commit", "-qam", "Drop the guard")

const REVIEW = {
  findings: [{
    title: "[P1] Dividing by an empty window",
    body: "`rate([])` now returns `NaN`, and the caller's retry loop never ends.",
    confidence_score: 0.8,
    priority: 1,
    code_location: { absolute_file_path: join(project, "src/rate.ts"), line_range: { start: 2, end: 2 } },
  }],
  overall_correctness: "patch is incorrect",
  overall_explanation: "The change drops the empty-window guard.",
  overall_confidence_score: 0.8,
}

const asked: string[] = []
const server = createServer(async (request, res) => {
  let body = ""
  for await (const chunk of request) body += chunk
  if (request.method !== "POST") {
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: [] }))
    return
  }
  asked.push(body)
  res.writeHead(200, { "content-type": "text/event-stream" })
  const send = (type: string, data: JsonObject) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
  const id = `resp_${randomUUID()}`
  send("response.created", { response: { id } })
  send("response.output_item.done", { item: { type: "message", role: "assistant", id: `msg_${randomUUID()}`, content: [{ type: "output_text", text: JSON.stringify(REVIEW) }] } })
  send("response.completed", { response: { id, usage: { input_tokens: 10, input_tokens_details: { cached_tokens: 0 }, output_tokens: 2, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 12 } } })
  res.end()
})
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
// SAFETY: a server listening on a TCP port reports an AddressInfo.
const { port } = server.address() as AddressInfo
writeFileSync(join(home, "config.toml"), `model = "stand-in"\nmodel_provider = "standin"\napproval_policy = "never"\nsandbox_mode = "read-only"\n\n[model_providers.standin]\nname = "standin"\nbase_url = "http://127.0.0.1:${port}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\n`)
const env = { PATH: process.env.PATH, HOME: root, CODEX_HOME: home }

const codex = createCodexEngine({ dataRoot: root })
const events: LiveDriverEvent[] = []
const id = randomUUID()
const session = (): LiveSessionState | undefined => events.findLast((event) => event.type === "live-session")?.session
const updates = () => events.flatMap((event) => event.type === "live-update" ? [event.update] : event.type === "live-updates" ? event.updates : [])
const until = async (label: string, predicate: () => boolean, ms = 30_000) => {
  const deadline = Date.now() + ms
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}; status ${session()?.status}, asked ${asked.length}`)
    await delay(10)
  }
}

try {
  await codex.start(project, admitted("codex", {
    conversationId: id,
    emit: (event) => events.push(event),
    mcpSnapshot: async () => ({ cwd: project, generatedAt: Date.now(), servers: [], providers: [] }),
  }, { env }))
  await until("the session", () => session()?.status === "ready")

  const accepted: string[] = []
  await codex.review(id, { kind: "branch", base: "main" }, undefined, {
    operationId: randomUUID(),
    attemptId: randomUUID(),
    report: (evidence) => { if (evidence.kind === "accepted") accepted.push(evidence.kind) },
  })
  assert.deepEqual(accepted, ["accepted"], "Codex took the review as a turn")
  await until("the review to end", () => session()?.status === "ready" && updates().some((update) => (update.kind === "tool" || update.kind === "tool-update") && update.details?.some((detail) => detail.type === "review")))

  assert.ok(asked.some((body) => body.includes("main")), "the reviewer was asked about the branch against main")
  const reported = updates().flatMap((update) => update.kind === "tool" || update.kind === "tool-update" ? (update.details ?? []) : [])
    .filter((detail): detail is Extract<ToolDetail, { type: "review" }> => detail.type === "review")
    .at(-1)
  assert.deepEqual(reported, {
    type: "review",
    summary: REVIEW.overall_explanation,
    findings: [{ title: "Dividing by an empty window", body: REVIEW.findings[0]!.body, path: join(project, "src/rate.ts"), line: 2, priority: 1 }],
  }, "Codex's findings reach Mako as the review's")
  const said = updates().flatMap((update) => update.kind === "text" ? [update.text] : []).join("\n")
  assert.doesNotMatch(said, /Dividing by an empty window/, "the reply that repeats the findings stays out of the transcript")
  console.log("Codex review: review/start ran inline on the thread against main, and Codex's findings reached Mako as the review's card in place of its echo")
} finally {
  await codex.close(id).catch(() => undefined)
  server.close()
  rmSync(root, { recursive: true, force: true })
}
