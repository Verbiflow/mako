import "./lib/scratch-git.mjs"
// Where a turn's checkpoint spends its time on a large checkout another writer keeps changing (the Claude send bench's:
// 6,000 files, 40 of them rewritten every 100 ms): every Git command a capture runs, timed by its first words, for the
// checkpoint before a turn and after it, with and without the watcher's history the host follows. Turns alternate
// (ABBA) between a checkpoint whose add streams its blobs into a pack (`STREAMED_BLOBS`, as the host does) and one that
// writes them loose (as it did), so one run on one machine compares the two. A capture that fails is counted, not fatal.
//
//   npm run bench:checkpoint-cost -- [--turns 17] [--files 6000] [--churn 40] [--gap 3000] [--history both|yes|no] [--out <file>]
import { execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { cpus, loadavg, tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { parseArgs } from "node:util"
import { Git, type RunOptions } from "@mako/git"
import type { HistoryMark } from "@mako/host/contracts/watcher-child"
import type { FileHistory, HistoryOptions } from "@mako/host/workspaces/watch-backend"
import { WorkspaceSnapshots } from "@mako/host/workspaces/snapshots"

const { values } = parseArgs({
  options: {
    turns: { type: "string", default: "17" },
    files: { type: "string", default: "6000" },
    churn: { type: "string", default: "40" },
    gap: { type: "string", default: "3000" },
    history: { type: "string", default: "both" },
    out: { type: "string" },
  },
})
const TURNS = Number(values.turns), FILES = Number(values.files), CHURN = Number(values.churn), GAP_MS = Number(values.gap)
const HISTORY = values.history === "yes" ? [true] : values.history === "no" ? [false] : [false, true]
const STREAMING = ["-c", "core.bigFileThreshold=1"]

interface Call { what: string; ms: number }
interface Turn { turn: number; streamed: boolean; dirty: number; beginMs: number; frozenMs: number | null; endMs: number; begin: Record<string, number>; end: Record<string, number> }
interface Failure { history: boolean; turn: number; streamed: boolean; at: "begin" | "end"; error: string }
interface Arm { history: boolean; streamed: boolean; n: number; beginP50: number | null; frozenP50: number | null; endP50: number | null; beginMax: number | null }

/** Every command a capture runs, by its first two words past the `-c` settings (`ls-files --stage`, `add -A`). */
function timed(git: Git, calls: () => Call[], streamed: () => boolean): void {
  const run = git.run.bind(git)
  git.run = async (options: RunOptions) => {
    const at = options.args.indexOf(STREAMING[1]!)
    const args = !streamed() && at > 0 ? [...options.args.slice(0, at - 1), ...options.args.slice(at + 1)] : options.args
    const words = args.filter((word, index) => word !== "-c" && args[index - 1] !== "-c" && !word.startsWith("--literal"))
    const began = performance.now()
    try {
      return await run({ ...options, args })
    } finally {
      calls().push({ what: words.slice(0, 2).join(" "), ms: performance.now() - began })
    }
  }
}
const byStep = (list: readonly Call[]) => {
  const steps: Record<string, number> = {}
  for (const call of list) steps[call.what] = Math.round(((steps[call.what] ?? 0) + call.ms) * 10) / 10
  return steps
}
const median = (list: readonly number[]) => [...list].sort((a, b) => a - b)[Math.floor(list.length / 2)] ?? null
const line = (error: Error) => error.message.split("\n")[0] ?? ""

const root = realpathSync(mkdtempSync(join(tmpdir(), "mako-checkpoint-cost-")))
try {
  const project = join(root, "project")
  mkdirSync(project)
  const git = (...args: string[]) => execFileSync("git", args, { cwd: project, maxBuffer: 64 << 20 }).toString()
  git("init", "-q")
  git("config", "user.email", "bench@localhost")
  git("config", "user.name", "Bench")
  for (let index = 0; index < FILES; index += 1) {
    const folder = join(project, "src", `part${index % 300}`)
    if (index < 300) mkdirSync(folder, { recursive: true })
    writeFileSync(join(folder, `file${index}.ts`), `export const value${index} = ${index}\n${"// filler line\n".repeat(60)}`)
  }
  git("add", "-A")
  git("commit", "-qm", "initial")

  // The watcher's history as a script: every path the writer changed, numbered; a mark is the number reached.
  const heard: { at: number; path: string }[] = []
  let count = 0
  const history: FileHistory = {
    mark: async (): Promise<HistoryMark> => ({ id: String(count), at: String(BigInt(Date.now()) * 1_000_000n) }),
    since: async (mark: HistoryMark, roots: readonly string[], options?: HistoryOptions) => {
      const inside = (path: string, folder: string) => path === folder || path.startsWith(`${folder}/`)
      const changed = heard.filter((change) => change.at > Number(mark.id) && roots.some((each) => inside(change.path, each)) && !options?.exclude?.some((folder) => inside(change.path, folder)))
      return { paths: [...new Set(changed.map((change) => change.path))], lost: [], ignored: [] }
    },
  }
  let writing = true
  const writer = (async () => {
    while (writing) {
      for (let n = 0; n < CHURN; n += 1) {
        const index = Math.floor(Math.random() * FILES)
        const path = join(project, "src", `part${index % 300}`, `file${index}.ts`)
        writeFileSync(path, `export const value${index} = ${Date.now()}\n${"// churned line\n".repeat(60)}`)
        heard.push({ at: ++count, path })
      }
      await delay(100)
    }
  })()

  const loadStart = loadavg()
  const failures: Failure[] = []
  const runs: { history: boolean; turns: Turn[] }[] = []
  try {
    for (const followed of HISTORY) {
      let calls: Call[] = [], streamed = true
      const gitRunner = new Git()
      timed(gitRunner, () => calls, () => streamed)
      const store = new WorkspaceSnapshots(gitRunner, join(root, `store-${followed ? "history" : "plain"}`))
      if (followed) store.followHistory(history)
      const turns: Turn[] = []
      try {
        for (let turn = 0; turn < TURNS; turn += 1) {
          await delay(GAP_MS)
          const dirty = git("diff", "--name-only").split("\n").filter(Boolean).length
          // ABBA in fours: streamed, loose, loose, streamed.
          streamed = turn % 4 === 0 || turn % 4 === 3
          const id = randomUUID()
          calls = []
          const beginAt = performance.now()
          let frozenAt: number | undefined
          const before = await store.beginRun(id, project, () => { frozenAt ??= performance.now() }).catch((error: Error) => error)
          if (before instanceof Error) {
            store.abandonRun(id)
            failures.push({ history: followed, turn, streamed, at: "begin", error: line(before) })
            continue
          }
          const beginMs = performance.now() - beginAt, frozenMs = frozenAt === undefined ? null : Math.round(frozenAt - beginAt), begin = byStep(calls)
          await delay(500)
          calls = []
          const endAt = performance.now()
          const after = await store.endRun(id).catch((error: Error) => error)
          if (after instanceof Error) {
            failures.push({ history: followed, turn, streamed, at: "end", error: line(after) })
            continue
          }
          const entry: Turn = { turn, streamed, dirty, beginMs: Math.round(beginMs), frozenMs, endMs: Math.round(performance.now() - endAt), begin, end: byStep(calls) }
          turns.push(entry)
          console.log(`history ${followed ? "on" : "off"}, turn ${turn} ${streamed ? "streamed" : "loose"}: ${dirty} dirty; before ${entry.beginMs} ms (held at ${entry.frozenMs ?? "-"}), after ${entry.endMs} ms; add ${begin["add -A"] ?? 0} / ${entry.end["add -A"] ?? 0} ms`)
        }
      } finally {
        store.close()
        await gitRunner.close()
      }
      runs.push({ history: followed, turns })
    }
  } finally {
    writing = false
    await writer
  }
  // The first turn of each is cold (no checkpoint before it to borrow from or follow on), so it's left out.
  const arms: Arm[] = runs.flatMap(({ history: followed, turns }) => [true, false].map((streamed) => {
    const kept = turns.filter((turn) => turn.turn > 0 && turn.streamed === streamed)
    return { history: followed, streamed, n: kept.length, beginP50: median(kept.map((turn) => turn.beginMs)), frozenP50: median(kept.flatMap((turn) => turn.frozenMs ?? [])), endP50: median(kept.map((turn) => turn.endMs)), beginMax: kept.length ? Math.max(...kept.map((turn) => turn.beginMs)) : null }
  }))
  for (const arm of arms) console.log(`history ${arm.history ? "on " : "off"} ${arm.streamed ? "streamed" : "loose   "} n ${arm.n}: before p50 ${arm.beginP50} ms (max ${arm.beginMax}), held at p50 ${arm.frozenP50} ms, after p50 ${arm.endP50} ms`)
  console.log(`failed captures: ${failures.length}${failures.map((failure) => `\n  history ${failure.history ? "on" : "off"}, turn ${failure.turn} ${failure.streamed ? "streamed" : "loose"} (${failure.at}): ${failure.error}`).join("")}`)
  const load = { cores: cpus().length, start: loadStart, end: loadavg() }
  console.log(`load ${load.start[0]?.toFixed(2)} → ${load.end[0]?.toFixed(2)} on ${load.cores} cores`)
  if (values.out) writeFileSync(values.out, `${JSON.stringify({ files: FILES, churnPerTick: CHURN, gapMs: GAP_MS, load, arms, failures, runs }, null, 1)}\n`)
} finally {
  rmSync(root, { recursive: true, force: true })
}
