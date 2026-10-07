import "./lib/scratch-git.mjs"
/**
 * A real agent on each harness runs a check that outlasts one app_check call,
 * in a packaged Mako on an isolated profile, and this watches what it's owed:
 * every call after "still running" gets that same run's result, and no second
 * run starts. On Claude Code and Codex, whose calls Mako lets wait ten
 * minutes, one call waits out a check longer than Codex's own 60-second MCP
 * limit, which holds only if Codex took Mako's tool_timeout_sec.
 *
 *   node scripts/real-check-wait-run.mjs <Mako.app> <harness...> [--out=dir]
 *   node scripts/real-check-wait-run.mjs --source=<built checkout> <harness...> [--out=dir]
 *
 * Each harness gets its own profile and project under `--out`, and its
 * events, tool calls and answer land in `<out>/result.json`.
 */
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { answerText, PackagedApp } from "./lib/packaged-app.mjs"

const flag = (name) => process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3)
const positional = process.argv.slice(2).filter((arg) => !arg.startsWith("--"))
/** A built checkout of Mako, run with its own Electron as a production host would, in place of the packaged app. */
const source = flag("source") && resolve(flag("source"))
assert.ok(positional.length >= (source ? 1 : 2), "Use <Mako.app> <harness...> [--out=dir], or --source=<built checkout> <harness...>")
const app = source ?? resolve(positional[0])
const harnesses = positional.slice(source ? 0 : 1)
const out = resolve(flag("out") ?? join(tmpdir(), "mako-check-wait-proof"))
await mkdir(out, { recursive: true })
if (!source) execFileSync("codesign", ["--verify", "--deep", "--strict", app], { stdio: "pipe" })
const launch = source
  ? { executable: join(source, "node_modules/electron/dist", (await readFile(join(source, "node_modules/electron/path.txt"), "utf8")).trim()), args: [source], env: { MAKO_PROD: "1" } }
  : { executable: join(app, "Contents/MacOS/Mako") }

/** How long Mako lets each harness's app_check call wait: ten minutes where its MCP client allows it, else 25 seconds. */
const CALL_WAIT_MS = { claude: 600_000, codex: 600_000 }
const SHORT_WAIT_MS = 25_000
/** Codex's own limit on an MCP call without tool_timeout_sec. */
const CODEX_DEFAULT_MS = 60_000
const TURN_MS = 12 * 60_000
const PROMPT = "Run this project's quick check with Mako's app_check tool and tell me whether it passed. Don't run the check's command yourself, and don't use any tool other than app_check."

/** A check that outlasts one call: past Codex's default limit where calls wait long, past two 25-second waits elsewhere. */
const checkSeconds = (harness) => (CALL_WAIT_MS[harness] ? 150 : 60)

async function project(root, harness) {
  const dir = join(root, "slowcheck")
  const runs = join(root, "check-runs.log")
  await mkdir(join(dir, ".mako"), { recursive: true })
  await writeFile(join(dir, "slow-check.mjs"), `import { appendFileSync } from "node:fs"
appendFileSync(${JSON.stringify(runs)}, new Date().toISOString() + "\\n")
const seconds = ${checkSeconds(harness)}
for (let at = 0; at < seconds; at += 10) {
  console.log(\`checking, \${at} s in\`)
  await new Promise((done) => setTimeout(done, Math.min(10, seconds - at) * 1000))
}
console.log("slow check ok")
`)
  await writeFile(join(dir, ".mako", "recipe.json"), `${JSON.stringify({ checks: { quick: "node slow-check.mjs" } }, null, 2)}\n`)
  await writeFile(join(dir, "README.md"), "A project whose quick check takes a while.\n")
  const git = (...args) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: "pipe" })
  git("init", "-q", "-b", "main")
  git("add", "-A")
  git("-c", "user.name=Mako fixture", "-c", "user.email=fixture@mako.invalid", "commit", "-q", "-m", "Fixture")
  return { dir, runs }
}

/** An app_check call: by name, or inside a wrapper's input (OpenCode's code mode runs `tools.mako.app_check(...)` in `execute`). */
const isCheckTool = (block) => /app_check|check app/i.test(`${block.name ?? ""} ${block.title ?? ""}`) || /mako\W+app_check/.test(textOf(block.input))
const textOf = (value) => typeof value === "string" ? value : value === undefined ? "" : JSON.stringify(value)

