import { execFile, spawn } from "node:child_process"
import { randomBytes, randomUUID } from "node:crypto"
import { appendFile, mkdir, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { parseArgs, promisify } from "node:util"
import { z } from "zod"
import { invokeRuntime, runtimeInfo } from "@mako/host/transport/connection"
import { hostCommand, runtimeLocation } from "@mako/host/transport/service"
import { holdHostLease } from "@mako/host/base/host-idle"
import { SyncStatusSchema, type SyncStatus } from "@mako/host/contracts/sync-status"
import { SYNC_WINDOW_MS } from "@mako/host/conversations/sync-window"

/**
 * The sync order, end to end, against a cloud of its own: a host of this checkout's build on a scratch home whose
 * harness stores hold `--sessions` Codex sessions spread over `--days` days (denser toward now, as a person's are, a
 * few large), signed in to `--cloud` with the cloud. It reads `mako:sync-status` each second and says when each tier
 * was readable on another device and whole in the account, the backfill's rate, the bytes sent, and what the host's
 * processes spent; then a turn is appended to the newest session and timed until both forms are in the account again.
 *
 * The home is the scratch one: the person's own harness stores are never read, and nothing of theirs reaches the
 * cloud. The host prints `SIGN IN <url>` for whoever plays the person (a local cloud's test sign-in) and goes on once
 * the account has the cloud.
 *
 *   npx tsx --tsconfig tsconfig.scripts.json scripts/prove-sync-order.ts --root <scratch> --cloud http://127.0.0.1:20022 [--sessions 300] [--days 40] [--report <file>] [--keep]
 */
const { values } = parseArgs({
  options: {
    root: { type: "string" },
    cloud: { type: "string" },
    sessions: { type: "string", default: "300" },
    days: { type: "string", default: "40" },
    report: { type: "string" },
    keep: { type: "boolean", default: false },
  },
})
if (!values.root || !values.cloud) throw new Error("--root and --cloud are required")
const root = values.root
const home = join(root, "home")
// In the home's application-data folder, so the host is that home's and shares its sync reader, as the person's does.
const dataRoot = join(home, "Library", "Application Support", "mako-sync-proof", "profile")
const SESSIONS = Number(values.sessions)
const DAYS = Number(values.days)
const HOUR = 3_600_000
const run = promisify(execFile)

/** One Codex session's rollout, `lines` turns long, its last written `ageHours` ago, in a project of its own. */
async function rollout(index: number, ageHours: number, lines: number): Promise<{ path: string; id: string }> {
  const id = randomUUID()
  const last = Date.now() - ageHours * HOUR
  const first = last - Math.min(lines, 120) * 60_000
  const day = new Date(first).toISOString().slice(0, 10).split("-")
  const stamp = new Date(first).toISOString().slice(0, 19).replaceAll(":", "-")
  const folder = join(home, ".codex", "sessions", ...day)
  await mkdir(folder, { recursive: true })
  const path = join(folder, `rollout-${stamp}-${id}.jsonl`)
  const cwd = join(home, "projects", `p${index % 17}`)
  await mkdir(cwd, { recursive: true })
  const at = (n: number) => new Date(first + ((last - first) * n) / Math.max(1, lines - 1)).toISOString()
  const body = [
    JSON.stringify({ timestamp: at(0), type: "session_meta", payload: { id, cwd, timestamp: at(0), cli_version: "0.160.0", originator: "codex_cli_rs" } }),
    JSON.stringify({ timestamp: at(0), type: "turn_context", payload: { cwd, model: "gpt-6-astra" } }),
    ...Array.from({ length: lines }, (_, n) =>
      // Words that don't compress away, as a real turn's code and output don't: a session's bytes are what goes up.
      JSON.stringify({ timestamp: at(n), type: "response_item", payload: { type: "message", role: n % 2 ? "assistant" : "user", content: [{ type: n % 2 ? "output_text" : "input_text", text: `Session ${index}, turn ${n}: ${randomBytes(120).toString("base64")}` }] } })
    ),
  ]
  await writeFile(path, `${body.join("\n")}\n`)
  await utimes(path, new Date(last), new Date(last))
  return { path, id }
}

/** What the run found, written to `--report`. */
type Report = {
  sessions: number
  days: number
  cloud: string
  fixture?: { inWindow: number; day: number; week: number; older: number }
  firsts?: Record<string, number>
  synced?: boolean
  turn?: { readableMs: number | undefined; wholeMs: number | undefined }
  order?: Record<string, { tiers: Record<string, { sessions: number; firstS?: number; lastS?: number }>; inversions: number; storedMiB: number; mibPerSecond: number | undefined }>
  spent?: Spent
  status?: SyncStatus
  timeline?: { s: number; state: SyncStatus["state"]; tiers?: Record<string, string>; backfill?: Running["backfill"]; cpuSeconds: number; rssMiB: number; processes: number }[]
  syncLog?: string[]
}
const report: Report = { sessions: SESSIONS, days: DAYS, cloud: values.cloud }
// A folder of its own: one that holds anything already is refused, so a mistyped root is never written into or removed.
if ((await readdir(root).catch(() => [])).length) throw new Error(`${root} isn't empty: give the proof a folder of its own`)
await mkdir(join(home, ".mako"), { recursive: true })
// The on-demand reader, not a login job: nothing here touches launchd.
await writeFile(join(home, ".mako", "syncd-login-optout"), "")
await mkdir(join(dataRoot, "cloud"), { recursive: true, mode: 0o700 })
// No harness sign-in goes to this cloud.
await writeFile(join(dataRoot, "cloud", "sign-ins.json"), JSON.stringify({ version: 2, sharing: false, accessOnly: true, inStep: {} }), { mode: 0o600 })

// Denser toward now: the age grows with the square of the rank, so about a tenth fall in the last day and a third in the
// last week; one in twenty is large (a long session), so pacing shows.
const made: { path: string; id: string; ageHours: number }[] = []
for (let index = 0; index < SESSIONS; index++) {
  const ageHours = 0.2 + (index / SESSIONS) ** 2 * DAYS * 24
  const lines = index % 20 === 7 ? 12_000 : 20 + ((index * 37) % 380)
  made.push({ ...(await rollout(index, ageHours, lines)), ageHours })
}
const windowed = made.filter((each) => each.ageHours <= SYNC_WINDOW_MS / 3_600_000)
report.fixture = {
  inWindow: windowed.length,
  day: made.filter((each) => each.ageHours <= 24).length,
  week: made.filter((each) => each.ageHours > 24 && each.ageHours <= 7 * 24).length,
  older: made.length - windowed.length,
}
console.log("fixture", JSON.stringify(report.fixture))

// The host, screenless, from this checkout's build, on the scratch home.
const { socket } = runtimeLocation(dataRoot)
// SAFETY: the electron package's main export is the path of its executable.
const electron = createRequire(import.meta.url)("electron") as string
const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, MAKO_DATA_ROOT: dataRoot, MAKO_WEB_SOCKET: socket, MAKO_CLOUD_URL: values.cloud, MAKO_SCREENLESS: "1" }
for (const name of ["CODEX_HOME", "CLAUDE_CONFIG_DIR", "XDG_DATA_HOME", "OPENCODE_DB", "MAKO_THREAD_URL"]) delete env[name]
const command = hostCommand({ executable: electron, args: [process.cwd()], env })
const started = performance.now()
const host = spawn(command.executable, command.args, { env: command.env, stdio: "ignore" })
const stopHost = () => host.kill("SIGTERM")
process.once("exit", stopHost)
for (const deadline = Date.now() + 60_000; !(await runtimeInfo(socket).catch(() => null)); ) {
  if (Date.now() > deadline) throw new Error(`the host didn't start within a minute; its log is ${join(dataRoot, "logs", "host.log")}`)
  await new Promise((resolve) => setTimeout(resolve, 250))
}
const release = await holdHostLease(runtimeLocation(dataRoot).directory)
const client = randomUUID()
const call = (channel: string, args: unknown[]) => invokeRuntime(socket, client, channel, args)

