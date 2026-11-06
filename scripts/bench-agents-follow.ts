import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { monitorEventLoopDelay } from "node:perf_hooks"
import type { ThreadPage, ThreadRef } from "@mako/sessions"
import type { Entry } from "@mako/sessions/entries"
import { HostJobs } from "@mako/host/base/host-jobs"
import { markedProcesses, processesHolding, processFolders } from "@mako/host/base/marked-processes"
import type { HostEvent } from "@mako/host/contracts/host-events-boot"
import { tailReadEvery, TAIL_READS_PER_SECOND } from "@mako/host/conversations/agent-runs"
import { Agents, type AgentsDeps } from "@mako/host/conversations/agents"
import { ThreadStore } from "@mako/host/threads/store"
import { noConversations } from "./lib/agents-world.ts"

/*
 * What following children costs the host (`npm run bench:agents-follow`): N = 1, 8 and 32 runs a Thread's shell
 * started, each a real process the liveness job checks and a Session that writes a step every WRITE_MS, as a busy
 * agent's does. Each N runs twice, the Sessions writing alike: once with nothing following them (before: a run started
 * with nohup, which Mako never shows) and once linked as children and followed by `Agents`. What the second costs over the first is the
 * follow's: CPU, retained heap, event-loop delay, and how long a step takes to reach the conversation's roster. Then
 * what finding a new Session's process costs, on this machine's real process table. Each budget fails the run.
 */

const WRITE_MS = 250
const RUN_MS = Number(process.env.BENCH_RUN_MS ?? 8_000)
const COUNTS = [1, 8, 32]
const BUDGET = {
  /** Of one core, at 32 agents. */
  cpuPercent: 3,
  /** Retained heap for each more agent followed, from 8 to 32. */
  heapPerAgentKb: 96,
  /** Event-loop delay the follow adds at its worst. */
  loopMaxMs: 25,
  /** A step reaches the roster within a read interval (`tailReadEvery`) and a bit. */
  latencyP95Ms: (agents: number) => tailReadEvery(agents) + 150,
  /** Tail reads across the host, whatever the number of runs (`TAIL_READS_PER_SECOND`), and a read of slack for the clock. */
  readsPerSecond: TAIL_READS_PER_SECOND + 1,
  discoveryP95Ms: 250,
}

const root = mkdtempSync(join(tmpdir(), "mako-bench-agents-follow-"))

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))] ?? 0
}

function gc(): void {
  globalThis.gc?.()
}

interface Run {
  cpuMs: number
  heapKb: number
  loopMaxMs: number
  loopP99Ms: number
  latencies: number[]
  reads: number
}

