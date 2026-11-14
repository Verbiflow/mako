import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { Session } from "node:inspector/promises"
import { DatabaseSync } from "node:sqlite"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseArgs } from "node:util"
import { performance } from "node:perf_hooks"
import { ThreadIdSchema } from "@mako/host/contracts/thread-identity"
import { CpuProfileSchema, loopSlices } from "@mako/host/base/loop-profile"
import { AgentsWorld } from "./lib/agents-world.ts"

/**
 * How long `agents_report` holds the host's loop on a store the size of the person's (`npm run bench:agents-report`):
 * one Apex per `--trees`, `--fins` Fins under each (226 open Fins on 2026-11-12), each with `--reports` reports kept
 * before (3,570 in all that day), on a scratch host with scripted harnesses. Then a Fin reports progress and done
 * `--rounds` times while every Apex's conversation is open, as the person's are, and each call's milliseconds are
 * timed, and so is what a list's tick then reads of every Apex (its Fins' roster and what they ask of the person, as
 * `session-report` does). `--cold` restarts the host first, so no Fin's journal is in memory until something reads it;
 * `--foreign-writes` has another process's connection commit to the Thread store before each report, as the person's
 * other Mako hosts and CLIs do all day; `--cpu-prof <file>` keeps a profile of those calls and prints the longest slices by the host's own functions.
 *
 *   npm run bench:agents-report [-- --trees 6] [--fins 38] [--reports 15] [--rounds 20] [--budget-ms 0] [--cold] [--foreign-writes] [--cpu-prof <file>]
 */
const { values } = parseArgs({
  options: {
    trees: { type: "string", default: "6" },
    fins: { type: "string", default: "38" },
    reports: { type: "string", default: "15" },
    rounds: { type: "string", default: "20" },
    "budget-ms": { type: "string", default: "0" },
    "cpu-prof": { type: "string" },
    cold: { type: "boolean", default: false },
    "foreign-writes": { type: "boolean", default: false },
  },
})
const trees = Number(values.trees)
const fins = Number(values.fins)
const kept = Number(values.reports)
const rounds = Number(values.rounds)
const budgetMs = Number(values["budget-ms"])
/** Each call's milliseconds: progress and done reports, and the list's read of every Apex after each. */
interface Timings {
  progress: number[]
  done: number[]
  list: number[]
}
const root = mkdtempSync(join(tmpdir(), "mako-bench-agents-report-"))

