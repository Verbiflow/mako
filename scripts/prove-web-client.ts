import "./lib/scratch-git.mjs"
import { execFileSync, spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdir, readdir, rm, utimes, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { connect, createServer, type Socket } from "node:net"
import { join } from "node:path"
import { createInterface } from "node:readline"
import { parseArgs } from "node:util"
import { z } from "zod"
import { invokeRuntime, runtimeInfo } from "@mako/host/transport/connection"
import { hostCommand, runtimeLocation } from "@mako/host/transport/service"
import { holdHostLease } from "@mako/host/base/host-idle"
import { assertOwnHarnessStores } from "./lib/proof-host.ts"
import { scriptedModel, type ScriptedReply } from "./scripted-model.ts"

/**
 * A Mac for the web client to reach: a host of this checkout's build on a scratch home, signed in to `--cloud` with the
 * cloud. Its Codex store holds a few earlier Sessions in three projects, written as Codex writes them; and a real Codex
 * runs live Threads there, sealed: no sign-in of the person's, its model the scripted stand-in (`scripted-model.ts`),
 * so every turn is the same and nothing leaves this Mac. The web app lists them as another device's, opens one through
 * this host's runtime link, answers its approvals, sends to it and stops it.
 *
 * Lines on stdin drive it; each answers with one line on stdout:
 * - `start`: a Codex Session in `api` at "Ask first", whose first turn asks to run the payments tests: the first makes its
 *   Thread, each after is a Session added to it. `STARTED <conversation>`
 * - `begin <access> <first message>`: a Thread of its own in `api` at that access ("full", "ask"), its first turn the
 *   script its words name: "Say hello", "Stream a long answer", "Hold the turn", "Ask me a question", "Fail this turn",
 *   "Check the retry fix" (three steps), "Break the last step" (three, the last failing), "Work through the steps" (three,
 *   the last running 30 seconds), "Tidy the retry backoff" (it changes three files). `STARTED <conversation>`
 * - `access <harness> <mode>`: the person chooses that access for the harness here, as the desk's composer does; it goes
 *   to their account. `ACCESS <the host's choices>`
 * - `choices`: the access choices as this host holds them now, after the account's word. `CHOICES <the host's choices>`
 * - `app-start`, `app-stop`: `api`'s app (with `--app` or `--recipe`) started or stopped, as Run and Stop do. `APP <outcome>`
 * - `session <conversation>`: that Session as this Mac's host holds it: its access mode and its model.
 *   `SESSION {"mode": …, "model": …}`
 * - `heard <words>`: the model named by the newest conversation request the scripted model heard those words in, of
 *   its last 64; null when none did. `HEARD {"model": …}`
 * - `copies [ms]`: waits, up to `ms` (2 minutes), for every Session in the sync window to be readable on another device
 *   with its copy up to date, as `mako:sync-status` counts them. `COPIES {"readable": …, "sessions": …, "ms": …}`
 * - `offline`: the Mac drops off the network, as one whose lid closed is gone to the cloud: its link and every call cut,
 *   none let through, the host left running so it stays signed in. `OFFLINE`
 * - `online`: its network back on the same address; the host finds the cloud again by itself. `ONLINE`
 * - `quit` (or stdin's end): signs the host out, so its device leaves the account, stops it, and removes the root unless `--keep`.
 *
 * No harness runs on anything of the person's: the home is the scratch one, Codex's sign-in an API key the stand-in takes.
 *
 * With `--app`, `api` has an app of its own: a recipe that serves a small page on the Thread's port, started once the
 * host is ready, for a phone to open through the gateway. With `--recipe`, the same app, left stopped until `app-start`.
 *
 *   npx tsx --tsconfig tsconfig.scripts.json scripts/prove-web-client.ts --root <scratch> --cloud http://127.0.0.1:20021 [--keep] [--app | --recipe]
 */
const { values } = parseArgs({ options: { root: { type: "string" }, cloud: { type: "string" }, keep: { type: "boolean", default: false }, app: { type: "boolean", default: false }, recipe: { type: "boolean", default: false } } })
if (!values.root || !values.cloud) throw new Error("--root and --cloud are required")
const root = values.root
const home = join(root, "home")
const dataRoot = join(home, "Library", "Application Support", "mako-web-proof", "profile")
const MINUTE = 60_000

if ((await readdir(root).catch(() => [])).length) throw new Error(`${root} isn't empty: give the proof a folder of its own`)

/** `api`'s retry, which the Changes cases' turns edit. */
const RETRY = `import { sleep } from "../lib/sleep"

/** The longest any one wait may be, so a retry never outlives the gateway's own timeout. */
const MAX_DELAY_MS = 5000

/** Charges again after a transient failure, waiting longer each time. */
export async function retry<T>(charge: () => Promise<T>, attempts = 3, baseDelayMs = 200): Promise<T> {
  let lastError: unknown
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await charge()
    } catch (error) {
      lastError = error
      await sleep(Math.min(MAX_DELAY_MS, baseDelayMs * 2 ** (attempt - 1)))
    }
  }
  throw lastError
}
`

/** What "Tidy the retry backoff" runs in `api`: a new file, a changelog line, and the cap in `retry.ts` set anew. */
const TIDY = [
  "set -e",
  // A new Thread's first turn starts as its folder is first tracked: changes in its first seconds would be the folder's as found.
  "sleep 5",
  "t=r$RANDOM$RANDOM",
  "cat > src/payments/backoff-$t.ts <<'TS'",
  "/** Full jitter: anywhere from nothing up to the exponential ceiling, capped. */",
  "export function backoff(baseDelayMs: number, attempt: number, random: number, capMs = 5_000): number {",
  "  const ceiling = Math.min(capMs, baseDelayMs * 2 ** (attempt - 1))",
  "  return Math.round(random * ceiling)",
  "}",
  "",
  "/** How long the next try waits, said for the log. */",
  "export function describeWait(ms: number): string {",
  "  return ms < 1_000 ? `${ms} ms` : `${(ms / 1_000).toFixed(1)} s`",
  "}",
  "TS",
  "printf '%s\\n' \"- Retries back off with full jitter, capped at 5 s ($t).\" >> CHANGELOG.md",
  "sed -i.bak \"s/^const MAX_DELAY_MS = .*/const MAX_DELAY_MS = $((RANDOM % 9000 + 1000))/\" src/payments/retry.ts && rm src/payments/retry.ts.bak",
].join("\n")

/** The `api` project's app with `--app`: one page, what a development server answers, with a request counter to show it's live. */
const APP_SERVER = `import { createServer } from "node:http"
let served = 0
const page = (count) => \`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Payments</title>
<style>body{margin:0;font:16px/1.45 -apple-system,system-ui,sans-serif;background:#f6f5f2;color:#1d1b18}main{padding:28px 22px}h1{font-size:26px;margin:0 0 4px}p{color:#6b665e;margin:0 0 22px}
.card{background:#fff;border-radius:16px;padding:16px 18px;margin-bottom:12px;box-shadow:0 1px 0 rgba(0,0,0,.04),0 6px 20px -12px rgba(0,0,0,.25)}.row{display:flex;justify-content:space-between}.ok{color:#2f7d4f;font-weight:600}</style></head>
<body><main><h1>Payments</h1><p>Served by the Thread's own app · request \${count}</p>
<div class="card row"><span>retry.test.ts</span><span class="ok">20/20 passed</span></div>
<div class="card row"><span>charge.test.ts</span><span class="ok">20/20 passed</span></div>
<div class="card row"><span>refund.test.ts</span><span class="ok">20/20 passed</span></div></main></body></html>\`
createServer((request, response) => {
  served++
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" })
  response.end(page(served))
}).listen(Number(process.env.PORT), "127.0.0.1")
`

/** One exchange of a Codex session, as its rollout keeps it: a message, its reasoning, a command and its output, an answer. */
type Turn = { ask: string; thought: string; command?: { line: string; output: string }; answer: string }

const PROJECTS = ["api", "billing-service", "mobile-web"] as const
/** Earlier Sessions, read as history: a terminal's Codex left them, and Mako there never opened them. */
const SESSIONS: Array<{ project: (typeof PROJECTS)[number]; ageMinutes: number; turns: Turn[] }> = [
  {
    project: "billing-service",
    ageMinutes: 45,
    turns: [
      {
        ask: "Add an index for invoices by customer and created_at, with a migration.",
        thought: "Check the existing migrations' naming and whether the table is large enough to need CONCURRENTLY.",
        command: { line: "ls migrations | tail -3", output: "0041_refunds.sql\n0042_invoice_status.sql\n0043_customer_email.sql" },
        answer: "Added `0044_invoices_customer_created.sql`, which builds the index `CONCURRENTLY` so the table stays writable:\n\n```sql\ncreate index concurrently invoices_customer_created_idx\n  on invoices (customer_id, created_at desc);\n```",
      },
    ],
  },
  {
    project: "mobile-web",
    ageMinutes: 6 * 60,
    turns: [
      { ask: "Why does the checkout page jump when the keyboard opens on iOS?", thought: "The page uses 100vh; Safari's keyboard changes the visual viewport, not the layout one.", answer: "It sizes the page with `100vh`, which on iOS ignores the keyboard. Using `100dvh` and `interactive-widget=resizes-content` in the viewport tag keeps the button above the keyboard." },
    ],
  },
  {
    project: "api",
    ageMinutes: 26 * 60,
    turns: [{ ask: "Summarise what changed in the auth middleware last week.", thought: "Read the log for middleware/auth.", command: { line: "git log --since=1.week -- src/middleware/auth.ts --oneline", output: "a1b2c3d Refresh tokens rotate once a day\n9f8e7d6 Refuse a token reused after rotation" }, answer: "Two changes: refresh tokens now rotate once a day, and a token used again after it rotated signs the device out." }],
  },
]

/** A Codex rollout of `turns`, its last line written `ageMinutes` ago, in its project's folder. */
async function rollout(project: string, ageMinutes: number, turns: Turn[]): Promise<string> {
  const id = randomUUID()
  const last = Date.now() - ageMinutes * MINUTE
  const first = last - turns.length * 2 * MINUTE
  const day = new Date(first).toISOString().slice(0, 10).split("-")
  const stamp = new Date(first).toISOString().slice(0, 19).replaceAll(":", "-")
  const folder = join(home, ".codex", "sessions", ...day)
  await mkdir(folder, { recursive: true })
  const path = join(folder, `rollout-${stamp}-${id}.jsonl`)
  const cwd = join(home, "projects", project)
  await mkdir(cwd, { recursive: true })
  const at = (n: number) => new Date(first + n * 1_000).toISOString()
  const lines = [
    { timestamp: at(0), type: "session_meta", payload: { id, cwd, timestamp: at(0), cli_version: "0.160.0", originator: "codex_cli_rs" } },
    { timestamp: at(0), type: "turn_context", payload: { cwd, model: "gpt-6-astra" } },
    ...turns.flatMap((turn, index) => turnLines(turn, (n) => at(index * 10 + n))),
  ]
  await writeFile(path, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`)
  await utimes(path, new Date(last), new Date(last))
  return path
}

function turnLines(turn: Turn, at: (n: number) => string): unknown[] {
  const call = randomUUID()
  return [
    { timestamp: at(1), type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: turn.ask }] } },
    { timestamp: at(2), type: "response_item", payload: { type: "reasoning", summary: [{ type: "summary_text", text: turn.thought }], content: null, encrypted_content: null } },
    ...(turn.command
      ? [
          { timestamp: at(3), type: "response_item", payload: { type: "function_call", name: "shell", arguments: JSON.stringify({ command: ["bash", "-lc", turn.command.line] }), call_id: call } },
          { timestamp: at(4), type: "response_item", payload: { type: "function_call_output", call_id: call, output: JSON.stringify({ output: turn.command.output, metadata: { exit_code: 0, duration_seconds: 1.2 } }) } },
        ]
      : []),
    { timestamp: at(5), type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: turn.answer }] } },
  ]
}

/** A long answer, streamed a word at a time: headings, lists, code and prose of different heights, so a transcript grows as a real one does. */
const LONG_ANSWER = Array.from({ length: 12 }, (_, index) => [
  `### Part ${index + 1}`,
  `The retry path in part ${index + 1} waits on the real clock, and a slow runner sees fewer attempts than the test expects. Driving it from a fake timer makes every run take the same path, however busy the machine is.`,
  index % 3 === 0 ? "```ts\nconst clock = installClock()\nawait retry(charge, { attempts: 3 })\nclock.runAll()\n```" : `- Attempt ${index + 1} runs after its backoff\n- The clock advances by hand\n- The assertion reads the calls`,
].join("\n\n")).join("\n\n")

/**
 * What the stand-in model says, by the last thing the person said: the live Thread's first turn runs the payments tests
 * (a command "Ask first" asks about), then answers; a message from the phone gets its own answer; "run the whole suite"
 * asks to run a long command, which the phone stops. A request after a step's call goes on to its answer.
 */
const ANSWERS: Array<{ heard: RegExp; steps: ScriptedReply[] }> = [
  {
    heard: /Run the payments tests/,
    steps: [
      { reasoning: "A flaky test shows itself when it's run many times in a row.", text: "I'll run the payments suite twenty times to find the flaky one.", call: { id: "call_payments", name: "exec_command", arguments: { cmd: "node test/payments.mjs --repeat 20" } } },
      {
        reasoning: "Three runs failed on retry.test.ts: the backoff races the real clock.",
        text: "The flaky one is `retry.test.ts`: it waits on the real clock while the retry uses a jittered backoff, so a slow runner sees two attempts instead of three.\n\nDriving the backoff with a fake timer fixes it:\n\n```ts\nconst clock = installClock()\nawait retry(charge, { attempts: 3 })\nclock.runAll()\nexpect(charge).toHaveBeenCalledTimes(3)\n```\n\nWith that, all 412 payments tests pass twenty runs in a row.",
      },
    ],
  },
  { heard: /changelog/i, steps: [{ reasoning: "One line, in the project's own voice.", text: "Here's the line for the changelog, under **Fixed**:\n\n> The payments retry test no longer fails on slow CI runners: its backoff runs on a fake clock." }] },
  {
    heard: /screenshot/i,
    steps: [
      { reasoning: "Copy the build's icon where the person can see it.", text: "Taking it now.", call: { id: "call_shot", name: "exec_command", arguments: { cmd: `mkdir -p shots && cp '${join(process.cwd(), "mako-icons", "light", "desktop-1024.png")}' shots/icon.png` } } },
      { text: `Here's the icon the build ships:\n\n![The desktop icon](${join(home, "projects", "api", "shots", "icon.png")})` },
    ],
  },
  // The phone's behaviour cases each start a Thread of their own (`begin`) with one of these.
  { heard: /Say hello/i, steps: [{ text: "Hello." }] },
  { heard: /Stream a long answer/i, steps: [{ reasoning: "Write it out at a model's pace.", text: LONG_ANSWER, pace: 8 }] },
  { heard: /Hold the turn/i, steps: [{ text: "Holding the turn for a while.", call: { id: "call_hold", name: "exec_command", arguments: { cmd: "sleep 25", yield_time_ms: 30_000 } } }, { text: "Held for twenty-five seconds." }] },
  {
    heard: /Ask me a question/i,
    steps: [
      { text: "One question first.", call: { id: "call_ask", name: "request_user_input", arguments: { questions: [{ id: "colour", header: "Colour", question: "Which colour should the new button be?", options: [{ label: "Blue", description: "The brand's calm colour" }, { label: "Green", description: "Reads as go" }] }] } } },
      { text: "Going with that colour." },
    ],
  },
  // Several steps in a row, for the phone's one-line fold of them: settled, failed at the end, and still running.
  {
    heard: /Check the retry fix/i,
    steps: [
      { reasoning: "Look at what the suite has first.", text: "Looking at the suite first.", call: { id: "call_list", name: "exec_command", arguments: { cmd: "ls test" } } },
      { text: "Running it three times.", call: { id: "call_three", name: "exec_command", arguments: { cmd: "node test/payments.mjs --repeat 3" } } },
      { text: "And once more on its own.", call: { id: "call_once", name: "exec_command", arguments: { cmd: "node test/payments.mjs" } } },
      { text: "The retry fix holds: 412 tests pass three runs in a row, and once more on their own." },
    ],
  },
  {
    heard: /Break the last step/i,
    steps: [
      { text: "Listing the tests.", call: { id: "call_ls", name: "exec_command", arguments: { cmd: "ls test" } } },
      { text: "Running the suite.", call: { id: "call_run", name: "exec_command", arguments: { cmd: "node test/payments.mjs --repeat 2" } } },
      { text: "Checking the lint.", call: { id: "call_lint", name: "exec_command", arguments: { cmd: "node -e \"console.error('lint: 2 problems'); process.exit(1)\"" } } },
      { text: "The lint failed with two problems; the tests pass." },
    ],
  },
  {
    heard: /Work through the steps/i,
    steps: [
      { text: "Listing the tests.", call: { id: "call_walk_ls", name: "exec_command", arguments: { cmd: "ls test" } } },
      { text: "Running the suite.", call: { id: "call_walk_run", name: "exec_command", arguments: { cmd: "node test/payments.mjs --repeat 2" } } },
      { text: "Running the suite for a while.", call: { id: "call_walk_long", name: "exec_command", arguments: { cmd: "node test/payments.mjs --repeat 300", yield_time_ms: 60_000 } } },
      { text: "Worked through every step." },
    ],
  },
  // A turn that changes files, for the phone's Changes cases: a file of its own, a line in the changelog, and an edit in
  // a file every such turn shares. Its names are the shell's own random, so Threads asked this apart change files apart.
  {
    heard: /Tidy the retry backoff/i,
    steps: [
      { reasoning: "A capped, jittered backoff, with the change noted.", text: "Tidying the retry backoff.", call: { id: "call_tidy", name: "exec_command", arguments: { cmd: TIDY } } },
      { text: "The retry backoff is capped and jittered now, and the changelog says so." },
    ],
  },
  { heard: /Fail this turn/i, steps: [{ fail: { status: 400, message: "The scripted model refused this turn." } }] },
  { heard: /whole suite/i, steps: [{ reasoning: "Run everything once more.", text: "Running the whole suite once more.", call: { id: "call_suite", name: "exec_command", arguments: { cmd: "node test/payments.mjs --repeat 200" } } }, { text: "The whole suite passed." }] },
]
/** The scripted model's newest conversation requests, what each carried and the model it named, for `heard`. */
const heardRequests: { heard: string; model: string | undefined }[] = []
const model = await scriptedModel({
  reply: (heard, request) => {
    heardRequests.push({ heard, model: request?.model })
    if (heardRequests.length > 64) heardRequests.shift()
    // A request carries the whole conversation: what the person said last is the script whose words come latest in it,
    // and how far it has gone is how many of its calls the conversation already carries after those words. Nothing is
    // kept between requests, so Threads asked the same thing run their scripts apart.
    const latest = ANSWERS.map((answer) => ({ answer, at: Math.max(...[...heard.matchAll(new RegExp(answer.heard, "gi"))].map((match) => match.index), -1) }))
      .filter(({ at }) => at >= 0)
      .sort((left, right) => right.at - left.at)[0]
    if (!latest) return { text: "Done." }
    const after = heard.slice(latest.at)
    const done = latest.answer.steps.filter((step) => step.call && after.includes(step.call.id)).length
    return latest.answer.steps[done] ?? { text: "Done." }
  },
})

await mkdir(join(home, ".mako"), { recursive: true })
// The on-demand reader, not a login job: nothing here touches launchd.
await writeFile(join(home, ".mako", "syncd-login-optout"), "")
await mkdir(join(dataRoot, "cloud"), { recursive: true, mode: 0o700 })
// No harness sign-in goes to this cloud.
await writeFile(join(dataRoot, "cloud", "sign-ins.json"), JSON.stringify({ version: 2, sharing: false, accessOnly: true, inStep: {} }), { mode: 0o600 })
// Codex, sealed: an API key only the stand-in takes, and the stand-in as its provider.
await mkdir(join(home, ".codex"), { recursive: true })
await writeFile(join(home, ".codex", "config.toml"), `openai_base_url = "${model.url}/v1"\nchatgpt_base_url = "${model.url}/backend-api"\n\n[features]\nplugins = false\n`)
await writeFile(join(home, ".codex", "auth.json"), JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: "mako-web-proof" }), { mode: 0o600 })
for (const session of SESSIONS) await rollout(session.project, session.ageMinutes, session.turns)
// A long one, to read on a phone a page at a time: 4,000 exchanges of five entries each, 20,000 in all.
const LONG_TURNS = 4_000
await rollout("billing-service", 3 * 60, Array.from({ length: LONG_TURNS }, (_, index): Turn => ({
  ask: index === 0 ? "Port the billing exports to the new schema, one table at a time." : `Next table: export ${index}.`,
  thought: `Read export ${index}'s columns against the new schema.`,
  command: { line: `node scripts/port-export.mjs --table export_${index}`, output: `ported export_${index}: 12 columns, 0 dropped` },
  answer: index === LONG_TURNS - 1 ? "All 4,000 exports read the new schema now; nothing was dropped." : `Export ${index} reads the new schema.`,
})))
const api = join(home, "projects", "api")
await mkdir(join(api, "test"), { recursive: true })
await mkdir(join(api, "src", "payments"), { recursive: true })
await writeFile(join(api, "src", "payments", "retry.ts"), RETRY)
await writeFile(join(api, "CHANGELOG.md"), "# Changelog\n\n## Unreleased\n\n")
if (values.app || values.recipe) {
  await mkdir(join(api, ".mako"), { recursive: true })
  await writeFile(join(api, ".mako", "recipe.json"), JSON.stringify({ processes: { web: { command: "node server.mjs", port: "{port}", values: { PORT: "{port}" } } } }, null, 2))
  await writeFile(join(api, "server.mjs"), APP_SERVER)
}
await writeFile(join(api, "test", "payments.mjs"), `const runs = Number(process.argv.at(-1)) || 1\nfor (let run = 1; run <= runs; run++) await new Promise((done) => setTimeout(done, 100))\nconsole.log(\`✓ 412 passed (\${runs} runs)\`)\n`)
// A repository with its first commit, as a real project is: a turn's changes are counted against it.
for (const args of [["init", "-q", "-b", "main"], ["add", "-A"], ["-c", "user.name=Ana", "-c", "user.email=ana@example.invalid", "commit", "-q", "-m", "The payments service"]])
  execFileSync("git", args, { cwd: api, stdio: "ignore", env: { ...process.env, HOME: home } })

