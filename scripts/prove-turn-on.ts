import "./lib/scratch-git.mjs"
import { execFileSync, spawn } from "node:child_process"
import { randomBytes, randomUUID } from "node:crypto"
import { mkdir, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { join } from "node:path"
import { parseArgs } from "node:util"
import { z } from "zod"
import { invokeRuntime, runtimeInfo } from "@mako/host/transport/connection"
import type { RuntimeValue } from "@mako/host/contracts/runtime"
import { hostCommand, runtimeLocation } from "@mako/host/transport/service"
import { holdHostLease } from "@mako/host/base/host-idle"
import type { CloudTurnOn, TurnOnStepId } from "@mako/host/contracts/cloud-turn-on"

/**
 * Turning the cloud on, end to end, against a cloud of its own, timed step by step: a host of this checkout's build
 * on a scratch home (harness stores holding `--sessions` Codex sessions over `--days` days, a
 * project whose origin is a public GitHub repository, and a Devin key that isn't one, so an agent's sign-in has
 * something to send), signed in without the cloud. It prints `SIGN IN <url>` for whoever plays the person, then
 * `GRANT` once signed in, and asks the cloud again (Check now) until the grant lands. From then it reads
 * `mako:cloud-turn-on` every 250 ms and says when each step changed, as the line would; once a Thread can run and the
 * history is part way, it restarts the host and times the line's return, then follows it to the end. Nothing of the
 * person's own stores or keychain is read, and no machine is made: the first Thread is the person's, and stays so.
 *
 *   npx tsx --tsconfig tsconfig.scripts.json scripts/prove-turn-on.ts --root <scratch> --cloud http://127.0.0.1:20027 [--sessions 120] [--days 40] [--report <file>] [--keep]
 */
const { values } = parseArgs({
  options: {
    root: { type: "string" },
    cloud: { type: "string" },
    sessions: { type: "string", default: "120" },
    days: { type: "string", default: "40" },
    report: { type: "string" },
    keep: { type: "boolean", default: false },
  },
})
if (!values.root || !values.cloud) throw new Error("--root and --cloud are required")
const root = values.root
const home = join(root, "home")
const dataRoot = join(home, "Library", "Application Support", "mako-turn-on-proof", "profile")
const SESSIONS = Number(values.sessions)
const DAYS = Number(values.days)
const HOUR = 3_600_000

if ((await readdir(root).catch(() => [])).length) throw new Error(`${root} isn't empty: give the proof a folder of its own`)
await mkdir(join(home, ".mako"), { recursive: true })
await writeFile(join(home, ".mako", "syncd-login-optout"), "")
// A key Devin's sign-in would send as it is; not a real one, so the cloud keeps it and nothing ever uses it.
await mkdir(join(home, ".local", "share", "devin"), { recursive: true })
await writeFile(join(home, ".local", "share", "devin", "credentials.toml"), 'windsurf_api_key = "proof-not-a-key"\n', { mode: 0o600 })
// A recent project on GitHub: what onboarding offers for a base.
const project = join(home, "projects", "hello-world")
await mkdir(project, { recursive: true })
const git = (...args: string[]) => execFileSync("git", ["-C", project, ...args], { stdio: "pipe" })
git("init", "-q", "-b", "master")
await writeFile(join(project, "README"), "Hello World!\n")
git("add", "README")
git("-c", "user.name=Mako proof", "-c", "user.email=proof@mako.invalid", "commit", "-q", "-m", "First")
git("remote", "add", "origin", "https://github.com/octocat/Hello-World.git")

// Sessions over the window, denser toward now, written so they don't compress away.
for (let index = 0; index < SESSIONS; index++) {
  const ageHours = 0.2 + (index / SESSIONS) ** 2 * DAYS * 24
  const id = randomUUID()
  const last = Date.now() - ageHours * HOUR
  const lines = index % 20 === 7 ? 6_000 : 20 + ((index * 37) % 300)
  const first = last - Math.min(lines, 120) * 60_000
  const folder = join(home, ".codex", "sessions", ...new Date(first).toISOString().slice(0, 10).split("-"))
  await mkdir(folder, { recursive: true })
  const path = join(folder, `rollout-${new Date(first).toISOString().slice(0, 19).replaceAll(":", "-")}-${id}.jsonl`)
  const at = (n: number) => new Date(first + ((last - first) * n) / Math.max(1, lines - 1)).toISOString()
  const body = [
    JSON.stringify({ timestamp: at(0), type: "session_meta", payload: { id, cwd: index % 3 ? join(home, "projects", `p${index % 7}`) : project, timestamp: at(0), cli_version: "0.160.0", originator: "codex_cli_rs" } }),
    ...Array.from({ length: lines }, (_, n) => JSON.stringify({ timestamp: at(n), type: "response_item", payload: { type: "message", role: n % 2 ? "assistant" : "user", content: [{ type: n % 2 ? "output_text" : "input_text", text: `Session ${index}, turn ${n}: ${randomBytes(120).toString("base64")}` }] } })),
  ]
  await writeFile(path, `${body.join("\n")}\n`)
  await utimes(path, new Date(last), new Date(last))
}

const { socket } = runtimeLocation(dataRoot)
// SAFETY: the electron package's main export is the path of its executable.
const electron = createRequire(import.meta.url)("electron") as string
const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, MAKO_DATA_ROOT: dataRoot, MAKO_WEB_SOCKET: socket, MAKO_CLOUD_URL: values.cloud, MAKO_SCREENLESS: "1" }
for (const name of ["CODEX_HOME", "CLAUDE_CONFIG_DIR", "XDG_DATA_HOME", "OPENCODE_DB", "MAKO_THREAD_URL", "CURSOR_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY"]) delete env[name]

