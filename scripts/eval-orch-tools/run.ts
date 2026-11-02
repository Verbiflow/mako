import "../lib/scratch-git.mjs"
// eval:orch-tools — whether agents route background, parallel and writing
// work through Mako's `agents_*`, and keep the rest in their own turn, on
// each harness. Cases: `cases.ndjson` (T3 Code's schema, for `agents_*`).
//
//   npm run eval:orch-tools -- --dry-run [--out <dir>]
//     every case's first request for Claude and Codex, routing on and off,
//     built and checked at $0 (CI runs this on every change).
//   npm run eval:orch-tools -- --replay claude|codex --model <id> [--case <ids>] [--samples 2] [--routing on|off|both] [--out <dir>] [--baseline <results.jsonl>]
//     the replay against the model's own API (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY` from the environment).
//   npm run eval:orch-tools:live -- <harness...> [--model <id>] [--case <ids>] [--samples 2] [--routing on|off|both] [--out <dir>]
//     each real harness through Mako's driver (the host's build: Cursor's runs from its dist) in a scratch
//     home on the person's sign-in for it, against the `mako` stub. Each turn is on that harness's plan.
//   npm run eval:orch-tools -- --template <kept request.json> claude|codex|codex-lead
//     a replay template from `harness:native-tools --keep`.
//
// Two samples per case, a third when they disagree. Results go to
// `<out>/results.jsonl`, with the budget per harness, model and routing in
// `<out>/summary.md`, each run's time and, where its tokens are priced, cost.
import assert from "node:assert/strict"
import { appendFile, mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { z } from "zod"
import { BaselineResult, budget, grade, loadCases, needsThird, regressions, runsOn, type CaseResult, type OrchCase, type Sample, type ToolArgs } from "./cases.ts"
import { firstRequest, replaySample, REPLAY_HARNESSES, type Described, type ReplayHarness } from "./replay.ts"
import { startStubMako } from "./stub-mako.ts"
import { TEMPLATE_NAMES, writeTemplate } from "./templates.ts"

const args = process.argv.slice(2)
const flag = (name: string) => args.includes(name)
const option = (name: string) => {
  const at = args.indexOf(name)
  return at === -1 ? undefined : args[at + 1]
}
const list = (name: string) => {
  const at = args.indexOf(name)
  if (at === -1) return []
  const values: string[] = []
  for (const value of args.slice(at + 1)) {
    if (value.startsWith("--")) break
    values.push(...value.split(","))
  }
  return values
}

// USD per million tokens, as T3 Code's suite prices them.
const PRICES = new Map([
  ["claude-sonnet-5-5", { input: 2, output: 10 }],
  ["claude-opus-5-5", { input: 4, output: 20 }],
  ["claude-haiku-5-5", { input: 0.1, output: 0.5 }],
])
const DEFAULT_MODEL = { claude: "claude-sonnet-5-5", codex: "gpt-6.1-sol" } satisfies Record<ReplayHarness, string>

const only = new Set(list("--case"))
const cases = loadCases().filter((orchCase) => !only.size || only.has(orchCase.id))
assert.ok(cases.length, `no case named ${[...only].join(", ")}`)
const routingFlag = z.enum(["on", "off", "both"]).parse(option("--routing") ?? "both")
const routings = routingFlag === "both" ? ["on", "off"] as const : [routingFlag]
const samplesWanted = Number(option("--samples") ?? 2)
const out = option("--out")

async function record(result: CaseResult) {
  if (!out) return
  await mkdir(out, { recursive: true })
  await appendFile(join(out, "results.jsonl"), `${JSON.stringify(result)}\n`)
}

/** Two samples, and a third when they disagree. */
async function sampled(run: () => Promise<Sample & { seconds?: number; tokens?: { input: number; output: number } }>, orchCase: OrchCase) {
  const passes: boolean[] = [], failures: string[][] = [], samples: Sample[] = []
  const tokens = { input: 0, output: 0 }
  let seconds = 0
  while (passes.length < samplesWanted || needsThird(passes)) {
    const began = Date.now()
    const { steps, shell, text, ended, ...measured } = await run()
    seconds += measured.seconds ?? Math.round((Date.now() - began) / 1000)
    tokens.input += measured.tokens?.input ?? 0
    tokens.output += measured.tokens?.output ?? 0
    const failed = grade(orchCase, { steps, shell, text, ended })
    passes.push(!failed.length)
    failures.push(failed)
    samples.push({ steps, shell, text: text.slice(0, 2000), ended })
    if (passes.length >= 3) break
  }
  return { passes, failures, seconds, tokens, samples }
}

async function summarize(results: CaseResult[]) {
  const groups = new Map<string, CaseResult[]>()
  for (const result of results) {
    const name = `${result.harness} · ${result.model} · routing ${result.routing}`
    groups.set(name, [...groups.get(name) ?? [], result])
  }
  const lines = ["| run | route | don't spawn | no polling | stay native | time | cost |", "| --- | --- | --- | --- | --- | --- | --- |"]
  for (const [name, group] of groups) {
    const rates = budget(group)
    const cell = (line: string) => {
      const entry = rates.find((each) => each.line === line)!
      return entry.rate === undefined ? "–" : `${Math.round(entry.rate * 100)}% (${entry.passed}/${entry.of})${entry.met ? "" : " ✗"}`
    }
    const usd = group.reduce((sum, result) => sum + (result.usd ?? 0), 0)
    lines.push(`| ${name} | ${cell("route")} | ${cell("don't spawn")} | ${cell("no polling")} | ${cell("stay native")} | ${group.reduce((sum, result) => sum + result.seconds, 0)} s | ${group.some((result) => result.usd !== undefined) ? `$${usd.toFixed(2)}` : "not priced"} |`)
  }
  const failing = results.filter((result) => !result.error && result.passes.filter(Boolean).length * 2 <= result.passes.length)
  const errors = results.filter((result) => result.error)
  const baselineFile = option("--baseline")
  const regressed = baselineFile ? regressions((await readFile(baselineFile, "utf8")).split("\n").filter(Boolean).map((line) => BaselineResult.parse(JSON.parse(line))), results) : []
  const text = [
    ...lines, "",
    `Failing: ${failing.length ? failing.map((result) => `${result.harness}/${result.routing} ${result.id} (${result.failures.flat().slice(0, 2).join("; ")})`).join(" · ") : "none"}`,
    ...errors.length ? [`Errors (left out of every rate): ${errors.map((result) => `${result.harness} ${result.id}: ${result.error}`).join(" · ")}`] : [],
    ...baselineFile ? [`Regressions on baseline-perfect cases: ${regressed.length ? regressed.join(" · ") : "none"}`] : [],
  ].join("\n")
  console.log(text)
  if (out) await writeFile(join(out, "summary.md"), `${text}\n`)
  return regressed.length === 0
}

if (option("--template")) {
  const name = z.enum(TEMPLATE_NAMES).safeParse(args[args.indexOf("--template") + 2])
  if (!name.success) throw new Error(`--template <kept request.json> ${TEMPLATE_NAMES.join("|")}`)
  console.log(`wrote ${writeTemplate(name.data, option("--template")!)}`)
  process.exit(0)
}

const stub = await startStubMako()
try {
  const described: Described = await stub.describe()
  assert.ok(described.tools.some((tool) => tool.name === "agents_start"), "the mako server lists agents_start")
  if (flag("--dry-run")) {
    let bodies = 0, bytes = 0
    for (const harness of REPLAY_HARNESSES) for (const orchCase of cases.filter((each) => runsOn(each, harness))) for (const routing of routings) {
      const body = firstRequest(harness, orchCase, routing, described, DEFAULT_MODEL[harness])
      const text = JSON.stringify(body)
      assert.ok(text.includes("agents_start"), `${harness} ${orchCase.id}: the request names agents_start`)
      assert.ok(text.includes(JSON.stringify(orchCase.prompt).slice(1, -1)), `${harness} ${orchCase.id}: the request carries the prompt`)
      bodies++
      bytes += text.length
      if (out) {
        await mkdir(join(out, harness), { recursive: true })
        await writeFile(join(out, harness, `${orchCase.id}.${routing}.json`), text)
      }
    }
    const byId = new Map(loadCases().map((orchCase) => [orchCase.id, orchCase]))
    const sample = (steps: Sample["steps"], shell: string[] = [], ended = true): Sample => ({ steps, shell, text: "", ended })
    const start = (args: ToolArgs = {}) => ({ tool: "agents_start", args })
    const graded: [string, Sample, boolean][] = [
      ["route-parallel-reviewers", sample([[start(), start(), start()]]), true],
      ["route-parallel-reviewers", sample([[{ tool: "native_spawn", args: {} }, start(), start()]]), false],
      ["route-cross-harness", sample([[start({ harness: "codex" })]]), true],
      ["route-cross-harness", sample([[{ tool: "shell", args: {} }]], ["nohup codex exec 'write the migration' &"]), false],
      ["no-poll-after-start", sample([[start()]]), true],
      ["no-poll-after-start", sample([[start()], [{ tool: "agents_wait", args: {} }]]), false],
      ["no-poll-after-start", sample([[start()]], ["sleep 60"]), false],
      ["native-find-definition", sample([[{ tool: "grep", args: {} }]]), true],
      ["native-find-definition", sample([[start()]]), false],
    ]
    for (const [id, synthetic, passes] of graded) {
      const orchCase = byId.get(id)
      assert.ok(orchCase, `the grading check's case ${id} exists`)
      assert.equal(grade(orchCase, synthetic).length === 0, passes, `${id} grades ${passes ? "pass" : "fail"}: ${grade(orchCase, synthetic).join("; ")}`)
    }
    console.log(`eval:orch-tools dry run: ${cases.length} cases, ${bodies} requests built (${Math.round(bytes / 1024)} KB), ${graded.length} gradings checked, $0`)
  } else if (option("--replay")) {
    const chosen = z.enum(REPLAY_HARNESSES).safeParse(option("--replay"))
    if (!chosen.success) throw new Error(`--replay ${REPLAY_HARNESSES.join("|")}`)
    const harness = chosen.data
    const keys = { anthropic: process.env.ANTHROPIC_API_KEY, openai: process.env.OPENAI_API_KEY }
    if (harness === "claude" ? !keys.anthropic : !keys.openai)
      throw new Error(`The ${harness} replay calls the model's API: set ${harness === "claude" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY"}. --dry-run builds every request without one.`)
    const model = option("--model") ?? DEFAULT_MODEL[harness]
    const results: CaseResult[] = []
    for (const orchCase of cases.filter((each) => runsOn(each, harness))) for (const routing of routings) {
      const result: CaseResult = { id: orchCase.id, area: orchCase.area, kind: orchCase.kind, harness, model, routing, passes: [], failures: [], seconds: 0, tokens: { input: 0, output: 0 } }
      try {
        Object.assign(result, await sampled(() => replaySample(harness, orchCase, routing, described, model, keys), orchCase))
        const price = PRICES.get(model)
        if (price) result.usd = (result.tokens.input * price.input + result.tokens.output * price.output) / 1_000_000
      } catch (error) {
        result.error = error instanceof Error ? error.message : String(error)
      }
      results.push(result)
      await record(result)
    }
    if (!await summarize(results)) process.exitCode = 1
  } else if (args.includes("--live")) {
    const harnesses = list("--live")
    assert.ok(harnesses.length, "--live <harness...>")
    const { liveSample, agentCliStubs } = await import("./live.ts")
    const { readPersonSignIns, seedScratchHome } = await import("../scratch-harness-home.ts")
    const { removeScratch } = await import("../lib/scratch-processes.mjs")
    const root = await realpath(await mkdtemp(join(tmpdir(), "mako-eval-orch-tools-")))
    const signIns = readPersonSignIns()
    const scratch = seedScratchHome(root, {
      ...harnesses.includes("claude") && { claude: signIns.claude, claudeAccount: signIns.claudeAccount },
      ...harnesses.some((harness) => harness === "codex" || harness === "opencode") && { codex: signIns.codex },
      ...harnesses.includes("grok") && { grok: signIns.grok },
      ...harnesses.includes("cursor") && { cursor: signIns.cursor },
      ...harnesses.includes("devin") && { devin: signIns.devin },
    }, { trusted: [join(root, "project")] })
    for (const name of Object.keys(process.env)) if (!(name in scratch.env)) delete process.env[name]
    Object.assign(process.env, scratch.env)
    const project = join(root, "project")
    await mkdir(join(project, ".git"), { recursive: true })
    await mkdir(join(project, "src"), { recursive: true })
    await writeFile(join(project, "README.md"), "# acme-app\n\nWhere the client and server recieve their config.\n")
    await writeFile(join(project, "src", "config.ts"), "export function parseConfig(text: string) {\n  return JSON.parse(text)\n}\n")
    await writeFile(join(project, "src", "utils.ts"), "export const cfg = { retries: 3 }\n")
    // What the cases name: the handlers left to port, the router, the parser and the logger.
    await mkdir(join(project, "src", "handlers"), { recursive: true })
    for (let n = 1; n <= 14; n++) await writeFile(join(project, "src", "handlers", `handler-${n}.ts`), `export function handler${n}(request: { path: string }) {\n  return { status: 200, body: request.path }\n}\n`)
    await writeFile(join(project, "src", "router.ts"), "export type Route = { path: string; handle: (request: { path: string }) => { status: number; body: string } }\nexport const routes: Route[] = []\n")
    await writeFile(join(project, "src", "parser.ts"), "export function parse(text: string) {\n  return text.split(\",\").map((part) => part.trim())\n}\n")
    await writeFile(join(project, "src", "logger.ts"), "export function log(message: string) {\n  console.log(new Date().toISOString(), message)\n}\n")
    await writeFile(join(project, "package.json"), `${JSON.stringify({ name: "acme-app", private: true, scripts: { test: "node --test" } }, null, 2)}\n`)
    const results: CaseResult[] = []
    try {
      const installs = await Promise.all([
        import("@mako/host/harnesses/claude/index").then((module) => module.installClaude),
        import("@mako/host/harnesses/codex/index").then((module) => module.installCodex),
        import("@mako/host/harnesses/cursor/index").then((module) => module.installCursor),
        import("@mako/host/harnesses/opencode/index").then((module) => module.installOpenCode),
        import("@mako/host/harnesses/grok/index").then((module) => module.installGrok),
        import("@mako/host/harnesses/devin/index").then((module) => module.installDevin),
      ])
      const { sealedDrivers } = await import("../fixtures/sealed-drivers.ts")
      const drivers = sealedDrivers(installs)
      for (const harness of harnesses) {
        const driver = drivers.get(harness)
        if (!driver?.available(process.cwd())) throw new Error(`${harness} isn't installed`)
        const env = { ...scratch.env, PATH: `${await agentCliStubs(root, harness)}:${scratch.env.PATH}` }
        const model = option("--model") ?? "default"
        // A native child's words can't be set up from a prompt: those cases run in the replay.
        for (const orchCase of cases.filter((each) => runsOn(each, harness) && each.setup.role !== "native-subagent")) for (const routing of routings) {
          const result: CaseResult = { id: orchCase.id, area: orchCase.area, kind: orchCase.kind, harness, model, routing, passes: [], failures: [], seconds: 0, tokens: { input: 0, output: 0 } }
          try {
            Object.assign(result, await sampled(() => liveSample({ harness, driver, stub, orchCase, routing, env, project, ...option("--model") && { model: option("--model") } }), orchCase))
          } catch (error) {
            result.error = error instanceof Error ? error.message : String(error)
          }
          results.push(result)
          await record(result)
          console.log(`${harness} ${routing} ${orchCase.id}: ${result.error ? `error ${result.error}` : result.passes.map((pass) => pass ? "pass" : "fail").join(" ")} (${result.seconds} s)`)
        }
      }
    } finally {
      scratch.dispose()
      await removeScratch(root)
    }
    if (!await summarize(results)) process.exitCode = 1
  } else {
    throw new Error("--dry-run, --replay <harness>, --live <harness...> or --template <file> <name>")
  }
} finally {
  await stub.close()
}