const AccountSchema = z.object({ state: z.object({ status: z.string(), url: z.string().optional(), account: z.object({ entitlements: z.array(z.string()) }).loose().optional() }).loose() }).loose()
let account = AccountSchema.parse(await call("mako:cloud-sign-in", []))
if (account.state.status === "signing-in") console.log(`SIGN IN ${account.state.url ?? ""}`)
for (const deadline = Date.now() + 5 * 60_000; !(account.state.status === "signed-in" && account.state.account?.entitlements.includes("cloud")); ) {
  if (Date.now() > deadline) throw new Error(`the host isn't signed in with the cloud: ${account.state.status}`)
  await new Promise((resolve) => setTimeout(resolve, 500))
  account = AccountSchema.parse(await call("mako:cloud-account", []))
}
const signedIn = performance.now()
console.log(`signed in with the cloud after ${Math.round((signedIn - started) / 1000)} s`)

/** What the host's processes have spent so far: its own, the reader's and its backfill's, by CPU seconds and memory. */
type Spent = { cpuSeconds: number; rssMiB: number; processes: number }
async function spent(): Promise<Spent> {
  const { stdout } = await run("ps", ["-E", "-axo", "pid=,ppid=,rss=,time=,command="], { maxBuffer: 64 * 1024 * 1024 })
  let cpuSeconds = 0
  let rss = 0
  let processes = 0
  for (const line of stdout.split("\n")) {
    // Every process run with this scratch home: the host, its reader, the backfill's passes, the workers.
    if (!` ${line} `.includes(` HOME=${home} `)) continue
    const [, , kib = "0", time = "0:0"] = line.trim().split(/\s+/)
    const parts = time.split(":").map(Number)
    cpuSeconds += parts.reduce((total, part) => total * 60 + part, 0)
    rss += Number(kib)
    processes += 1
  }
  return { cpuSeconds: Math.round(cpuSeconds * 10) / 10, rssMiB: Math.round(rss / 1024), processes }
}

