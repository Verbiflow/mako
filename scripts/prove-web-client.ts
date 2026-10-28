import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdir, readdir, rm, utimes, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
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
 * - `quit` (or stdin's end): signs the host out, so its device leaves the account, stops it, and removes the root unless `--keep`.
 *
 * No harness runs on anything of the person's: the home is the scratch one, Codex's sign-in an API key the stand-in takes.
 *
 * With `--app`, `api` has an app of its own: a recipe that serves a small page on the Thread's port, started once the
 * host is ready, for a phone to open through the gateway.
 *
 *   npx tsx --tsconfig tsconfig.scripts.json scripts/prove-web-client.ts --root <scratch> --cloud http://127.0.0.1:20021 [--keep] [--app]
 */
const { values } = parseArgs({ options: { root: { type: "string" }, cloud: { type: "string" }, keep: { type: "boolean", default: false }, app: { type: "boolean", default: false } } })
if (!values.root || !values.cloud) throw new Error("--root and --cloud are required")
const root = values.root
const home = join(root, "home")
const dataRoot = join(home, "Library", "Application Support", "mako-web-proof", "profile")
const MINUTE = 60_000

if ((await readdir(root).catch(() => [])).length) throw new Error(`${root} isn't empty: give the proof a folder of its own`)

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
  { heard: /whole suite/i, steps: [{ reasoning: "Run everything once more.", text: "Running the whole suite once more.", call: { id: "call_suite", name: "exec_command", arguments: { cmd: "node test/payments.mjs --repeat 200" } } }, { text: "The whole suite passed." }] },
]
const model = await scriptedModel({
  reply: (heard) => {
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
await mkdir(join(api, ".git"), { recursive: true })
await mkdir(join(api, "test"), { recursive: true })
if (values.app) {
  await mkdir(join(api, ".mako"), { recursive: true })
  await writeFile(join(api, ".mako", "recipe.json"), JSON.stringify({ processes: { web: { command: "node server.mjs", port: "{port}", values: { PORT: "{port}" } } } }, null, 2))
  await writeFile(join(api, "server.mjs"), APP_SERVER)
}
await writeFile(join(api, "test", "payments.mjs"), `const runs = Number(process.argv.at(-1)) || 1\nfor (let run = 1; run <= runs; run++) await new Promise((done) => setTimeout(done, 100))\nconsole.log(\`✓ 412 passed (\${runs} runs)\`)\n`)

// The host, screenless, from this checkout's build, on the scratch home.
const { socket } = runtimeLocation(dataRoot)
// SAFETY: the electron package's main export is the path of its executable.
const electron = createRequire(import.meta.url)("electron") as string
const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, MAKO_DATA_ROOT: dataRoot, MAKO_WEB_SOCKET: socket, MAKO_CLOUD_URL: values.cloud, MAKO_SCREENLESS: "1" }
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

const stop = async () => {
  // Its app is a process of its own: stopped here, or it outlives the host.
  if (values.app) await call("mako:thread-app-stop", [api]).catch(() => undefined)
  await call("mako:cloud-sign-out", []).catch(() => undefined)
  host.kill("SIGTERM")
  await release()
  await model.close()
  if (!values.keep) await rm(root, { recursive: true, force: true })
  process.exit(0)
}
/** What `mako:live-start` and `mako:thread-create-session` answer that a start reads: the Thread, and the new Session. */
const StartedSchema = z.object({ threadId: z.string() }).loose()
const PlacedSchema = z.object({ session: z.string() }).loose()
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
  } else if (line.trim() === "quit") break
}
await stop()