async function run(count: number, follow: boolean): Promise<Run> {
  const threads = new ThreadStore(join(root, `${count}-${follow}-${randomUUID()}.sqlite`))
  const conversation = randomUUID()
  const apex = threads.registerJournal({ conversationId: conversation, createdAt: Date.now(), harness: "codex", bindings: [] }, { kind: "service", name: "workspace" })
  const sessions = new Map<string, { ref: ThreadRef; entries: Entry[] }>()
  const subscribers = new Set<(event: HostEvent) => void>()
  let reads = 0
  const catalog: AgentsDeps["catalog"] = {
    nativePath: (identity) => [...sessions.values()].find((session) => session.ref.nativeId === identity.nativeId)?.ref.path,
    ref: (path) => sessions.get(path)?.ref,
    async page(path, before, limit = 50) {
      reads += 1
      const session = sessions.get(path)
      if (!session) return null
      const end = before ?? session.entries.length
      const start = Math.max(0, end - limit)
      return { ref: session.ref, entries: session.entries.slice(start, end), start, total: session.entries.length, hasEarlier: start > 0 } satisfies ThreadPage
    },
    activity: () => ({}),
    subscribe(subscriber) {
      subscribers.add(subscriber)
      return () => subscribers.delete(subscriber)
    },
    announce: () => {},
  }
  /** Each Session's steps not yet on the roster, oldest first: a step counts as shown once it or a later one is. */
  const pending = new Map<string, { step: number; at: number }[]>()
  const latencies: number[] = []
  let agents: Agents | undefined
  const jobs = new HostJobs()
  const shown = () => {
    const now = performance.now()
    for (const agent of agents?.roster(conversation) ?? []) {
      const step = Number(/step-(\d+)/.exec(agent.state.kind === "working" ? agent.state.activity ?? "" : "")?.[1])
      const waiting = agent.child?.nativeId ? pending.get(agent.child.nativeId) : undefined
      if (!Number.isFinite(step) || !waiting) continue
      while (waiting.length && waiting[0]!.step <= step) latencies.push(now - waiting.shift()!.at)
    }
  }
  const live = noConversations(shown)
  const pids: number[] = []
  const natives: string[] = []
  for (let index = 0; index < count; index++) {
    const nativeId = randomUUID()
    natives.push(nativeId)
    const ref: ThreadRef = { harness: "claude", nativeId, path: `/bench/${nativeId}.jsonl`, cwd: root, startedAt: new Date().toISOString() }
    sessions.set(ref.path, { ref, entries: [] })
  }
  if (follow) {
    agents = new Agents({
      store: () => threads, catalog, jobs, live,
      continueOn: () => Promise.reject(new Error("The bench moves no conversation")),
      startLive: () => Promise.reject(new Error("The bench starts no conversation")),
      harnesses: () => ["claude"], runs: () => false, harnessLabel: () => "Claude", modes: () => undefined,
    })
    for (const nativeId of natives) {
      const run = spawn("/bin/sh", ["-c", "sleep 120"], { detached: true, stdio: "ignore" })
      pids.push(run.pid!)
      const linked = await agents.link({ kind: "agent", session: apex.session }, { harness: "claude", session: nativeId, pid: run.pid! })
      assert.ok(!("refused" in linked), JSON.stringify(linked))
    }
  }
  await new Promise((resolve) => setTimeout(resolve, 300))
  gc()
  const heapBefore = process.memoryUsage().heapUsed
  const loop = monitorEventLoopDelay({ resolution: 5 })
  loop.enable()
  // What linking read is the follow's start, not its rate.
  reads = 0
  const cpuBefore = process.cpuUsage()
  let step = 0
  const writer = setInterval(() => {
    for (const session of sessions.values()) {
      step += 1
      const command = `npm run step-${step}`
      const entry: Entry = { type: "tool", id: `t${step}`, name: "Bash", input: JSON.stringify({ command }), status: "completed" }
      session.entries.push(entry)
      session.ref = { ...session.ref, updatedAt: new Date().toISOString() }
      const waiting = pending.get(session.ref.nativeId) ?? []
      waiting.push({ step, at: performance.now() })
      pending.set(session.ref.nativeId, waiting)
      for (const subscriber of subscribers) subscriber({ type: "thread-ref", ref: session.ref })
    }
  }, WRITE_MS)
  await new Promise((resolve) => setTimeout(resolve, RUN_MS))
  clearInterval(writer)
  const cpu = process.cpuUsage(cpuBefore)
  loop.disable()
  gc()
  const heapAfter = process.memoryUsage().heapUsed
  agents?.dispose()
  jobs.stop()
  for (const pid of pids) {
    try {
      process.kill(-pid, "SIGKILL")
    } catch {
      // Already gone.
    }
  }
  threads.close()
  return {
    cpuMs: (cpu.user + cpu.system) / 1_000,
    heapKb: (heapAfter - heapBefore) / 1024,
    loopMaxMs: loop.max / 1e6,
    loopP99Ms: loop.percentile(99) / 1e6,
    latencies,
    reads,
  }
}

async function discovery(): Promise<number[]> {
  const samples: number[] = []
  const signal = new AbortController().signal
  for (let index = 0; index < 20; index++) {
    const start = performance.now()
    const marked = await markedProcesses("MAKO_SESSION_ID", signal)
    const pids = marked.map((process) => process.pid).slice(0, 16)
    await processesHolding(join(root, "absent.jsonl"), pids.length ? pids : [process.pid], signal)
    await processFolders(pids.length ? pids : [process.pid], signal)
    samples.push(performance.now() - start)
  }
  return samples
}