type Running = Extract<SyncStatus, { tiers: unknown }>
const timeline: { s: number; status: SyncStatus; spent: Spent }[] = []
const firsts: Record<string, number> = {}
const at = () => Math.round((performance.now() - signedIn) / 100) / 10
const note = (name: string) => {
  if (firsts[name] !== undefined) return
  firsts[name] = at()
  console.log(`${String(firsts[name]).padStart(7)} s  ${name}`)
}
let status: SyncStatus = SyncStatusSchema.parse(await call("mako:sync-status", []))
for (const deadline = Date.now() + 30 * 60_000; Date.now() < deadline; ) {
  status = SyncStatusSchema.parse(await call("mako:sync-status", []))
  if (timeline.length % 5 === 0 || status.state === "synced") timeline.push({ s: at(), status, spent: await spent() })
  if ("tiers" in status) {
    for (const tier of status.tiers) {
      if (!tier.sessions) continue
      if (tier.readable === tier.sessions) note(`${tier.tier}: every Session readable (${tier.sessions})`)
      if (tier.whole === tier.sessions) note(`${tier.tier}: every Session whole (${tier.sessions})`)
    }
    const first = status.tiers.find((tier) => tier.inCloud > 0)
    if (first) note(`first Session in the cloud (${first.tier})`)
    if (status.backfill?.endedAt) note(`backfill pass ended (${status.backfill.done} of ${status.backfill.sessions})`)
    if (status.state === "synced") break
  }
  await new Promise((resolve) => setTimeout(resolve, 1_000))
}
report.firsts = firsts
report.synced = status.state === "synced"

/**
 * When the account took each Session whole, in each form, as the stores that push them keep it (`remote_pushed`, the
 * one truth the status reads too), by `<harness>\n<native id>`; and the bytes each store holds.
 */
type Pushed = { at: Map<string, number>; bytes: number }
function pushedAt(store: "copies" | "originals"): Pushed {
  const file = store === "copies" ? join(home, ".mako", "records", "copies", "store", "records.sqlite") : join(home, ".mako", "records", "records.sqlite")
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    const rows = z.object({ harness: z.string(), nativeId: z.string(), at: z.number() }).array()
      .parse(db.prepare("SELECT s.harness, s.native_id AS nativeId, max(p.at) AS at FROM remote_pushed p JOIN sessions s ON s.id = p.session GROUP BY p.session").all())
    const bytes = z.object({ bytes: z.number().nullable() }).parse(db.prepare("SELECT sum(stored) AS bytes FROM chunks").get()).bytes ?? 0
    return { at: new Map(rows.map((row) => [`${row.harness}\n${row.nativeId}`, row.at])), bytes }
  } finally {
    db.close()
  }
}

