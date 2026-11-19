import { spawn, type ChildProcess } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdirSync, readdirSync, utimesSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { parseArgs } from "node:util"
import { z } from "zod"
import { HOST_NODE_OPTIONS } from "@mako/host/base/process-warnings"
import { createMakoBridge } from "@mako/host/contracts/renderer-bridge"
import { invokeRuntime, probeRuntime } from "@mako/host/transport/connection"
import { runtimeLocation } from "@mako/host/transport/service"
import { heldBy, slices } from "./lib/cpu-slices.ts"
import { claudeLine, claudeSessionPath, makeWorld } from "./lib/host-load-world.ts"
import { ownedScratch } from "./lib/owned-scratch.mjs"
import { fakeCloud } from "./lib/sync-bench-cloud.ts"

/**
 * How long a window takes from opening to a whole rail, on a scratch host shaped like a busy person's Mac: `--folders`
 * projects (36) holding `--sessions` Claude Code sessions between them (1,200), written over two months, beside the
 * host-load world's 29 Thread worktrees and their Fins. Nothing of the person's is read: the host runs isolated in a
 * scratch home (`ownedScratch`), as `bench:host-load`'s does.
 *
 * It times two opens. Cold: the host starts (as after a reboot) and a window opens the moment it answers `/health`.
 * Warm: another window opens on the settled host, `--warm` times. Each open asks what the renderer's boot asks, in the
 * renderer's order (`session.ts` `boot`, `loadGroups`, `threads.load`), each call timed from the open, and prints a
 * timeline: when each answered and when the rail had what it draws (the catalog ready, its groups and titles in).
 * `--order sequential` asks as the renderer did before its boot's reads went at once, to compare. `--account` signs the host in to the protocol's fake gateway first, so it reports its Sessions to the account as a
 * signed-in Mac does (`SessionReporter`), and the windows open while it does. `--cpu-prof <dir>` keeps the host's CPU profile and prints what held its loop over the cold open.
 *
 *   npm run bench:rail-load [-- --sessions 1200] [--folders 36] [--warm 5] [--order parallel|sequential] [--account] [--host <mako-host.js>] [--cpu-prof <dir>] [--out <file>] [--keep]
 */
const { values } = parseArgs({
  options: {
    sessions: { type: "string", default: "1200" },
    folders: { type: "string", default: "36" },
    warm: { type: "string", default: "5" },
    host: { type: "string" },
    "cpu-prof": { type: "string" },
    out: { type: "string" },
    keep: { type: "boolean", default: false },
    account: { type: "boolean", default: false },
    order: { type: "string", default: "parallel" },
  },
})
const SESSIONS = Number(values.sessions)
const FOLDERS = Number(values.folders)
const WARM = Number(values.warm)
/** `--order sequential`: the renderer's order before its reads went at once, one after another and the catalog's rows after the native requests. */
const SEQUENTIAL = z.enum(["parallel", "sequential"]).parse(values.order) === "sequential"
const DAY = 86_400_000
const hostScript = resolve(values.host ?? join(import.meta.dirname, "../packages/host/dist/mako-host.js"))
const delay = (ms: number) => new Promise((done) => setTimeout(done, ms))
const say = (line: string) => process.stdout.write(`${line}\n`)

/** Sessions in `folders` projects, a few long ones among them, each folder last worked on a different day. */
function projectSessions(home: string, root: string): string[] {
  const folders = Array.from({ length: FOLDERS }, (_, n) => join(root, "projects", `project-${String(n).padStart(2, "0")}`))
  for (const folder of folders) mkdirSync(folder, { recursive: true })
  for (let n = 0; n < SESSIONS; n += 1) {
    const cwd = folders[n % folders.length]!
    const session = randomUUID()
    const path = claudeSessionPath(home, cwd, session)
    const at = new Date(Date.now() - ((n * 7919) % 60) * DAY - (n % folders.length) * 3_600_000)
    let parent: string | null = null
    let text = ""
    const turns = n % 50 === 0 ? 200 : 4
    for (let turn = 0; turn < turns; turn += 1) {
      const asked = claudeLine(session, cwd, "user", `Question ${turn} of session ${n}.`, parent, at)
      const answered = claudeLine(session, cwd, "assistant", [{ type: "text", text: `Answer ${turn}. ${"Detail a real answer carries. ".repeat(12)}` }], asked.uuid, at)
      parent = answered.uuid
      text += asked.line + answered.line
    }
    writeFileSync(path, text)
    utimesSync(path, at, at)
  }
  return folders
}

const ThreadsSchema = z.object({ ready: z.boolean(), threads: z.array(z.unknown()) }).loose()

type Call = { name: string; from: number; to: number; failed?: boolean }

/**
 * A window's open, as the renderer's boot makes it: `boot`, then at once the catalog's load (its rows with the harness
 * descriptors, then the native requests, again every 1.5 s until ready), `loadGroups`' reads in the renderer's order
 * and the worktrees. Times are from the open.
 */
