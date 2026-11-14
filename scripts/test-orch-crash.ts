import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { performance } from "node:perf_hooks"
import type { ThreadPage, ThreadRef } from "@mako/sessions"
import { followHostLog } from "@mako/host/base/host-log"
import { END_CONFIRM_MS } from "@mako/host/conversations/agent-runs"
import type { AgentsDeps } from "@mako/host/conversations/agents"
import { ThreadIdSchema } from "@mako/host/contracts/thread-identity"
import { FROM_AGENTS } from "@mako/host/conversations/agent-wakes"
import { AgentsWorld, HARNESSES, TESTED_HARNESSES, type Heard, type Script } from "./lib/agents-world.ts"

/**
 * The host killed mid-tree (`npm run test:orch-crash`): SIGKILL, as a crash
 * or the system's memory killer ends it, with no exit to leave anything for
 * the next host. Each run kills a host at one of thirteen points of an Apex's
 * work, on each of the six harnesses, then opens a new host on the same store
 * and journals and lets it settle. Every run ends with every brief sent
 * once, every Fin finished with its reports heard once, the Apex's message
 * to a Fin taken once, every start the budget held started, and every
 * message held for an Apex whose process another program runs delivered
 * once. What each harness took is written down as it takes it, so a turn
 * the kill cut is counted too.
 *
 * Eleven points are in a tree: an Apex starts two Fins under a running budget
 * of one, so the second waits, and sends the first a message while it works.
 * The kill at the first's brief has that message behind it; at the second's
 * (`lone`), nothing is, so only the next host carries its turn on. Two are an Apex whose turns a process Mako didn't start runs (a harness
 * CLI its Apex linked): its Fin's report is held until that process ends.
 */
const POINTS = ["launched", "brief", "admitted", "queued", "send", "report", "notice", "released", "lone", "wake", "woken", "held", "freed"] as const
type Point = (typeof POINTS)[number]
/** The kill points that are a host's log lines, by line. */
const LOGGED = new Map<string, Point>([
  ["start admitted", "admitted"],
  ["start queued", "queued"],
  ["send", "send"],
  ["report", "report"],
  ["notice", "notice"],
  ["start released", "released"],
  ["wake", "wake"],
  ["message held", "held"],
  ["held message released", "freed"],
])
const HELD_POINTS: ReadonlySet<string> = new Set(["held", "freed"])
const SEND = "Also check the README's install steps."
const RUN_MS = 30_000

interface State {
  apex: string
  /** The held scenario: the linked run's process and native session. */
  run?: { pid: number; nativeId: string }
}

interface Settled {
  edges: { name: string; child: string; parent: string; op: string; conversations: string[]; reports: { id: string; status: string; summary: string }[] }[]
  undelivered: number
  queued: number
}

type Line = Heard | { kind: "log"; message: string }

const statePath = (root: string) => join(root, "state.json")
const heardPath = (root: string) => join(root, "heard.ndjson")

function readState(root: string): State {
  return JSON.parse(readFileSync(statePath(root), "utf8"))
}

function lines(root: string): Line[] {
  if (!existsSync(heardPath(root))) return []
  return readFileSync(heardPath(root), "utf8").split("\n").filter(Boolean).map((line): Line => JSON.parse(line))
}

function next(harness: string): string {
  return HARNESSES[(HARNESSES.findIndex((each) => each === harness) + 1) % HARNESSES.length]!
}

