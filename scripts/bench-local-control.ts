/**
 * What an agent pays for Local Control's page paths, through the surfaces it
 * really uses: the js MCP tool (Claude Code, Codex, Cursor and every MCP
 * harness) and the mako-control CLI (shell-driven harnesses), both against a
 * real headless Chromium.
 *
 * 1. Call shapes: the shapes that failed in the October usage audit, written
 *    fresh, each either succeeding or failing with the fault that names the
 *    next step.
 * 2. Latency: the full tool round trip and the SDK call inside the cell.
 * 3. Recovery from a session Chrome dropped, against the protocol fixture.
 * 4. The abandoned-launch sweep over this machine's real temp folder,
 *    with the longest event-loop stall it caused.
 * 5. A paused preview read.
 *
 * Run: npm run bench:local-control [-- --out results.json]
 */
import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { monitorEventLoopDelay } from "node:perf_hooks"
import { parseArgs } from "node:util"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { z } from "zod"
import { createControlRuntime } from "@mako/control-runtime"
import { BrowserService } from "@mako/control-runtime/browser"
import { createControlMcpServer } from "@mako/control-runtime/mcp"
import { invokeControlSession, readControlSession, serveControlSession } from "@mako/control-runtime/session"
import { ControlPreviews } from "@mako/host/control/previews"
import { sweepAbandonedLaunches } from "../packages/control-runtime/src/launch-folders.js"
import { BrowserCommandSchema, BrowserTargetSchema } from "../packages/control-runtime/src/contracts/browser-control.js"
import { browserFixture } from "./browser-control-fixture.js"

const { values: flags } = parseArgs({ options: { out: { type: "string" }, runs: { type: "string" } } })
const RUNS = Number(flags.runs ?? 25)
const executable =
  process.env.CHROMIUM_EXECUTABLE ??
  (process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : "/usr/bin/chromium")
if (!existsSync(executable)) {
  console.log(`Local Control benchmark skipped: no Chromium at ${executable}; set CHROMIUM_EXECUTABLE`)
  process.exit(0)
}

interface Spread {
  count: number
  p50: number
  p95: number
  max: number
}
const round = (value: number) => Math.round(value * 100) / 100
function spread(samples: number[]): Spread {
  const sorted = [...samples].sort((a, b) => a - b)
  const at = (fraction: number) => sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))]!
  return { count: sorted.length, p50: round(at(0.5)), p95: round(at(0.95)), max: round(sorted.at(-1)!) }
}

const page = `<title>Bench</title><main>
<button onclick="window.clear=(window.clear||0)+1">Clear</button>
<div style="position:relative;width:200px"><button onclick="window.badged=(window.badged||0)+1" style="width:160px;height:40px">Badged</button><span style="position:absolute;left:70px;top:10px;width:20px;height:20px;background:red"></span></div>
<div style="position:relative;width:200px"><button style="width:160px;height:40px">Covered</button><div class="shade" style="position:absolute;inset:0"></div></div>
<button disabled>Locked</button>
<input aria-label="Email" value="ada@example.com">
</main>`