type Host = { stop(): Promise<void>; call(channel: string, args: unknown[]): Promise<RuntimeValue> }
async function startHost(): Promise<Host> {
  const command = hostCommand({ executable: electron, args: [process.cwd()], env })
  const host = spawn(command.executable, command.args, { env: command.env, stdio: "ignore" })
  const kill = () => host.kill("SIGTERM")
  process.once("exit", kill)
  for (const deadline = Date.now() + 60_000; !(await runtimeInfo(socket).catch(() => null)); ) {
    if (Date.now() > deadline) throw new Error(`the host didn't start within a minute; its log is ${join(dataRoot, "logs", "host.log")}`)
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  const release = await holdHostLease(runtimeLocation(dataRoot).directory)
  const client = randomUUID()
  return {
    call: (channel, args) => invokeRuntime(socket, client, channel, args),
    stop: async () => {
      await release()
      process.off("exit", kill)
      kill()
      await new Promise((resolve) => host.once("exit", resolve))
    },
  }
}

const began = performance.now()
const seconds = (from = began) => Math.round((performance.now() - from) / 100) / 10
let host = await startHost()
/** The host's line, checked for the fields this proof reads (`contracts/cloud-turn-on.ts` is its shape). */
const TurnOnSchema = z.custom<CloudTurnOn>((value) => z.object({ phase: z.string(), steps: z.array(z.object({ id: z.string(), state: z.string() }).loose()) }).loose().safeParse(value).success)
const turnOn = async (channel = "mako:cloud-turn-on") => TurnOnSchema.parse(await host.call(channel, []))
type Change = { s: number; step: TurnOnStepId | "phase"; state: string; detail?: string }
type Report = {
  sessions: number
  days: number
  cloud: string
  hostUp: number
  signInMs?: number
  grantHeardMs?: number
  changes?: Change[]
  restart?: { atS: number; backMs: number; sinceKept: boolean; readyKept: boolean; signedInAgainMs?: number }
  final?: CloudTurnOn
  hostLog?: string[]
}
const report: Report = { sessions: SESSIONS, days: DAYS, cloud: values.cloud, hostUp: seconds() }

// Signing in: the browser half is the person's (here the cloud's local sign-in, played by the driver).
const AccountSchema = z.object({ state: z.object({ status: z.string(), url: z.string().optional() }).loose() }).loose()
let account = AccountSchema.parse(await host.call("mako:cloud-sign-in", []))
const asked = performance.now()
if (account.state.status === "signing-in") console.log(`SIGN IN ${account.state.url ?? ""}`)
for (const deadline = Date.now() + 60_000; account.state.status !== "signed-in"; ) {
  if (Date.now() > deadline) throw new Error(`the host didn't sign in: ${JSON.stringify(account.state)}; its log is ${join(dataRoot, "logs", "host.log")}`)
  await new Promise((resolve) => setTimeout(resolve, 100))
  account = AccountSchema.parse(await host.call("mako:cloud-account", []))
}
report.signInMs = Math.round(performance.now() - asked)
console.log(`${String(seconds()).padStart(7)} s  signed in, ${report.signInMs} ms after the page opened`)
console.log(`  line: ${(await turnOn()).phase}`)

// The invite: granted now, heard by Check now rather than at the next connection token.
console.log("GRANT")
const granting = performance.now()
let line = await turnOn()
for (const deadline = Date.now() + 2 * 60_000; line.phase === "no-cloud"; ) {
  if (Date.now() > deadline) throw new Error("the grant never reached this Mac")
  await new Promise((resolve) => setTimeout(resolve, 250))
  line = await turnOn("mako:cloud-turn-on-check")
}
report.grantHeardMs = Math.round(performance.now() - granting)
console.log(`${String(seconds()).padStart(7)} s  the cloud is on the account, heard ${report.grantHeardMs} ms after the grant (Check now)`)
// What a window does once it hears the cloud: offers its recent projects for bases.
const heard = performance.now()
await host.call("mako:cloud-offer-projects", [[project]])

/** Each step's changes, from the moment the grant was heard. */
const changes: Change[] = []
const last = new Map<string, string>()
const say = (now: CloudTurnOn) => {
  const s = seconds(heard)
  const seen = (key: TurnOnStepId | "phase", state: string, detail?: string) => {
    if (last.get(key) === `${state}${detail ?? ""}`) return
    last.set(key, `${state}${detail ?? ""}`)
    changes.push({ s, step: key, state, ...(detail && { detail }) })
    console.log(`${String(s).padStart(7)} s  ${key.padEnd(8)} ${state}${detail ? `  ${detail}` : ""}`)
  }
  seen("phase", now.phase)
  for (const step of now.steps) {
    const detail =
      step.id === "agents" ? step.agents.map((agent) => `${agent.harness}:${agent.state}`).join(",")
      : step.id === "projects" ? step.projects.map((each) => `${each.repository.split("/").at(-1)}:${each.base.state}`).join(",")
      : step.id === "history" ? `${step.inCloud}/${step.threads} (today ${step.today.inCloud}/${step.today.threads})`
      : undefined
    // The history while it goes: when today's are in, and each quarter of the window, not each Thread.
    const progress = step.id === "history" && step.state === "working" && step.threads
      ? `${step.today.threads && step.today.inCloud === step.today.threads ? "today's in, " : ""}${Math.floor((step.inCloud * 4) / step.threads) * 25}% of ${step.threads} Threads`
      : undefined
    seen(step.id, step.state, progress ?? (step.id === "history" && step.state === "working" ? undefined : detail))
  }
}

let restarted: Report["restart"]
const finished = (now: CloudTurnOn) => now.steps.every((step) => step.state === "done" || step.id === "thread")
for (const deadline = Date.now() + 20 * 60_000; Date.now() < deadline; ) {
  line = await turnOn()
  say(line)
  if (finished(line)) break
  // Once a Thread can run and the history is under way, the Mac quits and comes back: the line comes back where it was.
  const history = line.steps.find((step) => step.id === "history")
  if (!restarted && line.phase === "ready" && history?.id === "history" && history.inCloud > 0) {
    const before = line
    const atS = seconds(heard)
    console.log(`${String(atS).padStart(7)} s  quitting the host mid-way`)
    await host.stop()
    const starting = performance.now()
    host = await startHost()
    let back = await turnOn()
    // A host that couldn't keep its sign-in in a keychain (this scratch home has none it can use) kept it in memory:
    // it signs in again, as the person would, and the line takes up the same account's times.
    let signedInAgainMs: number | undefined
    if (back.phase === "signed-out") {
      const again = performance.now()
      const asking = AccountSchema.parse(await host.call("mako:cloud-sign-in", []))
      if (asking.state.status === "signing-in") console.log(`SIGN IN ${asking.state.url ?? ""}`)
      for (const deadline = Date.now() + 60_000; back.phase === "signed-out"; ) {
        if (Date.now() > deadline) throw new Error("the host didn't sign in again after its restart")
        await new Promise((resolve) => setTimeout(resolve, 100))
        back = await turnOn()
      }
      signedInAgainMs = Math.round(performance.now() - again)
    }
    restarted = { atS, backMs: Math.round(performance.now() - starting), sinceKept: back.since === before.since, readyKept: back.readyAt === before.readyAt, ...(signedInAgainMs !== undefined && { signedInAgainMs }) }
    console.log(`${String(seconds(heard)).padStart(7)} s  back: the line read ${restarted.backMs} ms after the host started${signedInAgainMs === undefined ? "" : ` (signed in again in ${signedInAgainMs} ms)`}, ${back.phase}, its times ${restarted.sinceKept && restarted.readyKept ? "kept" : "LOST"}`)
  }
  await new Promise((resolve) => setTimeout(resolve, 250))
}
report.changes = changes
report.restart = restarted
report.final = line
const log = await readFile(join(dataRoot, "logs", "host.log"), "utf8").catch(() => "")
const turnOnLog = log.split("\n").filter((each) => each.includes("cloud-turn-on") || each.includes("project bases")).slice(-30)
report.hostLog = turnOnLog
console.log(turnOnLog.join("\n"))
if (values.report) await writeFile(values.report, `${JSON.stringify(report, null, 2)}\n`)

await host.call("mako:cloud-sign-out", []).catch(() => undefined)
await host.stop()
// The home's sync reader retires after its last client: give it a moment before the home goes.
await new Promise((resolve) => setTimeout(resolve, 12_000))
if (!values.keep) await rm(root, { recursive: true, force: true })