async function runHarness(harness) {
  const root = await realpath(await mkdtemp(join(out, `${harness}-`)))
  const { dir, runs } = await project(root, harness)
  const pkg = new PackagedApp({ ...launch, root, workspace: dir })
  const record = { harness, root, checkSeconds: checkSeconds(harness), callWaitMs: CALL_WAIT_MS[harness] ?? SHORT_WAIT_MS, calls: [], approvals: [], outcome: "running" }
  const started = Date.now()
  try {
    record.launch = await pkg.start()
    const conversationId = randomUUID()
    const requestId = randomUUID()
    await pkg.bridge("liveStart", [harness, dir, { conversationId, title: "Check wait proof", initialRequest: { id: requestId, text: PROMPT, attachments: [] } }])
    const calls = new Map()
    const answered = new Set()
    let snap
    for (const deadline = Date.now() + TURN_MS; Date.now() < deadline;) {
      snap = await pkg.bridge("liveSnapshot", [conversationId]).catch(() => undefined)
      for (const permission of snap?.permissions ?? []) {
        if (answered.has(permission.id)) continue
        answered.add(permission.id)
        const allow = /app_check|check app/i.test(JSON.stringify(permission)) && !/mako[-_](computer|browser)/.test(JSON.stringify(permission))
        const option = allow
          ? permission.options.find((item) => item.kind === "allow_once") ?? permission.options.find((item) => item.kind === "allow_always")
          : permission.options.find((item) => item.kind === "reject_once") ?? permission.options.find((item) => item.kind.startsWith("reject"))
        record.approvals.push({ title: permission.title, option: option?.kind, atMs: Date.now() - started })
        if (option) await pkg.bridge("livePermission", [conversationId, permission.id, { kind: "choice", optionId: option.optionId }]).catch(() => {})
      }
      for (const block of snap?.blocks ?? []) {
        if (block.type !== "tool") continue
        const call = calls.get(block.id) ?? { id: block.id, name: block.name, title: block.title, check: isCheckTool(block), seenMs: Date.now() - started }
        calls.set(block.id, call)
        if (call.status !== block.status) {
          call.status = block.status
          if (!["pending", "running", "in_progress"].includes(block.status)) call.endedMs ??= Date.now() - started
        }
        call.input = textOf(block.input).slice(0, 400)
        call.output = textOf(block.output ?? block.result ?? block.content).slice(0, 1200)
      }
      const request = snap?.requests?.find((item) => item.id === requestId)
      if (request && ["completed", "failed", "uncertain", "interrupted"].includes(request.status)) {
        record.turn = request.status
        record.turnError = request.error
        break
      }
      await delay(1000)
    }
    record.turnMs = Date.now() - started
    record.calls = [...calls.values()]
    record.answer = snap ? answerText(snap, requestId).slice(-2000) : undefined
    record.model = snap?.session?.settings?.model
    await writeFile(join(root, "final-snapshot.json"), JSON.stringify(snap, null, 2))
    // A run started after the turn would show up here too.
    await delay(5000)
    record.checkRuns = (await readFile(runs, "utf8").catch(() => "")).split("\n").filter(Boolean)

    // A call its MCP server refused for its arguments never reached a run.
    const checks = record.calls.filter((call) => call.check && !/Input validation error|MCP error -32602/.test(call.output ?? ""))
    record.refusedCalls = record.calls.filter((call) => call.check).length - checks.length
    const verdicts = []
    const expect = (ok, text) => verdicts.push({ ok: Boolean(ok), text })
    expect(record.turn === "completed", `the turn completed (${record.turn ?? "timed out"})`)
    expect(checks.length >= 1, `the agent called app_check (${checks.length} calls)`)
    expect(record.checkRuns.length === 1, `exactly one check run started (${record.checkRuns.length})`)
    expect(/passed/i.test(record.answer ?? ""), "the answer says the check passed")
    if (CALL_WAIT_MS[harness]) {
      const longest = Math.max(0, ...checks.map((call) => (call.endedMs ?? record.turnMs) - call.seenMs))
      expect(checks.length === 1, `one app_check call waited for the whole check (${checks.length} calls)`)
      expect(longest > CODEX_DEFAULT_MS, `that call ran ${Math.round(longest / 1000)} s, past the 60-second default`)
    } else {
      expect(checks.length >= 2, `a call after "still running" got the result (${checks.length} calls)`)
    }
    record.verdicts = verdicts
    record.outcome = verdicts.every((item) => item.ok) ? "passed" : "failed"
  } catch (error) {
    record.outcome = "failed"
    record.error = error instanceof Error ? error.stack : String(error)
    await pkg.screenshot(join(root, "failure.png")).catch(() => {})
  } finally {
    await pkg.stop({ graceful: true })
  }
  console.log(`${harness}: ${record.outcome}${record.verdicts ? `\n  ${record.verdicts.map((item) => `${item.ok ? "ok " : "NO "} ${item.text}`).join("\n  ")}` : ""}${record.error ? `\n  ${record.error}` : ""}`)
  return record
}

const results = []
for (const harness of harnesses) {
  results.push(await runHarness(harness))
  await writeFile(join(out, "result.json"), JSON.stringify({ app, results }, null, 2))
}
console.log(`Result: ${join(out, "result.json")}`)
process.exitCode = results.every((result) => result.outcome === "passed") ? 0 : 1