function followLine(count: number, before: Run, after: Run, cpuPercent: number, heapKb: number, p50: number, p95: number) {
  return {
    agents: count,
    cpuPercent: Number(cpuPercent.toFixed(2)),
    heapKb: Number(heapKb.toFixed(1)),
    loopMaxMs: { before: Number(before.loopMaxMs.toFixed(1)), after: Number(after.loopMaxMs.toFixed(1)) },
    loopP99Ms: { before: Number(before.loopP99Ms.toFixed(1)), after: Number(after.loopP99Ms.toFixed(1)) },
    latencyMs: { p50: Math.round(p50), p95: Math.round(p95), samples: after.latencies.length },
    tailReadsPerSecond: Number((after.reads / (RUN_MS / 1_000)).toFixed(1)),
  }
}

const follows: Record<string, ReturnType<typeof followLine>> = {}
const heaps = new Map<number, number>()
try {
  // Loads and compiles what a host has loaded long before it follows anything.
  await run(1, true)
  for (const count of COUNTS) {
    const before = await run(count, false)
    const after = await run(count, true)
    const cpuPercent = Math.max(0, after.cpuMs - before.cpuMs) / RUN_MS * 100
    const heapKb = Math.max(0, after.heapKb - before.heapKb)
    heaps.set(count, heapKb)
    const p50 = percentile(after.latencies, 0.5)
    const p95 = percentile(after.latencies, 0.95)
    const line = followLine(count, before, after, cpuPercent, heapKb, p50, p95)
    follows[`follow${count}`] = line
    console.log(`follow ${count}: ${JSON.stringify(line)}`)
    assert.ok(after.latencies.length > 0, "steps reached the roster")
    assert.ok(line.tailReadsPerSecond <= BUDGET.readsPerSecond, `the follow reads ${line.tailReadsPerSecond} tails a second, over ${BUDGET.readsPerSecond}`)
    if (count === 32) assert.ok(cpuPercent <= BUDGET.cpuPercent, `following 32 agents costs ${cpuPercent.toFixed(2)}% of a core, over ${BUDGET.cpuPercent}%`)
    assert.ok(after.loopMaxMs - before.loopMaxMs <= BUDGET.loopMaxMs, `the follow holds the event loop ${(after.loopMaxMs - before.loopMaxMs).toFixed(1)} ms longer`)
    assert.ok(p95 <= BUDGET.latencyP95Ms(count), `a step takes ${Math.round(p95)} ms to reach the roster at p95, over ${BUDGET.latencyP95Ms(count)}`)
  }
  const heapPerAgentKb = Math.max(0, heaps.get(32)! - heaps.get(8)!) / 24
  console.log(`retained heap for each more agent: ${heapPerAgentKb.toFixed(1)} KB`)
  assert.ok(heapPerAgentKb <= BUDGET.heapPerAgentKb, `each more agent retains ${heapPerAgentKb.toFixed(1)} KB, over ${BUDGET.heapPerAgentKb}`)
  const found = await discovery()
  const discoveryLine = { p50Ms: Number(percentile(found, 0.5).toFixed(1)), p95Ms: Number(percentile(found, 0.95).toFixed(1)) }
  console.log(`discovery of a new Session's process: ${JSON.stringify(discoveryLine)}`)
  assert.ok(discoveryLine.p95Ms <= BUDGET.discoveryP95Ms, `finding a new Session's process takes ${discoveryLine.p95Ms} ms at p95`)
  console.log(`BENCH ${JSON.stringify({ budget: { ...BUDGET, latencyP95Ms: Object.fromEntries(COUNTS.map((count) => [count, BUDGET.latencyP95Ms(count)])) }, ...follows, heapPerAgentKb: Number(heapPerAgentKb.toFixed(1)), discovery: discoveryLine })}`)
} finally {
  rmSync(root, { recursive: true, force: true })
}