async function openWindow(socket: string): Promise<{ calls: Call[]; marks: Record<string, number> }> {
  const client = randomUUID()
  const began = performance.now()
  const calls: Call[] = []
  const marks: Record<string, number> = {}
  const bridge = createMakoBridge({
    invoke: async <Result>(channel: string, ...args: unknown[]) => {
      const call: Call = { name: channel.replace(/^mako:/, ""), from: performance.now() - began, to: 0 }
      calls.push(call)
      try {
        // SAFETY: the bridge calls the scratch host's generated method contract, as the window's socket transport does.
        return await invokeRuntime(socket, client, channel, args, 1, { timeoutMs: 120_000 }) as Result
      } catch (error) {
        call.failed = true
        throw error
      } finally {
        call.to = performance.now() - began
      }
    },
    onEvent: () => () => {}, onTerminalEvent: () => () => {}, pathForFile: () => null, resolveFileUrl: (url) => url,
  })
  const mark = (name: string) => { marks[name] = performance.now() - began }
  const quiet = <T>(work: () => Promise<T>) => work().catch(() => undefined)
  await bridge.boot()
  mark("boot")
  const catalog = (async () => {
    for (;;) {
      const requests = SEQUENTIAL ? undefined : quiet(() => bridge.nativeRequests())
      const [raw] = await Promise.all([bridge.threads(), quiet(() => bridge.harnessDescriptors())])
      if (SEQUENTIAL) await quiet(() => bridge.nativeRequests())
      const listed = ThreadsSchema.parse(raw)
      marks.firstRows ??= performance.now() - began
      await requests
      if (listed.ready) return mark("catalogReady")
      // The host pushes the whole list to its windows once its catalog is ready (`threads`); asking every 50 ms stands
      // in for that push here, where the renderer asks again only every 1.5 s.
      await delay(50)
    }
  })()
  const groups = (async () => {
    if (SEQUENTIAL) for (const read of RAIL_READS) await quiet(() => read(bridge))
    else await Promise.all(RAIL_READS.map((read) => quiet(() => read(bridge))))
    mark("groupsAndTitles")
  })()
  const worktrees = quiet(() => bridge.worktrees()).then(() => mark("worktrees"))
  await Promise.all([catalog, groups, worktrees])
  mark("railWhole")
  return { calls, marks }
}

type Bridge = ReturnType<typeof createMakoBridge>
/** `loadGroups`' reads, in its order. */
const RAIL_READS: ((bridge: Bridge) => Promise<void>)[] = [
  async (bridge) => { await bridge.threadGroups() },
  async (bridge) => { await bridge.threadPurposes() },
  async (bridge) => { await bridge.storeFormats() },
  async (bridge) => { await bridge.fileEventsService() },
  async (bridge) => { await bridge.mcpSignIns() },
  async (bridge) => { await bridge.unopenedConversations() },
  async (bridge) => { await bridge.threadTitles() },
]

function timeline(label: string, open: { calls: Call[]; marks: Record<string, number> }) {
  say(`${label}:`)
  for (const call of [...open.calls].sort((a, b) => a.from - b.from))
    say(`  ${call.name.padEnd(26)} ${String(Math.round(call.from)).padStart(6)} → ${String(Math.round(call.to)).padStart(6)} ms  (${Math.round(call.to - call.from)} ms)${call.failed ? " failed" : ""}`)
  for (const [name, at] of Object.entries(open.marks)) say(`  = ${name.padEnd(24)} ${Math.round(at)} ms`)
}