async function until(what: string, done: () => boolean, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

/** The Sessions the catalog lists, kept in a file so the host after a kill lists the same ones. */
function fileCatalog(root: string): AgentsDeps["catalog"] {
  const refs = (): ThreadRef[] => (existsSync(join(root, "catalog.json")) ? JSON.parse(readFileSync(join(root, "catalog.json"), "utf8")) : [])
  return {
    nativePath: (identity) => refs().find((ref) => ref.harness === identity.harness && ref.nativeId === identity.nativeId)?.path,
    ref: (path) => refs().find((ref) => ref.path === path),
    page: async (path): Promise<ThreadPage | null> => {
      const ref = refs().find((each) => each.path === path)
      return ref ? { ref, entries: [], start: 0, total: 0, hasEarlier: false } : null
    },
    activity: () => ({}),
    subscribe: () => () => {},
    announce: () => {},
  }
}

// ── One host, run as its own process ──

async function host(root: string, harness: string, point: Point | "none"): Promise<void> {
  const held = HELD_POINTS.has(point) || point === "none" && existsSync(join(root, "held"))
  const first = !existsSync(statePath(root))
  const write = (line: Line) => appendFileSync(heardPath(root), `${JSON.stringify(line)}\n`)
  const kill = (at: Point) => {
    if (at !== point) return
    write({ kind: "log", message: `killed at ${at}` })
    process.kill(process.pid, "SIGKILL")
  }
  followHostLog((line) => {
    if (line.scope !== "agents") return
    write({ kind: "log", message: line.level === "info" ? line.message : `${line.message} ${JSON.stringify(line.fields ?? {})}` })
    if (line.message === "message held" && point === "freed") process.kill(readState(root).run!.pid, "SIGTERM")
    const at = line.level === "info" ? LOGGED.get(line.message) : undefined
    if (at) kill(at)
  })
  const state = () => readState(root)
  const turns = (conversation: string) => lines(root).filter((line) => line.kind === "prompt" && line.conversation === conversation).length
  const script: Script = async (turn) => {
    if (turn.text.includes(FROM_AGENTS)) return "Noted."
    if (turn.conversation === state().apex) {
      if (held) return "Linked."
      const sidebar = await turn.world.agents.start(turn.caller, { brief: { objective: "Review the sidebar." }, harness, name: "sidebar", clientKey: "sidebar", cwd: root })
      await turn.world.agents.start(turn.caller, { brief: { objective: "Review the header." }, harness: next(harness), name: "header", queue: true, clientKey: "header", cwd: root })
      if (!("refused" in sidebar)) await turn.world.agents.send(turn.caller, { to: "sidebar", text: SEND, clientKey: "readme" })
      return "Started both."
    }
    await new Promise((resolve) => setTimeout(resolve, 150))
    return `Done with turn ${turns(turn.conversation)}.`
  }
  let launches = 0
  const world: AgentsWorld = new AgentsWorld({
    root,
    script,
    // Each harness keeps its transcript, as real ones do, so the next host can see whether a cut brief reached it.
    transcripts: true,
    ...(!held && { budget: { running: 1, started: 100 } }),
    catalog: fileCatalog(root),
    heard: (heard) => {
      write(heard)
      if (heard.kind !== "prompt") return
      if (heard.text.includes("You're fin:sidebar")) kill("brief")
      if (heard.text.includes("You're fin:header")) kill("lone")
      if (heard.conversation === state().apex && heard.text.includes(FROM_AGENTS)) kill("woken")
    },
    launching: (conversation) => {
      if (world.live.snapshot(conversation)?.requests[0]?.actor?.kind === "agent" && (launches += 1) === 1) kill("launched")
    },
  })
  try {
    if (first && !held) {
      const apex = await world.apex(harness)
      writeFileSync(statePath(root), JSON.stringify({ apex: apex.conversation } satisfies State))
      world.say(apex.conversation, "Start the sidebar and header reviews.")
    } else if (first) {
      writeFileSync(join(root, "held"), "")
      // A harness CLI the Apex's shell runs, followed by its process: it outlives this host, as a terminal's run does.
      const shell = spawn("/bin/sh", ["-c", "sleep 60"], { detached: true, stdio: "ignore" })
      shell.unref()
      const nativeId = `cli-${harness}`
      writeFileSync(join(root, "catalog.json"), JSON.stringify([{ harness, nativeId, path: `/${harness}/${nativeId}.jsonl`, cwd: root, startedAt: new Date().toISOString() }]))
      const apex = await world.apex(harness)
      writeFileSync(statePath(root), JSON.stringify({ apex: apex.conversation, run: { pid: shell.pid!, nativeId } } satisfies State))
      const linked = await world.agents.link(apex.caller, { harness, session: nativeId, pid: shell.pid! })
      assert.ok(!("refused" in linked), JSON.stringify(linked))
      const session = world.store.thread(ThreadIdSchema.parse(linked.child))!.sessions[0]!
      const started = await world.agents.start({ kind: "agent", session }, { brief: { objective: "Count the tests." }, harness: next(harness), name: "tests", clientKey: "tests", cwd: root })
      assert.ok(!("refused" in started), JSON.stringify(started))
    }
    if (point !== "none") {
      // The kill comes from a log line or a harness's hook; a run that never reaches its point fails below.
      await new Promise((resolve) => setTimeout(resolve, RUN_MS))
      return
    }
    const store = world.store
    const finished = () => store.edges().all.every((edge) => {
      if (edge.run) return edge.run.ended !== undefined
      const last = store.reportsOf(edge.child, 0).at(-1)
      return last?.status === "done" || last?.status === "failed"
    })
    // A followed run's end waits for its session to stay quiet.
    await until("the tree to settle", () => store.undeliveredReports().length === 0 && store.queuedSpawns().length === 0 && finished(), 20_000 + END_CONFIRM_MS)
    await world.settle()
    const settled: Settled = {
      edges: store.edges().all.map((edge) => ({
        name: edge.name,
        child: edge.child,
        parent: edge.parent,
        op: edge.op,
        conversations: store.thread(edge.child)!.sessions.flatMap((session) => store.conversationsOf(session)),
        reports: store.reportsOf(edge.child, 0).map((report) => ({ id: report.id, status: report.status, summary: report.summary })),
      })),
      undelivered: store.undeliveredReports().length,
      queued: store.queuedSpawns().length,
    }
    writeFileSync(join(root, "settled.json"), JSON.stringify(settled))
  } finally {
    await world.close()
  }
}

// ── The runs ──

function run(args: string[]): Promise<{ code: number | null; signal: NodeJS.Signals | null; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--import", "tsx", import.meta.filename, "--host", ...args], { stdio: ["ignore", "ignore", "pipe"] })
    let stderr = ""
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString() })
    const timer = setTimeout(() => child.kill("SIGKILL"), RUN_MS + 30_000)
    child.on("exit", (code, signal) => {
      clearTimeout(timer)
      resolve({ code, signal, stderr })
    })
  })
}

