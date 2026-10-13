import "./lib/scratch-git.mjs"
// Claude Code's own review as Mako starts it: the real `claude` CLI the Agent
// SDK drives, in a sealed HOME, against a stand-in model. The driver's review
// command reaches Claude as its `/code-review`, which Claude expands into its
// review instructions; the model reports through `ReportFindings`, and the
// call reaches Mako as a review with its findings as data.
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { query } from "@anthropic-ai/claude-agent-sdk"
import type { LiveDriverEvent } from "@mako/host/contracts/live-conversations"
import type { ToolDetail } from "@mako/sessions"
import { nativeToolNames } from "@mako/sessions/tool-identity"
import { createClaudeSdkDriver } from "@mako/host/harnesses/claude/sdk-driver"
import { admitted } from "./fixtures/admitted-start.ts"
import { scriptedModel } from "./scripted-model.ts"

try {
  execFileSync("claude", ["--version"], { stdio: "ignore" })
} catch {
  console.log("Claude review: skipped, claude is not installed")
  process.exit(0)
}

const FINDING = {
  file: "src/rate.ts",
  line: 2,
  summary: "Dividing by the window's length crashes when the window is empty.",
  short_summary: "Division by an empty window",
  failure_scenario: "rate([]) returns Infinity, and the caller's retry loop never ends.",
  category: "correctness",
}

const root = realpathSync(mkdtempSync(join(tmpdir(), "mako-claude-review-")))
const home = join(root, "home")
const project = join(root, "project")
for (const folder of [home, join(project, "src")]) mkdirSync(folder, { recursive: true })
const git = (...args: string[]) => execFileSync("git", ["-c", "user.email=review@example.com", "-c", "user.name=Review", ...args], { cwd: project })
git("init", "-q")
writeFileSync(join(project, "src/rate.ts"), "export const rate = (window: number[]) =>\n  window.reduce((a, b) => a + b, 0) / Math.max(window.length, 1)\n")
git("add", ".")
git("commit", "-qm", "Add the rate")
writeFileSync(join(project, "src/rate.ts"), "export const rate = (window: number[]) =>\n  window.reduce((a, b) => a + b, 0) / window.length\n")

const heard: string[] = []
const model = await scriptedModel({
  reply: (text) => {
    heard.push(text)
    return text.includes("call_findings")
      ? { text: "One finding: the rate divides by an empty window." }
      : { call: { id: "call_findings", name: "ReportFindings", arguments: { level: "medium", findings: [FINDING] } } }
  },
})
const env = {
  PATH: process.env.PATH, HOME: home, CLAUDE_CONFIG_DIR: join(home, ".claude"),
  ANTHROPIC_BASE_URL: model.url, ANTHROPIC_API_KEY: "stand-in",
  DISABLE_TELEMETRY: "1", DISABLE_AUTOUPDATER: "1", DISABLE_ERROR_REPORTING: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  // As Mako launches Claude: `claudeSdkOptions` sets it for every session.
  CLAUDE_CODE_REPORT_FINDINGS: "1",
}

const events: LiveDriverEvent[] = []
const id = randomUUID()
const driver = createClaudeSdkDriver({
  available: () => true,
  configure: async () => ({
    options: { env, model: "claude-haiku-4-5", pathToClaudeCodeExecutable: "claude" },
    account: { name: "stand-in" },
  }),
  query: async (input) => query(input),
  configDir: () => join(home, ".claude"),
})
const until = async (label: string, predicate: () => boolean) => {
  const deadline = Date.now() + 60_000
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
    await delay(20)
  }
}
const updates = () => events.flatMap((event) => event.type === "live-update" ? [event.update] : event.type === "live-updates" ? event.updates : [])

try {
  const review = driver.review
  assert.equal(review.kind, "native")
  assert.ok(review.kind === "native" && review.start.via === "message")
  const command = review.start.text({ kind: "changes" })
  assert.equal(command, "/code-review uncommitted changes")
  await driver.start(project, admitted("claude", { conversationId: id, emit: (event) => events.push(event) }))
  await until("the session to start", () => events.some((event) => event.type === "live-session" && event.session.status === "ready"))
  const before = events.length
  await driver.prompt(id, command, [], undefined, { operationId: randomUUID(), attemptId: randomUUID(), report: () => {} })
  await until("the turn's end", () => events.slice(before).some((event) => event.type === "live-session" && event.session.status === "ready"))

  assert.ok(heard.length >= 2, "the model was asked twice: to review, then after its report")
  assert.ok(!heard[0]!.includes('"text":"/code-review uncommitted changes"'), "Claude expanded its command rather than passing the words on")
  assert.match(heard[0]!, /uncommitted changes/, "the target reached Claude's review")
  assert.match(heard[0]!, /ReportFindings/, "Claude offered the model its findings tool")
  const reported = updates().flatMap((update) => update.kind === "tool" || update.kind === "tool-update" ? (update.details ?? []) : [])
    .filter((detail): detail is Extract<ToolDetail, { type: "review" }> => detail.type === "review")
    .at(-1)
  assert.deepEqual(reported?.findings, [{
    title: FINDING.short_summary,
    body: `${FINDING.summary}\n\n${FINDING.failure_scenario}`,
    path: FINDING.file,
    line: FINDING.line,
    category: FINDING.category,
  }], "the call reaches Mako as the review's findings")
  assert.ok(nativeToolNames("claude", "review").includes("ReportFindings"), "ReportFindings is Claude's review tool")
  assert.ok(updates().some((update) => update.kind === "tool" && update.name === "ReportFindings"), "the call reaches Mako by its name")
  console.log("Claude review: /code-review expanded by the real CLI, the target in its instructions, and ReportFindings decoded into the review's findings")
} finally {
  await driver.close(id)
  await model.close()
  rmSync(root, { recursive: true, force: true })
}