const scratch = ownedScratch("mako-rail-load-", { keep: values.keep })
let host: ChildProcess | undefined
let release: () => void | Promise<void> = () => {}
let closeCloud: () => void | Promise<void> = () => {}
try {
  const root = scratch.path
  const world = await makeWorld(root, { threads: 29, fins: [6, 6, 4, 3, 2, 2], files: [200, 200], apps: 10, running: 0, processes: 0, sessions: 0 })
  release = world.release
  projectSessions(world.home, root)
  say(`world: ${FOLDERS} projects, ${SESSIONS} sessions, ${world.checkouts.length} Thread worktrees (${root})`)

  const cloud = values.account ? await fakeCloud() : undefined
  if (cloud) {
    closeCloud = () => cloud.close()
    await cloud.account()
    mkdirSync(join(world.dataRoot, "cloud"), { recursive: true, mode: 0o700 })
    // Signed in for the account only: no harness sign-ins shared, no login item installed.
    writeFileSync(join(world.dataRoot, "cloud", "sign-ins.json"), JSON.stringify({ version: 2, sharing: false, accessOnly: true, inStep: {} }), { mode: 0o600 })
    mkdirSync(join(world.home, ".mako"), { recursive: true })
    writeFileSync(join(world.home, ".mako", "syncd-login-optout"), "")
  }
  const { directory, socket } = runtimeLocation(world.dataRoot)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(MAKO_|CLAUDE_|CODEX_HOME|CURSOR_|GROK_|XAI_)/.test(name)))
  const profileDir = values["cpu-prof"] && resolve(values["cpu-prof"])
  if (profileDir) mkdirSync(profileDir, { recursive: true })
  const started = performance.now()
  host = spawn(process.execPath, [...HOST_NODE_OPTIONS, ...(profileDir ? ["--cpu-prof", "--cpu-prof-dir", profileDir, "--cpu-prof-interval", "1000"] : []), hostScript], {
    env: { ...env, HOME: world.home, TMPDIR: world.temporary, MAKO_DATA_ROOT: world.dataRoot, CLAUDE_CONFIG_DIR: join(world.home, ".claude"), MAKO_WEB_SOCKET: socket, MAKO_PROD: "1", MAKO_TELEMETRY: "off", ...cloud && { MAKO_CLOUD_URL: cloud.url } },
    stdio: ["ignore", "ignore", "inherit"],
  })
  for (const deadline = Date.now() + 60_000; ; await delay(20)) {
    const probe = await probeRuntime(socket, { timeoutMs: 2_000 }).catch(() => undefined)
    if (probe?.state === "ready") break
    if (Date.now() > deadline) throw new Error("the host didn't answer /health within a minute")
  }
  const healthAt = performance.now() - started
  say(`host answered /health ${Math.round(healthAt)} ms after it was started`)
  if (cloud) {
    // Signed in before the first window, as a Mac after a reboot is: its first report goes as the window opens.
    const call = (channel: string) => invokeRuntime(socket, randomUUID(), channel, [], 1, { timeoutMs: 120_000 })
    const Account = z.object({ state: z.object({ status: z.string(), url: z.string().optional() }).loose() }).loose()
    let account = Account.parse(await call("mako:cloud-sign-in"))
    if (account.state.status === "signing-in") await cloud.signIn(z.string().parse(account.state.url))
    for (const deadline = Date.now() + 120_000; account.state.status !== "signed-in"; await delay(100)) {
      if (Date.now() > deadline) throw new Error(`the host isn't signed in to the fake account: ${account.state.status}`)
      account = Account.parse(await call("mako:cloud-account"))
    }
    say(`signed in to the fake account ${Math.round(performance.now() - started)} ms after the host was started`)
  }
  const cold = await openWindow(socket)
  timeline("cold open (the host just started)", cold)

  // Settled: the catalog's scan and the first sync done, as a window opened later finds the host.
  await delay(5_000)
  const warm: Awaited<ReturnType<typeof openWindow>>[] = []
  for (let run = 0; run < WARM; run += 1) warm.push(await openWindow(socket))
  const median = (samples: number[]) => [...samples].sort((a, b) => a - b)[Math.floor(samples.length / 2)] ?? 0
  const warmMarks = Object.fromEntries(Object.keys(warm[0]?.marks ?? {}).map((name) => [name, median(warm.map((open) => open.marks[name] ?? 0))]))
  const warmCalls = Object.fromEntries([...new Set(warm.flatMap((open) => open.calls.map((call) => call.name)))].map((name) => [name, median(warm.flatMap((open) => open.calls.filter((call) => call.name === name).map((call) => call.to - call.from)))]))
  say(`warm open, median of ${WARM}:`)
  for (const [name, ms] of Object.entries(warmCalls)) say(`  ${name.padEnd(26)} ${Math.round(ms)} ms`)
  for (const [name, at] of Object.entries(warmMarks)) say(`  = ${name.padEnd(24)} ${Math.round(at)} ms`)

  const listed = ThreadsSchema.parse(await invokeRuntime(socket, randomUUID(), "mako:threads", [undefined]))
  say(`catalog: ${listed.threads.length} rows`)
  host.kill("SIGTERM")
  await new Promise((done) => host!.once("exit", done))
  host = undefined
  const profile = profileDir && readdirSync(profileDir).filter((name) => /\.\d+\.0\.\d+\.cpuprofile$/.test(name)).map((name) => join(profileDir, name)).sort().at(-1)
  const held = profile ? slices(profile, 20) : []
  if (profile) {
    say(`the host's loop held 20 ms or more ${held.length} times, ${Math.round(held.reduce((sum, slice) => sum + slice.ms, 0))} ms in all; by function:`)
    for (const { frame, ms, slices: count } of heldBy(held, 15)) say(`  ${String(Math.round(ms)).padStart(6)} ms ${String(count).padStart(3)}× ${frame}`)
  }
  if (values.out) writeFileSync(values.out, JSON.stringify({ sessions: SESSIONS, folders: FOLDERS, healthAt, cold, warm: { calls: warmCalls, marks: warmMarks }, rows: listed.threads.length, ...profile && { profile, heldBy: heldBy(held, 25) } }, null, 2))
} finally {
  host?.kill("SIGKILL")
  await release()
  await closeCloud()
  await scratch.dispose()
}