/** What every run must end with, whatever the kill cut. */
function check(root: string, point: Point): void {
  const settled: Settled = JSON.parse(readFileSync(join(root, "settled.json"), "utf8"))
  const heard = lines(root)
  const state = readState(root)
  const prompts = heard.filter((line): line is Heard => line.kind !== "log")
  const reached = new Set(heard.flatMap((line) => (line.kind === "log" ? [line.message] : [])))
  const into = (conversations: readonly string[]) => prompts.filter((line) => conversations.includes(line.conversation))
  assert.equal(settled.undelivered, 0, "every report was heard")
  assert.equal(settled.queued, 0, "every start the budget held was started")
  assert.equal(new Set(settled.edges.map((edge) => edge.op)).size, settled.edges.length, "each start made one Fin")
  for (const edge of settled.edges) {
    const took = into(edge.conversations)
    const briefs = took.filter((line) => line.kind === "prompt" && line.text.includes(`You're fin:${edge.name}`))
    if (edge.op.startsWith("linked:")) continue
    assert.equal(briefs.length, 1, `${edge.name}: its brief reached its harness once`)
    assert.equal(edge.reports.at(-1)?.status, "done", `${edge.name}: it finished its work (${edge.reports.at(-1)?.summary})`)
  }
  // Each report its Apex hears is in one digest: a steer or a turn, never both and never twice.
  const digests = prompts.filter((line) => line.text.includes(FROM_AGENTS))
  for (const edge of settled.edges)
    for (const report of edge.reports) {
      const parent = settled.edges.find((each) => each.child === edge.parent)
      const conversations = parent ? parent.conversations : [state.apex]
      // By its id in the digest's own record of what it carries, as two Fins' same words aren't one report.
      const carrying = digests.filter((line) => conversations.includes(line.conversation) && line.text.split("<mako-reports>")[1]?.includes(`"report":${JSON.stringify(report.id)}`))
      assert.equal(carrying.length, 1, `${edge.name}'s report "${report.summary.slice(0, 40)}" reached its Apex once (${carrying.length})`)
    }
  if (HELD_POINTS.has(point)) {
    assert.ok(settled.edges.some((edge) => edge.name === "tests"), "the linked Apex's Fin")
    return
  }
  const names = settled.edges.map((edge) => edge.name).sort()
  if (reached.has("start queued")) assert.deepEqual(names, ["header", "sidebar"], "the held start was started")
  const sidebar = settled.edges.find((edge) => edge.name === "sidebar")
  const sent = sidebar ? into(sidebar.conversations).filter((line) => line.text.includes(SEND)).length : 0
  if (reached.has("send")) assert.equal(sent, 1, "the Apex's message reached the Fin once")
  else assert.ok(sent <= 1, "the Apex's message reached the Fin at most once")
}