const world = new AgentsWorld({
  root,
  script: (turn) => turn.text.includes("You're fin:") ? "Done for now." : "ok",
  budget: { running: fins * trees + 10, started: fins * trees + 10 },
})
try {
  const say = (line: string) => console.log(line)
  const started = performance.now()
  const callers: { child: string }[] = []
  for (let tree = 0; tree < trees; tree += 1) {
    const apex = await world.apex("claude", "full")
    for (let index = 0; index < fins; index += 1) {
      const name = `fin-${tree}-${index}`
      const answer = await world.agents.start(apex.caller, { brief: { objective: `Label batch ${index}` }, name, harness: "claude", cwd: world.root, clientKey: name, queue: true })
      assert.ok(!("refused" in answer), JSON.stringify(answer))
      callers.push({ child: answer.child! })
    }
    await world.settle(40, 120_000)
  }
  // Each Fin's history of reports, as a day of work leaves them.
  const store = world.store
  for (const { child } of callers)
    for (let index = 0; index < kept; index += 1)
      store.keepReport({ id: `report:${child}:old-${index}`, child: ThreadIdSchema.parse(child), status: index % 3 ? "progress" : "done", summary: `Batch ${index}: labelled ${index * 7} rows; see https://github.com/acme/app/pull/${1000 + index}.`, ownerGeneration: 1, at: Date.now() - (kept - index) * 60_000 })
  const reportsKept = callers.length * kept
  // `--cold`: a host that started since, as the person's has, holding no Fin's journal until something reads it.
  if (values.cold) await world.restart()
  say(`world: ${trees} Apexes, ${callers.length} Fins, ${reportsKept} reports kept, built in ${Math.round(performance.now() - started)} ms`)
  // A Fin reporting: its own conversation is its caller.
  const conversationOf = (child: string) => world.store.thread(ThreadIdSchema.parse(child))!.sessions.flatMap((session) => world.store.conversationsOf(session))[0]!
  const reporters = callers.slice(0, Math.min(rounds, callers.length)).map(({ child }) => ({ child, caller: world.caller(conversationOf(child)) }))
  const session = values["cpu-prof"] ? new Session() : undefined
  if (session) {
    session.connect()
    await session.post("Profiler.setSamplingInterval", { interval: 500 })
    await session.post("Profiler.enable")
    await session.post("Profiler.start")
  }
  const times: Timings = { progress: [], done: [], list: [] }
  // Another Mako on the same store: any commit of its own, here a title, moves the store's version under this host.
  const foreign = values["foreign-writes"] ? new DatabaseSync(join(root, "threads.sqlite")) : undefined
  foreign?.exec("PRAGMA busy_timeout=5000")
  const apexes = world.store.edges().all.map((edge) => edge.parent).filter((parent, index, all) => all.indexOf(parent) === index)
  const apexConversations = apexes.map((thread) => world.store.thread(ThreadIdSchema.parse(thread))!.sessions.flatMap((session) => world.store.conversationsOf(session))[0]!)
  const listTick = () => {
    const at = performance.now()
    for (const conversation of apexConversations) {
      world.agents.roster(conversation)
      world.agents.personAsk(conversation)
    }
    times.list.push(performance.now() - at)
  }
  for (let round = 0; round < rounds; round += 1) {
    const { caller } = reporters[round % reporters.length]!
    for (const status of ["progress", "done"] as const) {
      foreign?.prepare("UPDATE threads SET title = ? WHERE id = ?").run(`Apex ${round} ${status}`, apexes[round % apexes.length]!)
      const at = performance.now()
      const answer = await world.agents.report(caller, { status, summary: `Round ${round}: ${status === "done" ? "finished" : "half way"}.`, clientKey: `round-${round}-${status}` })
      times[status].push(performance.now() - at)
      assert.ok(!("refused" in answer), JSON.stringify(answer))
      foreign?.prepare("UPDATE threads SET title = ? WHERE id = ?").run(`Apex ${round} ${status} listed`, apexes[(round + 1) % apexes.length]!)
      listTick()
    }
  }
  foreign?.close()
  if (session) {
    const { profile } = await session.post("Profiler.stop")
    writeFileSync(values["cpu-prof"]!, JSON.stringify(profile))
    const slices = loopSlices(CpuProfileSchema.parse(profile), 20, 10)
    for (const slice of slices.sort((a, b) => b.ms - a.ms).slice(0, 3)) say(`  ${slice.ms} ms: ${slice.frames.map((frame) => `${frame.frame} (${frame.ms})`).join(" < ")}`)
    session.disconnect()
  }
  const stats = (list: number[]) => {
    const sorted = [...list].sort((a, b) => a - b)
    return { p50: Math.round(sorted[Math.floor(sorted.length / 2)]!), max: Math.round(sorted.at(-1)!) }
  }
  const progress = stats(times.progress)
  const done = stats(times.done)
  const list = stats(times.list)
  say(`agents_report progress: p50 ${progress.p50} ms, max ${progress.max} ms; done: p50 ${done.p50} ms, max ${done.max} ms (${rounds} each)`)
  say(`a list's read of every Apex after one: p50 ${list.p50} ms, max ${list.max} ms`)
  const sum = (values: number[]) => Math.round(values.reduce((total, value) => total + value, 0))
  say(`total on the loop: reports ${sum([...times.progress, ...times.done])} ms, lists ${sum(times.list)} ms`)
  await world.settle(40, 120_000, "ignore")
  const worst = Math.max(progress.max, done.max, list.max)
  if (budgetMs && worst > budgetMs) {
    console.error(`over budget: a report or the list after it held the host ${worst} ms, above ${budgetMs} ms`)
    process.exitCode = 1
  }
} finally {
  await world.close()
  rmSync(root, { recursive: true, force: true })
}