// The host, screenless, from this checkout's build, on the scratch home.
const { socket } = runtimeLocation(dataRoot)
// SAFETY: the electron package's main export is the path of its executable.
const electron = createRequire(import.meta.url)("electron") as string
// The Mac's network: the host reaches the cloud only through this relay, so `offline` can cut it. A scratch home has no
// keychain to keep a sign-in through a restart, so a Mac gone off is its network cut rather than its host stopped.
const cloud = new URL(values.cloud)
if (cloud.protocol !== "http:") throw new Error("--cloud is a local gateway, on http")
const carried = new Set<Socket>()
const relay = createServer((inbound) => {
  const outbound = connect(Number(cloud.port) || 80, cloud.hostname)
  for (const [from, to] of [[inbound, outbound], [outbound, inbound]] as const) {
    carried.add(from)
    from.once("close", () => {
      carried.delete(from)
      to.destroy()
    })
    from.on("error", () => to.destroy())
  }
  inbound.pipe(outbound).pipe(inbound)
})
const listen = (port: number) => new Promise<void>((done, fail) => relay.once("error", fail).listen(port, "127.0.0.1", () => (relay.off("error", fail), done())))
await listen(0)
const relayPort = z.object({ port: z.number() }).parse(relay.address()).port
const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, MAKO_DATA_ROOT: dataRoot, MAKO_WEB_SOCKET: socket, MAKO_CLOUD_URL: `http://127.0.0.1:${relayPort}${cloud.pathname.replace(/\/$/, "")}`, MAKO_SCREENLESS: "1" }
for (const name of ["CODEX_HOME", "CLAUDE_CONFIG_DIR", "XDG_DATA_HOME", "OPENCODE_DB", "MAKO_THREAD_URL", "OPENAI_API_KEY", "OPENAI_BASE_URL"]) delete env[name]
const command = hostCommand({ executable: electron, args: [process.cwd()], env })
const host = spawn(command.executable, command.args, { env: command.env, stdio: "ignore" })
process.once("exit", () => host.kill("SIGTERM"))
for (const deadline = Date.now() + 60_000; !(await runtimeInfo(socket).catch(() => null)); ) {
  if (Date.now() > deadline) throw new Error(`the host didn't start within a minute; its log is ${join(dataRoot, "logs", "host.log")}`)
  await new Promise((resolve) => setTimeout(resolve, 250))
}
const release = await holdHostLease(runtimeLocation(dataRoot).directory)
const client = randomUUID()
const call = (channel: string, args: unknown[]) => invokeRuntime(socket, client, channel, args)
await assertOwnHarnessStores(call, dataRoot)