async function main(): Promise<void> {
  const only = process.argv.slice(2)
  // Arguments name harnesses, kill points or both; each filter reads only the names it knows.
  const namedHarnesses = only.filter((each) => HARNESSES.some((harness) => harness === each))
  const harnesses = TESTED_HARNESSES.filter((harness) => !namedHarnesses.length || namedHarnesses.includes(harness))
  const points = POINTS.filter((point) => !only.length || only.includes(point) || !only.some((each) => POINTS.some((named) => named === each)))
  const base = mkdtempSync(join(tmpdir(), "mako-orch-crash-"))
  const failures: string[] = []
  const began = performance.now()
  let runs = 0
  try {
    for (const point of points) {
      await Promise.all(harnesses.map(async (harness) => {
        const root = join(base, `${point}-${harness}`)
        const label = `${point} on ${harness}`
        try {
          const killed = await run([root, harness, point])
          if (killed.signal !== "SIGKILL") throw new Error(`the host was never killed at ${point} (exit ${killed.code}): ${killed.stderr.slice(-600)}`)
          const state = readState(root)
          // The linked run's process ends while no host runs, as a terminal's run does.
          if (state.run) try { process.kill(state.run.pid, "SIGTERM") } catch {}
          const after = await run([root, harness, "none"])
          if (after.code !== 0) throw new Error(`the next host failed (exit ${after.code ?? after.signal}): ${after.stderr.slice(-1200)}`)
          check(root, point)
          runs += 1
        } catch (error) {
          failures.push(`${label}: ${error instanceof Error ? error.message : String(error)}`)
        }
      }))
    }
  } finally {
    if (!failures.length) rmSync(base, { recursive: true, force: true })
  }
  console.log(`orch crash: ${runs} of ${points.length * harnesses.length} runs whole in ${Math.round((performance.now() - began) / 1000)} s`)
  if (failures.length) {
    console.error(`${failures.length} failed; their stores are in ${base}:\n${failures.join("\n")}`)
    process.exit(1)
  }
  console.log("orch crash: ok")
}

if (process.argv[2] === "--host") {
  const point = process.argv[5] === "none" ? "none" : POINTS.find((each) => each === process.argv[5])
  if (!point) throw new Error(`No kill point ${process.argv[5]}`)
  await host(process.argv[3]!, process.argv[4]!, point)
} else await main()