const root = await mkdtemp(join(tmpdir(), "mako-bench-local-control-"))
const chromium = spawn(
  executable,
  ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${join(root, "profile")}`, "--no-first-run", "--no-default-browser-check", "about:blank"],
  { stdio: ["ignore", "ignore", "pipe"] }
)
const endpoint = await new Promise<string>((done, fail) => {
  let stderr = ""
  const timer = setTimeout(() => fail(new Error("Chromium startup timed out")), 15_000)
  chromium.once("exit", () => fail(new Error("Chromium exited before its endpoint")))
  chromium.stderr.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-16_384)
    const match = /DevTools listening on (ws:\/\/\S+)/.exec(stderr)
    if (match) {
      clearTimeout(timer)
      done(match[1]!)
    }
  })
})
const runtime = createControlRuntime({
  artifacts: join(root, "artifacts"),
  browsers: [{ id: "live", name: "Live Chromium", endpoint: async () => endpoint }],
})
const owner = await serveControlSession(runtime)
const descriptor = await readControlSession(owner.file)
const server = createControlMcpServer((operation, signal) => invokeControlSession(descriptor, operation, signal ?? new AbortController().signal))
const client = new Client({ name: "bench-local-control", version: "1" })
const [agentSide, serverSide] = InMemoryTransport.createLinkedPair()
await server.connect(serverSide)
await client.connect(agentSide)
const toolResult = z.object({
  isError: z.boolean().optional(),
  content: z.array(z.looseObject({ type: z.string(), text: z.string().optional() })),
})

interface CellResult {
  error: boolean
  text: string
  ms: number
}
async function js(code: string): Promise<CellResult> {
  const started = performance.now()
  const result = toolResult.parse(await client.callTool({ name: "js", arguments: { code, timeout_ms: 30_000 } }))
  const ms = performance.now() - started
  const text = result.content.filter((block) => block.type === "text").map((block) => block.text ?? "").join("\n")
  return { error: result.isError === true, text, ms }
}
const cli = resolve("packages/control-runtime/dist/control-cli.js")
interface CliResult {
  code: number
  stdout: string
  stderr: string
  ms: number
}
async function command(args: string[], stdin = ""): Promise<CliResult> {
  const started = performance.now()
  const child = spawn(process.execPath, [cli, ...args, "--session-file", owner.file], { stdio: ["pipe", "pipe", "pipe"] })
  let stdout = ""
  let stderr = ""
  child.stdout.on("data", (bytes: Buffer) => (stdout += bytes.toString()))
  child.stderr.on("data", (bytes: Buffer) => (stderr += bytes.toString()))
  child.stdin.end(stdin)
  const code = await new Promise<number>((done) => child.once("close", (exit) => done(exit ?? 1)))
  return { code, stdout, stderr, ms: performance.now() - started }
}

interface CallCheck {
  surface: "js" | "cli"
  name: string
  passed: boolean
  detail: string
}
const checks: CallCheck[] = []
const report = (surface: CallCheck["surface"], name: string, passed: boolean, detail: string) =>
  checks.push({ surface, name, passed, detail: detail.replaceAll(/\s+/g, " ").slice(0, 160) })

const results: Record<string, Spread> = {}
try {
  await js("await control.browsers()")
  const opened = await js(
    `await control.connectBrowser("live"); state.tab = await control.openTab({browser:"live", url:${JSON.stringify(`data:text/html,${encodeURIComponent(page)}`)}}); return state.tab.target`
  )
  if (opened.error) throw new Error(opened.text)
  const target = BrowserTargetSchema.extend({ kind: z.literal("page") }).parse(JSON.parse(opened.text.split("\n").at(-1)!))
  const targetFile = join(root, "target.json")
  await writeFile(targetFile, JSON.stringify(target))

  // 1. Call shapes, through the js tool.
  const succeeds = async (name: string, code: string, accepts = (text: string) => text.length > 0) => {
    const result = await js(code)
    report("js", name, !result.error && accepts(result.text), result.text)
  }
  await succeeds("observe match by role alone", `await state.tab.observe({match:{role:"button"}})`, (text) => text.includes("Clear") && text.includes("Locked"))
  await succeeds("observe match with a capitalised role", `await state.tab.observe({match:{role:"Button",name:"Clear"}})`, (text) => text.includes("Clear"))
  await succeeds("observe match with an AX role", `await state.tab.observe({match:{role:"AXButton"}})`, (text) => text.includes("Badged"))
  await succeeds("expect a role to exist", `await state.tab.expect({role:"button"})`, (text) => text.includes("matched"))
  await succeeds("expect no dialog", `await state.tab.expect({role:"dialog",absent:true})`, (text) => text.includes("matched"))
  await succeeds("expect states as an array", `await state.tab.expect({role:"button",name:"Locked",states:["disabled"]})`, (text) => text.includes("matched"))
  await succeeds("expect states as an object", `await state.tab.expect({role:"button",name:"Locked",states:{disabled:true}})`, (text) => text.includes("matched"))
  await succeeds("click a button whose centre a badge covers", `await state.tab.locator({role:"button",name:"Badged"}).click(); await state.tab.evaluate("window.badged")`, (text) => text.trim().endsWith("1"))
  const covered = await js(`await state.tab.locator({role:"button",name:"Covered"}).click()`)
  report("js", "click a covered button: refused, naming the cover", covered.error && covered.text.includes("target-covered") && covered.text.includes("<div.shade>"), covered.text)
  const claimed = await js(`const again = await control.claimTab({browser:"live", tab:${JSON.stringify(target.tab)}}); return again.target.lease === state.tab.target.lease`)
  report("js", "claim a live tab already held: same lease", !claimed.error && claimed.text.trim().endsWith("true"), claimed.text)

  // The same shapes from a shell.
  const shell = async (name: string, args: string[], stdin = "") => {
    const result = await command(args, stdin)
    report("cli", name, result.code === 0, result.code === 0 ? result.stdout : result.stderr)
  }
  await shell("observe --input match by role alone", ["observe", "--target-file", targetFile, "--input", "-"], JSON.stringify({ match: { role: "button" } }))
  await shell("expect --role dialog absent", ["expect", "--target-file", targetFile, "--role", "dialog", "--input", "-"], JSON.stringify({ absent: true }))
  await shell("expect --role button (exists)", ["expect", "--target-file", targetFile, "--role", "button"])
  await shell("expect --role --name with states array", ["expect", "--target-file", targetFile, "--role", "button", "--name", "Locked", "--input", "-"], JSON.stringify({ states: ["disabled"] }))

  // 2. Latency: the whole tool round trip, and the SDK call inside the cell.
  const latency = async (name: string, call: string, setup = "") => {
    const trip: number[] = []
    const inside: number[] = []
    for (let run = -3; run < RUNS; run++) {
      if (setup) await js(setup)
      const result = await js(`const started = performance.now(); ${call}; return performance.now() - started`)
      if (result.error) throw new Error(`${name}: ${result.text}`)
      if (run < 0) continue
      trip.push(result.ms)
      inside.push(Number(result.text.trim().split("\n").at(-1)))
    }
    results[`${name} (tool round trip)`] = spread(trip)
    results[`${name} (SDK call)`] = spread(inside)
  }
  await latency("observe", `await state.tab.observe()`)
  await latency("click at coordinates (input only)", `await state.tab.click({x:20,y:20,view:state.shot.view})`, `state.shot = await state.tab.screenshot()`)
  await latency("click, centre clear", `await state.tab.locator({role:"button",name:"Clear"}).click()`)
  await latency("click, centre covered by a badge", `await state.tab.locator({role:"button",name:"Badged"}).click()`)
  await latency("expect a role to exist", `await state.tab.expect({role:"button"})`)
  await latency("claim a held tab (liveness probe)", `await control.claimTab({browser:"live", tab:${JSON.stringify(target.tab)}})`)
  const refusals: number[] = []
  for (let run = 0; run < 3; run++) refusals.push((await js(`await state.tab.locator({role:"button",name:"Covered"}).click()`)).ms)
  results["click, covered: time to refusal"] = spread(refusals)
  const cliTrips: number[] = []
  for (let run = -1; run < 10; run++) {
    const result = await command(["expect", "--target-file", targetFile, "--role", "button"])
    if (run >= 0) cliTrips.push(result.ms)
  }
  results["cli expect --role (process round trip)"] = spread(cliTrips)

  // 3. Recovery from a dropped session, against the protocol fixture.
  const fixture = await browserFixture()
  const service = new BrowserService([fixture.definition])
  const run = (input: Parameters<typeof BrowserCommandSchema.parse>[0]) => service.execute("bench", BrowserCommandSchema.parse(input), new AbortController().signal)
  try {
    await run({ action: "connect", browser: "fixture" })
    let held = BrowserTargetSchema.parse(await run({ action: "open", browser: "fixture" }))
    const recovery: number[] = []
    const probe: number[] = []
    for (let index = 0; index < 50; index++) {
      fixture.forgetSession(held.tab, "The exact tab session is no longer owned by this client")
      const started = performance.now()
      held = BrowserTargetSchema.parse(await run({ action: "select", browser: "fixture", tab: held.tab }))
      await run({ action: "observe", target: held })
      recovery.push(performance.now() - started)
      const probed = performance.now()
      await run({ action: "select", browser: "fixture", tab: held.tab })
      probe.push(performance.now() - probed)
    }
    results["recover a dropped session: claim + observe (fixture)"] = spread(recovery)
    results["claim a live held tab (fixture)"] = spread(probe)
  } finally {
    service.close()
    await fixture.close()
  }

  // 4. The abandoned-launch sweep over this machine's temp folder.
  const stalls = monitorEventLoopDelay({ resolution: 1 })
  const sweeps: number[] = []
  stalls.enable()
  for (let index = 0; index < 5; index++) {
    const started = performance.now()
    await sweepAbandonedLaunches()
    sweeps.push(performance.now() - started)
  }
  stalls.disable()
  results["sweep abandoned launches (wall)"] = spread(sweeps)
  results["sweep: longest event-loop stall"] = { count: 1, p50: round(stalls.max / 1e6), p95: round(stalls.max / 1e6), max: round(stalls.max / 1e6) }

  // 5. A paused preview read: no stream, the last frame handed back.
  const previewFixture = await browserFixture()
  const previewBrowser = new BrowserService([previewFixture.definition])
  try {
    const previews = new ControlPreviews(previewBrowser, async (image) => image, () => {})
    previews.observe({ conversationId: "task", kind: "browser", operation: "observe", status: "observed", target: "tab" })
    let turn = true
    previews.browserTarget("task", { browser: "fixture", tab: "tab", generation: "g", lease: "l" }, () => {
      if (!turn) throw new Error("no active turn")
    })
    turn = false
    previews.read("task", true)
    const reads = 100_000
    const started = performance.now()
    for (let index = 0; index < reads; index++) previews.read("task", true)
    const each = ((performance.now() - started) / reads) * 1000
    results["paused preview read (µs)"] = { count: reads, p50: round(each), p95: round(each), max: round(each) }
    previews.close()
  } finally {
    previewBrowser.close()
    await previewFixture.close()
  }
} finally {
  await client.close()
  await server.close()
  await owner.close()
  await runtime.close?.()
  const exited = new Promise((done) => chromium.once("exit", done))
  chromium.kill()
  await exited
  await rm(root, { recursive: true, force: true, maxRetries: 5 })
}

const failed = checks.filter((check) => !check.passed)
console.log(`Call shapes: ${checks.length - failed.length} of ${checks.length} behave as designed`)
for (const check of checks) console.log(`  ${check.passed ? "ok  " : "FAIL"} ${check.surface.padEnd(3)} ${check.name}${check.passed ? "" : ` · ${check.detail}`}`)
console.log("\nTimings in ms (count · p50 · p95 · max)")
for (const [name, value] of Object.entries(results))
  console.log(`  ${name.padEnd(58)} ${String(value.count).padStart(6)} ${String(value.p50).padStart(9)} ${String(value.p95).padStart(9)} ${String(value.max).padStart(9)}`)
if (flags.out) await writeFile(flags.out, `${JSON.stringify({ checks, results }, null, 2)}\n`)
if (failed.length) process.exitCode = 1