// The order and pace each form went in, from the stores: each tier's first and last Session in the account, and how
// many went before one of a newer tier (none, if the order held).
const signedInAt = Date.now() - (performance.now() - signedIn)
type Age = "day" | "week" | "older"
const tierOf = (ageHours: number): Age => (ageHours <= 24 ? "day" : ageHours <= SYNC_WINDOW_MS / 3_600_000 ? "week" : "older")
const rank = { day: 0, week: 1, older: 2 } satisfies Record<Age, number>
report.order = {}
for (const form of ["copies", "originals"] as const) {
  const { at, bytes } = pushedAt(form)
  const arrivals = made.flatMap((each) => {
    const when = at.get(`codex\n${each.id}`)
    return when === undefined ? [] : [{ tier: tierOf(each.ageHours), s: (when - signedInAt) / 1000 }]
  }).sort((left, right) => left.s - right.s)
  let inversions = 0
  let newest = -1
  for (const arrival of arrivals) {
    if (rank[arrival.tier] < newest) inversions += 1
    newest = Math.max(newest, rank[arrival.tier])
  }
  const tiers = Object.fromEntries((["day", "week", "older"] as const).map((tier) => {
    const times = arrivals.filter((arrival) => arrival.tier === tier).map((arrival) => arrival.s)
    return [tier, times.length ? { sessions: times.length, firstS: Math.round(times[0]! * 10) / 10, lastS: Math.round(times.at(-1)! * 10) / 10 } : { sessions: 0 }]
  }))
  const span = (arrivals.at(-1)?.s ?? 0) - (arrivals[0]?.s ?? 0)
  report.order[form] = { tiers, inversions, storedMiB: Math.round(bytes / 1048576 * 10) / 10, mibPerSecond: span > 0 ? Math.round((bytes / 1048576 / span) * 100) / 100 : undefined }
  console.log(form, JSON.stringify(report.order[form]))
}

// A turn on the newest session: timed from the write until the account took it whole in each form.
const newest = made[0]
if (newest && status.state === "synced") {
  const key = `codex\n${newest.id}`
  const wrote = Date.now()
  await appendFile(newest.path, `${JSON.stringify({ timestamp: new Date().toISOString(), type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "One more turn, now." }] } })}\n`)
  let readableMs: number | undefined
  let wholeMs: number | undefined
  for (const deadline = Date.now() + 3 * 60_000; Date.now() < deadline && (readableMs === undefined || wholeMs === undefined); ) {
    await new Promise((resolve) => setTimeout(resolve, 250))
    const copied = pushedAt("copies").at.get(key)
    const pushed = pushedAt("originals").at.get(key)
    if (readableMs === undefined && copied !== undefined && copied > wrote) readableMs = copied - wrote
    if (wholeMs === undefined && pushed !== undefined && pushed > wrote) wholeMs = pushed - wrote
  }
  report.turn = { readableMs, wholeMs }
  console.log(`a turn on the newest session: readable after ${readableMs ? (readableMs / 1000).toFixed(1) : "–"} s, whole after ${wholeMs ? (wholeMs / 1000).toFixed(1) : "–"} s`)
}

const last = timeline.at(-1)
report.spent = last?.spent
report.status = status
report.timeline = timeline.map(({ s, status: each, spent: cost }) => ({
  s,
  state: each.state,
  ...("tiers" in each && { tiers: Object.fromEntries(each.tiers.map((tier) => [tier.tier, `${tier.readable}/${tier.whole}/${tier.sessions}`])), backfill: each.backfill }),
  ...cost,
}))
const log = await readFile(join(dataRoot, "logs", "host.log"), "utf8").catch(() => "")
report.syncLog = log.split("\n").filter((line) => / sync /.test(line) || line.includes("shared catalog")).slice(-40)
if (values.report) await writeFile(values.report, `${JSON.stringify(report, null, 2)}\n`)

await call("mako:cloud-sign-out", []).catch(() => undefined)
await release()
stopHost()
await new Promise((resolve) => host.once("exit", resolve))
// The home's sync reader retires 10 s after its last client and writes its cache as it goes: the home goes after it.
for (const deadline = Date.now() + 60_000; (await spent()).processes > 0 && Date.now() < deadline; ) await new Promise((resolve) => setTimeout(resolve, 500))
if (!values.keep) await rm(root, { recursive: true, force: true })
console.log(JSON.stringify({ firsts, order: report.order, turn: report.turn, spent: report.spent }, null, 2))
