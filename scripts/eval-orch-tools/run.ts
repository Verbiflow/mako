import "../lib/scratch-git.mjs"
// eval:orch-tools — whether agents route background, parallel and writing
// work through Mako's `agents_*`, move their own Thread to the cloud with
// `thread_move` when asked to continue there, and keep the rest in their own
// turn, on each harness. Cases: `cases.ndjson` (T3 Code's schema, for `agents_*`).
//
//   npm run eval:orch-tools -- --dry-run [--out <dir>]
//     every case's first request for Claude and Codex, routing on and off,
//     built and checked at $0 (CI runs this on every change).
//   npm run eval:orch-tools -- --replay claude|codex --model <id> [--case <ids>] [--samples 2] [--routing on|off|both] [--out <dir>] [--baseline <results.jsonl>]
//     the replay against the model's own API (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY` from the environment).
//   npm run eval:orch-tools:live -- <harness...> [--model <id>] [--case <ids>] [--samples 2] [--routing on|off|both] [--primer on|off|both] [--mako http|sdk|both] [--turn-seconds 180] [--out <dir>]
//     each real harness through Mako's driver (the host's build: Cursor's runs from its dist) in a scratch
//     home on the person's sign-in for it, against the `mako` stub. Each turn is on that harness's plan.
//   npm run eval:orch-tools -- --template <kept request.json> claude|codex|codex-lead
//     a replay template from `harness:native-tools --keep`.
//
// Two samples per case, a third when they disagree. Results go to
// `<out>/results.jsonl`, with the budget per harness, model and routing in
// `<out>/summary.md`, each run's time and, where its tokens are priced, cost.
import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { appendFile, mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { z } from "zod"
import { BaselineResult, budget, grade, loadCases, needsThird, regressions, runsOn, wakeText, type CaseResult, type OrchCase, type Sample, type ToolArgs } from "./cases.ts"
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
const primerFlag = z.enum(["on", "off", "both"]).parse(option("--primer") ?? "on")
const primers = primerFlag === "both" ? ["on", "off"] as const : [primerFlag]
const makoFlag = z.enum(["http", "sdk", "both"]).parse(option("--mako") ?? "sdk")
const makoServers = makoFlag === "both" ? ["sdk", "http"] as const : [makoFlag]
const samplesWanted = Number(option("--samples") ?? 2)
const out = option("--out")

async function record(result: CaseResult) {
  if (!out) return
  await mkdir(out, { recursive: true })
  await appendFile(join(out, "results.jsonl"), `${JSON.stringify(result)}\n`)
}

/**
 * The scratch project as a real repository, as the cases describe it: `main`
 * with the project, and the Thread's branch two commits ahead, unpushed, so an
 * agent that looks finds the work a case talks about.
 */
const execFileAsync = promisify(execFile)

async function gitHistory(project: string): Promise<void> {
  const git = (...args: string[]) => execFileAsync("git", ["-C", project, "-c", "user.name=Eval", "-c", "user.email=eval@example.com", "-c", "commit.gpgsign=false", ...args])
  await git("init", "-q", "-b", "main")
  await git("add", "-A")
  await git("commit", "-q", "-m", "acme-app")
  await git("checkout", "-q", "-b", "mako/thread-work")
  await writeFile(join(project, "src", "login.ts"), "export function redirectAfterLogin(next: string | undefined) {\n  return next?.startsWith(\"/\") ? next : \"/\"\n}\n")
  await git("add", "-A")
  await git("commit", "-q", "-m", "Fix login redirect")
  await writeFile(join(project, "CHANGELOG.md"), "- The login redirect stays on this site.\n")
  await git("add", "-A")
  await git("commit", "-q", "-m", "Changelog for the login redirect")
}

/** Two samples, and a third when they disagree. */
async function sampled(run: () => Promise<Sample & { seconds?: number; tokens?: { input: number; output: number } }>, orchCase: OrchCase) {
  const passes: boolean[] = [], failures: string[][] = [], samples: Sample[] = [], errored: string[] = []
  const tokens = { input: 0, output: 0 }
  let seconds = 0
  while (passes.length + errored.length < samplesWanted || needsThird(passes)) {
    const began = Date.now()
    // A sample that errors (a turn that didn't settle) is left out; the others still count.
    const outcome = await run().catch((error: Error) => error)
    if (outcome instanceof Error) {
      errored.push(outcome.message)
      seconds += Math.round((Date.now() - began) / 1000)
      if (passes.length + errored.length >= 3) break
      continue
    }
    const { steps, shell, ran, text, ended, ...measured } = outcome
    seconds += measured.seconds ?? Math.round((Date.now() - began) / 1000)
    tokens.input += measured.tokens?.input ?? 0
    tokens.output += measured.tokens?.output ?? 0
    const failed = grade(orchCase, { steps, shell, ...ran && { ran }, text, ended })
    passes.push(!failed.length)
    failures.push(failed)
    samples.push({ steps, shell, ...ran && { ran }, text: text.slice(0, 2000), ended })
    if (passes.length + errored.length >= 3) break
  }
  if (!passes.length) throw new Error(errored.at(-1) ?? "no sample ran")
  return { passes, failures, seconds, tokens, samples, ...errored.length && { errored } }
}

async function summarize(results: CaseResult[]) {
  const groups = new Map<string, CaseResult[]>()
  for (const result of results) {
    const name = `${result.harness} · ${result.model} · routing ${result.routing} · primer ${result.primer ?? "on"}${result.mako === "http" ? " · mako http" : ""}`
    groups.set(name, [...groups.get(name) ?? [], result])
  }
  const lines = ["| run | route | front door | don't spawn | no polling | stay native | mako tools | reports | time | cost |", "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |"]
  for (const [name, group] of groups) {
    const rates = budget(group)
    const cell = (line: string) => {
      const entry = rates.find((each) => each.line === line)!
      return entry.rate === undefined ? "–" : `${Math.round(entry.rate * 100)}% (${entry.passed}/${entry.of})${entry.met ? "" : " ✗"}`
    }
    const usd = group.reduce((sum, result) => sum + (result.usd ?? 0), 0)
    lines.push(`| ${name} | ${cell("route")} | ${cell("front door")} | ${cell("don't spawn")} | ${cell("no polling")} | ${cell("stay native")} | ${cell("mako tools")} | ${cell("reports")} | ${group.reduce((sum, result) => sum + result.seconds, 0)} s | ${group.some((result) => result.usd !== undefined) ? `$${usd.toFixed(2)}` : "not priced"} |`)
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
  assert.ok(described.tools.some((tool) => tool.name === "thread_move"), "the mako server lists thread_move")
  assert.match(described.instructions, /^thread_move: /m, "the mako server says what thread_move is for")
  if (flag("--dry-run")) {
    let bodies = 0, bytes = 0
    for (const harness of REPLAY_HARNESSES) for (const orchCase of cases.filter((each) => runsOn(each, harness))) for (const routing of routings) {
      const body = firstRequest(harness, orchCase, routing, described, DEFAULT_MODEL[harness])
      const text = JSON.stringify(body)
      assert.ok(text.includes("agents_start"), `${harness} ${orchCase.id}: the request names agents_start`)
      assert.ok(text.includes("thread_move"), `${harness} ${orchCase.id}: the request names thread_move`)
      assert.ok(text.includes(JSON.stringify(orchCase.prompt).slice(1, -1)), `${harness} ${orchCase.id}: the request carries the prompt`)
      if (orchCase.setup.asks?.length)
        assert.ok(text.includes("agents_answer") && text.includes(JSON.stringify(wakeText(orchCase)).slice(1, -1)), `${harness} ${orchCase.id}: the request carries its Fins' wake`)
      else if (orchCase.setup.finished?.length)
        assert.ok(text.includes(JSON.stringify(wakeText(orchCase)).slice(1, -1)), `${harness} ${orchCase.id}: the request carries its Fins' wake`)
      else if (orchCase.setup.role === "fin")
        assert.ok(text.includes("agents_list with scope crew"), `${harness} ${orchCase.id}: the request carries the Fin's brief`)
      else if (orchCase.setup.children?.length) {
        assert.ok(text.includes("agents_send"), `${harness} ${orchCase.id}: the request names agents_send`)
        assert.ok(text.includes("You're this Thread's Apex") && orchCase.setup.children.every((child) => text.includes(`fin:${child.name}`)), `${harness} ${orchCase.id}: the request carries the front-door note`)
      }
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
    const send = (to: string, forward = true) => ({ tool: "agents_send", args: { to, forward, clientKey: "k" } })
    const sendAs = (to: string, deliver: "queue" | "steer" | "interrupt") => ({ tool: "agents_send", args: { to, forward: true, deliver, clientKey: "k" } })
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
      ["fd-continue-child", sample([[send("child:android")]]), true],
      ["fd-continue-child", sample([[send("android"), start()]]), false],
      ["fd-continue-child", sample([[send("ios")]]), false],
      ["fd-new-child-when-nothing-fits", sample([[start()]]), true],
      ["fd-new-child-when-nothing-fits", sample([[send("android")]]), false],
      ["fd-stale-fork", sample([[send("cloud-envs")]]), true],
      ["fd-stale-fork", sample([[send("thread-env-old")]]), false],
      ["fd-finished-child-follow-up", sample([[send("ios")]]), true],
      ["fd-finished-child-follow-up", sample([[start()]]), false],
      ["fd-finished-wake-carries-refs", { ...sample([]), text: "It landed: https://git.example.com/acme/app/pull/292, and the report is reports/alarm-loop.md." }, true],
      ["fd-finished-wake-carries-refs", { ...sample([[{ tool: "agents_read", args: { child: "alarm-fix" } }]]), text: "It landed: https://git.example.com/acme/app/pull/292, and the report is reports/alarm-loop.md." }, false],
      ["fin-reads-crew-before-shared-files", sample([[{ tool: "agents_list", args: { scope: "crew" } }], [{ tool: "edit", args: {} }]]), true],
      ["fin-reads-crew-before-shared-files", sample([[{ tool: "edit", args: {} }]]), false],
      ["done-asks-merge", sample([[{ tool: "pull_request_status", args: {} }], [{ tool: "agents_report", args: { status: "done", summary: "PR #371 is green.", question: "Merge #371?", options: [{ label: "Merge" }, { label: "Leave open" }], decides: "person", clientKey: "k" } }]]), true],
      ["done-asks-merge", sample([[{ tool: "pull_request_status", args: {} }], [{ tool: "agents_report", args: { status: "needs-input", summary: "PR #371 is green.", question: "Merge #371?", clientKey: "k" } }]]), false],
      ["done-asks-merge", sample([[{ tool: "agents_report", args: { status: "done", summary: "PR #371 is green; merge it when you like.", clientKey: "k" } }]]), false],
      ["fin-solo-no-crew", sample([[{ tool: "edit", args: {} }]]), true],
      ["fin-solo-no-crew", sample([[{ tool: "agents_list", args: { scope: "crew" } }]]), false],
      ["apex-reads-digest-not-message", { ...sample([[{ tool: "agents_list", args: { scope: "apexes" } }]]), text: "Not quite: the migration is in PR #12, waiting on review." }, true],
      ["apex-reads-digest-not-message", { ...sample([[{ tool: "agents_list", args: { scope: "apexes" } }], [{ tool: "agents_send", args: { to: "apex:billing", text: "Done yet?", clientKey: "k" } }]]), text: "PR #12." }, false],
      ["apex-messages-owner-of-shared-file", sample([[{ tool: "agents_list", args: { scope: "apexes" } }], [{ tool: "agents_send", args: { to: "apex:billing", text: "May I change rates.ts?", clientKey: "k" } }]]), true],
      ["apex-messages-owner-of-shared-file", sample([[{ tool: "agents_list", args: { scope: "apexes" } }], [{ tool: "edit", args: {} }]]), false],
      ["apex-messages-owner-of-shared-file", sample([[{ tool: "agents_list", args: { scope: "apexes" } }], [{ tool: "agents_send", args: { to: "apex:billing", clientKey: "a" } }, { tool: "agents_send", args: { to: "apex:billing", clientKey: "b" } }]]), false],
      ["fd-direct-not-resent", sample([[send("android")]]), false],
      ["fd-after-direct-by-content", sample([[send("ios")]]), true],
      ["fd-after-direct-by-content", sample([[send("android")]]), false],
      ["deliver-correction-steers", sample([[sendAs("payments", "steer")]]), true],
      ["deliver-correction-steers", sample([[send("payments")]]), false],
      ["deliver-correction-steers", sample([[sendAs("payments", "queue")]]), false],
      ["deliver-harmful-command-interrupts", sample([[sendAs("payments", "interrupt")]]), true],
      ["deliver-harmful-command-interrupts", sample([[sendAs("payments", "steer")]]), false],
      ["deliver-harmful-command-interrupts", sample([[{ tool: "agents_stop", args: { child: "payments" } }, sendAs("payments", "interrupt")]]), false],
      ["deliver-more-scope-queues", sample([[send("widget")]]), true],
      ["deliver-more-scope-queues", sample([[sendAs("widget", "queue")]]), true],
      ["deliver-more-scope-queues", sample([[sendAs("widget", "steer")]]), false],
      ["deliver-finished-no-interrupt", sample([[sendAs("docs", "interrupt")]]), false],
      ["deliver-already-steered-answers", { ...sample([]), text: "Yes: it hears it at its next step, once the migration command returns." }, true],
      ["deliver-already-steered-answers", sample([[sendAs("payments", "steer")]]), false],
      ["move-continue-in-cloud", sample([[{ tool: "thread_move", args: { to: "cloud", clientKey: "k" } }]]), true],
      ["move-continue-in-cloud", sample([[start({ place: "cloud" })]]), false],
      ["move-continue-in-cloud", sample([[{ tool: "shell", args: {} }]], ["git push -u origin mako/csv-streaming"]), false],
      ["move-closing-laptop", sample([[{ tool: "thread_move", args: { to: "cloud", clientKey: "k" } }]]), true],
      ["move-closing-laptop", sample([[start()]]), false],
      ["move-not-for-own-branch", sample([[{ tool: "thread_move", args: { to: "cloud", clientKey: "k" } }]]), false],
      ["move-not-for-parallel-review", sample([[start()]]), true],
      ["move-not-for-parallel-review", sample([[{ tool: "native_spawn", args: {} }]]), true],
      ["move-not-for-parallel-review", sample([[{ tool: "thread_move", args: { to: "cloud", clientKey: "k" } }]]), false],
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
    // A run stopped from outside still takes the sign-ins it copied with it.
    const abandon = () => {
      scratch.dispose()
      process.exit(1)
    }
    process.once("SIGTERM", abandon).once("SIGINT", abandon)
    for (const name of Object.keys(process.env)) if (!(name in scratch.env)) delete process.env[name]
    Object.assign(process.env, scratch.env)
    // Devin's launch links the person's config folder, and fails where there is none.
    await mkdir(join(scratch.home, ".config"), { recursive: true })
    const project = join(root, "project")
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
    await writeFile(join(project, "package.json"), `${JSON.stringify({ name: "acme-app", private: true, scripts: { test: "node --test", dev: "vite" } }, null, 2)}\n`)
    await gitHistory(project)
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
        const servers = harness === "claude" ? makoServers : ["sdk" as const]
        for (const orchCase of cases.filter((each) => runsOn(each, harness) && each.setup.role !== "native-subagent")) for (const routing of routings) for (const primer of primers) for (const mako of servers) {
          const result: CaseResult = { id: orchCase.id, area: orchCase.area, kind: orchCase.kind, harness, model, routing, primer, ...mako === "http" && { mako }, passes: [], failures: [], seconds: 0, tokens: { input: 0, output: 0 } }
          const began = Date.now()
          try {
            Object.assign(result, await sampled(() => liveSample({ harness, driver, stub, orchCase, routing, primer: primer === "on", ...mako === "http" && { inProcessMako: false }, env, project, ...option("--model") && { model: option("--model") }, ...option("--turn-seconds") && { turnSeconds: Number(option("--turn-seconds")) } }), orchCase))
          } catch (error) {
            result.error = error instanceof Error ? error.message : String(error)
            result.seconds = Math.round((Date.now() - began) / 1000)
          }
          results.push(result)
          await record(result)
          console.log(`${harness} ${routing} primer ${primer}${mako === "http" ? " mako http" : ""} ${orchCase.id}: ${result.error ? `error ${result.error}` : result.passes.map((pass) => pass ? "pass" : "fail").join(" ")}${result.errored ? `, ${result.errored.length} errored` : ""} (${result.seconds} s)`)
        }
      }
    } finally {
      scratch.dispose()
      await removeScratch(root)
    }
    if (!await summarize(results)) process.exitCode = 1
    // A harness's child or socket can outlive its session; the results are written, so the run ends.
    setTimeout(() => process.exit(), 10_000).unref()
  } else {
    throw new Error("--dry-run, --replay <harness>, --live <harness...> or --template <file> <name>")
  }
} finally {
  await stub.close()
}