const AccountSchema = z.object({ state: z.object({ status: z.string(), url: z.string().optional(), account: z.object({ entitlements: z.array(z.string()) }).loose().optional() }).loose() }).loose()
let account = AccountSchema.parse(await call("mako:cloud-sign-in", []))
if (account.state.status === "signing-in") console.log(`SIGN IN ${account.state.url ?? ""}`)
for (const deadline = Date.now() + 5 * 60_000; !(account.state.status === "signed-in" && account.state.account?.entitlements.includes("cloud")); ) {
  if (Date.now() > deadline) throw new Error(`the host isn't signed in with the cloud: ${account.state.status}`)
  await new Promise((resolve) => setTimeout(resolve, 500))
  account = AccountSchema.parse(await call("mako:cloud-account", []))
}
if (values.app) await call("mako:thread-app-start", [api])
console.log(`READY ${JSON.stringify({ dataRoot, sessions: SESSIONS.length + 1 })}`)

/** The Mac off the network: what the relay carries dropped, and nothing more let in. */
function cut(): Promise<void> {
  const closed = new Promise<void>((done) => relay.close(() => done()))
  for (const socket of carried) socket.destroy()
  return closed
}

const stop = async () => {
  // Its sign-out reaches the cloud, so its device leaves the account.
  if (!relay.listening) await listen(relayPort)
  // Its app is a process of its own: stopped here, or it outlives the host.
  if (values.app || values.recipe) await call("mako:thread-app-stop", [api]).catch(() => undefined)
  await call("mako:cloud-sign-out", []).catch(() => undefined)
  // The root goes once the host has gone: a host still writing its records into it fails the removal.
  const exited = host.exitCode === null && host.signalCode === null ? new Promise((resolve) => host.once("exit", resolve)) : Promise.resolve()
  host.kill("SIGTERM")
  await exited
  await release()
  await cut()
  await model.close()
  if (!values.keep) await rm(root, { recursive: true, force: true })
  process.exit(0)
}
/** What `session` reads of a live snapshot: the Session's access mode and its model. */
const SnapshotSchema = z.object({ session: z.object({ currentMode: z.string().nullable(), settings: z.object({ model: z.string().optional() }).loose().optional() }).loose() }).loose()
/** What `mako:live-start` and `mako:thread-create-session` answer that a start reads: the Thread, and the new Session. */
const StartedSchema = z.object({ threadId: z.string() }).loose()
const PlacedSchema = z.object({ session: z.string() }).loose()
const SyncSchema = z.object({ state: z.string(), stale: z.number().optional(), sending: z.number().optional(), tiers: z.array(z.object({ sessions: z.number(), readable: z.number() }).loose()).optional() }).loose()
/** Every Session in the sync window readable by another device, its copy up to date: so long as `ms` allows. */
async function copiesUp(ms: number): Promise<{ readable: number; sessions: number; ms: number }> {
  const began = Date.now()
  for (;;) {
    const sync = SyncSchema.parse(await call("mako:sync-status", []))
    const readable = (sync.tiers ?? []).reduce((sum, tier) => sum + tier.readable, 0)
    const sessions = (sync.tiers ?? []).reduce((sum, tier) => sum + tier.sessions, 0)
    if ((sessions && readable >= sessions && !sync.stale && !sync.sending) || Date.now() - began > ms) return { readable, sessions, ms: Date.now() - began }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
}
// `start`: a live Session asking for approval. The first makes its Thread; each after is a Session added to that Thread,
// as Add a Session does, so however many a proof asks for, every list shows one Thread.
let flaky: string | undefined
for await (const line of createInterface({ input: process.stdin })) {
  if (line.trim() === "start") {
    const conversationId = randomUUID()
    const options = { conversationId, modeId: "access:ask", title: "Find the flaky payments test", initialRequest: { id: randomUUID(), text: "Run the payments tests and find out which one is flaky on CI.", attachments: [] } }
    if (flaky) {
      const placed = PlacedSchema.parse(await call("mako:thread-create-session", [randomUUID(), flaky]))
      await call("mako:live-start", ["codex", api, { ...options, session: placed.session }])
    } else flaky = StartedSchema.parse(await call("mako:live-start", ["codex", api, options])).threadId
    console.log(`STARTED ${conversationId}`)
  } else if (line.startsWith("begin ")) {
    // `begin <access> <first message>`: a Thread of its own in `api`, at that access, its first turn the script its words name.
    const [, access, ...words] = line.trim().split(/\s+/)
    const text = words.join(" ")
    const conversationId = randomUUID()
    await call("mako:live-start", ["codex", api, { conversationId, modeId: `access:${access}`, title: text, initialRequest: { id: randomUUID(), text, attachments: [] } }])
    console.log(`STARTED ${conversationId}`)
  } else if (line.startsWith("access ")) {
    const [, harness, mode] = line.trim().split(/\s+/)
    console.log(`ACCESS ${JSON.stringify(await call("mako:access-choose", [harness, mode]))}`)
  } else if (line.trim() === "choices") console.log(`CHOICES ${JSON.stringify(await call("mako:access-choices", []))}`)
  else if (line.trim() === "app-start") console.log(`APP ${JSON.stringify(await call("mako:thread-app-start", [api]))}`)
  else if (line.trim() === "app-stop") console.log(`APP ${JSON.stringify(await call("mako:thread-app-stop", [api]))}`)
  else if (line.startsWith("session ")) {
    const snapshot = SnapshotSchema.parse(await call("mako:live-snapshot", [line.trim().split(/\s+/)[1]]))
    console.log(`SESSION ${JSON.stringify({ mode: snapshot.session.currentMode, model: snapshot.session.settings?.model ?? null })}`)
  } else if (line.startsWith("heard ")) {
    const words = line.trim().slice("heard ".length)
    console.log(`HEARD ${JSON.stringify({ model: heardRequests.findLast((request) => request.heard.includes(words))?.model ?? null })}`)
  }
  else if (line.startsWith("copies")) console.log(`COPIES ${JSON.stringify(await copiesUp(Number(line.trim().split(/\s+/)[1]) || 2 * 60_000))}`)
  else if (line.trim() === "offline") {
    await cut()
    console.log("OFFLINE")
  } else if (line.trim() === "online") {
    await listen(relayPort)
    console.log("ONLINE")
  } else if (line.trim() === "quit") break
}
await stop()
