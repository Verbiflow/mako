import "./lib/scratch-git.mjs"
// A turn's checkpoint at the scale of the person's day (2026-11-17/18): several worktrees of a large checkout and a
// project folder of two repositories, turns starting together in waves with pauses past the history reader's idle
// time, under CPU load, beside the host's other Git reads and the other readers of the file system's history. Uses
// the real watcher child (FSEvents) and real Git. Reports, for the checkpoint before each turn, how long it took to hold
// the workspace (`heldMs`, what the turn waits on), how many went past the host's wait (`BEFORE_CHECKPOINT_WAIT_MS`)
// and so had no "before", and how many followed the last checkpoint rather than capturing afresh.
//
//   npx tsx scripts/bench-checkpoint-load.ts [--worktrees 6] [--files 6000] [--ignored 20000] [--waves 6]
//     [--gap-min 5000] [--gap-max 45000] [--burn 6] [--readers yes] [--poll yes] [--churn 0]
//     [--checkpoint-child own|shared] [--out <file>]
//
// Heavy: one at a time (`pgrep -f bench-` first). Its folder in the temporary folder is removed at the end.
import { execFileSync, spawn, type ChildProcess } from "node:child_process"
import { cpSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { cpus, loadavg, tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { fileURLToPath } from "node:url"
import { parseArgs } from "node:util"
import { Git, type RunOptions } from "@mako/git"
import { followHostLog } from "@mako/host/base/host-log"
import { childHistory, type FileHistory } from "@mako/host/workspaces/watch-backend"
import { WorkspaceSnapshots } from "@mako/host/workspaces/snapshots"

const { values } = parseArgs({
  options: {
    worktrees: { type: "string", default: "6" },
    files: { type: "string", default: "6000" },
    ignored: { type: "string", default: "20000" },
    waves: { type: "string", default: "6" },
    "gap-min": { type: "string", default: "5000" },
    "gap-max": { type: "string", default: "45000" },
    burn: { type: "string", default: String(Math.max(1, Math.floor(cpus().length / 2))) },
    readers: { type: "string", default: "yes" },
    poll: { type: "string", default: "yes" },
    churn: { type: "string", default: "0" },
    seed: { type: "string", default: "7" },
    child: { type: "string" },
    // `own`: the checkpoints read history in a child of their own, as the host does (`Workspaces.checkpointHistory`);
    // `shared`: in the child every other reader uses, as it did before.
    "checkpoint-child": { type: "string", default: "own" },
    out: { type: "string" },
  },
})
const WORKTREES = Number(values.worktrees), FILES = Number(values.files), IGNORED = Number(values.ignored)
const WAVES = Number(values.waves), GAP_MIN = Number(values["gap-min"]), GAP_MAX = Number(values["gap-max"])
const BURN = Number(values.burn), READERS = values.readers === "yes", POLL = values.poll === "yes", CHURN = Number(values.churn)
/** The host's own wait before a turn goes without its checkpoint (`BEFORE_CHECKPOINT_WAIT_MS`). */
const WAIT_MS = 10_000
let seed = Number(values.seed)
const random = () => ((seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31) / 2 ** 31)

const root = realpathSync(mkdtempSync(join(tmpdir(), "mako-checkpoint-load-")))
const burners: ChildProcess[] = []
let stopping = false
const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, maxBuffer: 256 << 20 }).toString()

/** A repository of `files` tracked files in 300 folders and `ignored` files under an ignored node_modules. */
function repository(path: string, files: number): void {
  mkdirSync(path, { recursive: true })
  sh(path, "init", "-q", "-b", "main")
  sh(path, "config", "user.email", "bench@localhost")
  sh(path, "config", "user.name", "Bench")
  writeFileSync(join(path, ".gitignore"), "node_modules/\ndist/\n")
  for (let index = 0; index < files; index += 1) {
    const folder = join(path, "src", `part${index % 300}`)
    if (index < 300) mkdirSync(folder, { recursive: true })
    writeFileSync(join(folder, `file${index}.ts`), `export const value${index} = ${index}\n${"// filler line of a source file\n".repeat(40)}`)
  }
  sh(path, "add", "-A")
  sh(path, "commit", "-qm", "initial")
}

/** Ignored files, as a checkout's installed packages are: what an untracked listing must not walk into. */
function installed(path: string, files: number): void {
  for (let index = 0; index < files; index += 1) {
    const folder = join(path, "node_modules", `pkg${index % 400}`, "lib")
    if (index < 400) mkdirSync(folder, { recursive: true })
    writeFileSync(join(folder, `m${index}.js`), `module.exports = ${index}\n`)
  }
}

interface Begin { thread: string; wave: number; heldMs: number | null; savedMs: number; error?: string }
const begins: Begin[] = []
const warnings = new Map<string, number>()
const stopLog = followHostLog((line) => {
  if (line.level === "warn" || line.level === "error") warnings.set(`${line.scope}: ${line.message}`, (warnings.get(`${line.scope}: ${line.message}`) ?? 0) + 1)
})

try {
  const started = performance.now()
  const base = join(root, "repo")
  repository(base, FILES)
  installed(base, IGNORED)
  const workspaces: { name: string; cwd: string; repos: string[] }[] = []
  for (let index = 0; index < WORKTREES; index += 1) {
    const path = join(root, `wt${index}`)
    sh(base, "worktree", "add", "-q", "-b", `wt${index}`, path)
    // Each checkout has its own installed packages, cloned (APFS) rather than written again.
    cpSync(join(base, "node_modules"), join(path, "node_modules"), { recursive: true })
    workspaces.push({ name: `wt${index}`, cwd: path, repos: [path] })
  }
  // A project folder of two repositories (mako and mako-backend side by side).
  const project = join(root, "project")
  mkdirSync(project)
  sh(base, "worktree", "add", "-q", "-b", "project", join(project, "app"))
  cpSync(join(base, "node_modules"), join(project, "app", "node_modules"), { recursive: true })
  repository(join(project, "backend"), Math.round(FILES / 2))
  installed(join(project, "backend"), Math.round(IGNORED / 2))
  workspaces.push({ name: "project", cwd: project, repos: [join(project, "app"), join(project, "backend")] })
  console.log(`fixture: ${workspaces.length} workspaces, ${Math.round((performance.now() - started) / 1000)} s`)

  const git = new Git()
  const gitCalls = new Map<string, { n: number; ms: number; queued: number }>()
  const run = git.run.bind(git)
  git.run = async (options: RunOptions) => {
    const words = options.args.filter((word, index) => word !== "-c" && options.args[index - 1] !== "-c" && !word.startsWith("--literal") && !word.startsWith("--no-optional"))
    const began = performance.now()
    try {
      return await run(options)
    } finally {
      const key = (words[0] === "read-tree" || words[0] === "commit-tree" ? words.slice(0, 1) : words.slice(0, 2)).join(" ")
      const entry = gitCalls.get(key) ?? { n: 0, ms: 0, queued: 0 }
      entry.n += 1
      entry.ms += performance.now() - began
      gitCalls.set(key, entry)
    }
  }
  const script = values.child ?? fileURLToPath(new URL("../packages/host/dist/workspaces/watcher-child-main.js", import.meta.url))
  if (!existsSync(script)) throw new Error(`No compiled watcher child at ${script}: run npm run build:control-runtime first`)
  const shared = childHistory(script)
  // The checkpoints' reads, timed as the host's would be.
  const historyTimes: { what: string; ms: number }[] = []
  const timedHistory = (history: FileHistory): FileHistory => ({
    mark: async () => {
      const began = performance.now()
      try { return await history.mark() } finally { historyTimes.push({ what: "mark", ms: performance.now() - began }) }
    },
    since: async (mark, roots, options) => {
      const began = performance.now()
      try { return await history.since(mark, roots, options) } finally { historyTimes.push({ what: "since", ms: performance.now() - began }) }
    },
    ...history.recover && { recover: () => history.recover!() },
  })
  const snapshots = new WorkspaceSnapshots(git, join(root, "checkpoints"))
  snapshots.followHistory(timedHistory(values["checkpoint-child"] === "shared" ? shared : childHistory(script, undefined, undefined, 15 * 60_000)))

  // CPU load: busy processes, as builds, tests and other agents are.
  for (let index = 0; index < BURN; index += 1) burners.push(spawn(process.execPath, ["-e", "for(;;){}"], { stdio: "ignore" }))

  // The host's other readers of the same history child: the attribution journal's footprints and rescans, which read
  // from marks far back, root by root.
  const background: Promise<void>[] = []
  if (READERS) {
    const old = await shared.mark()
    background.push((async () => {
      while (!stopping) {
        for (const workspace of workspaces) for (const repo of workspace.repos) {
          if (stopping) break
          await shared.since(old, [repo], { ignore: [join(repo, "node_modules")] }).catch(() => undefined)
        }
        await delay(1500)
      }
    })())
  }
  // The host's other Git reads: windows' status of every checkout, as foreground reads.
  if (POLL) background.push((async () => {
    while (!stopping) {
      await Promise.all(workspaces.flatMap((workspace) => workspace.repos).map((repo) => git.run({ cwd: repo, args: ["status", "--porcelain=v2", "-z", "--untracked-files=all"], read: true }).catch(() => undefined)))
      await delay(2000)
    }
  })())
  // Another writer in the first worktree (a dev server's output, a formatter): `--churn` files every 100 ms.
  if (CHURN) background.push((async () => {
    let round = 0
    while (!stopping) {
      round += 1
      for (let index = 0; index < CHURN; index += 1) writeFileSync(join(workspaces[0]!.cwd, "src", `part${index % 300}`, `file${index}.ts`), `export const churned${index} = ${round}\n`)
      await delay(100)
    }
  })())

  for (let wave = 0; wave < WAVES; wave += 1) {
    await Promise.all(workspaces.map(async (workspace, index) => {
      await delay(Math.round(random() * 1500))
      const id = `${workspace.name}-${wave}`
      const began = performance.now()
      let heldAt: number | undefined
      const begin: Begin = { thread: workspace.name, wave, heldMs: null, savedMs: 0 }
      const saved = snapshots.beginRun(id, workspace.cwd, () => { heldAt ??= performance.now() })
      const held = await Promise.race([saved.then(() => "saved", () => "failed"), delay(WAIT_MS).then(() => "late"), new Promise<string>((resolve) => {
        const check = setInterval(() => { if (heldAt !== undefined) { clearInterval(check); resolve("held") } }, 5)
        void saved.finally(() => clearInterval(check)).catch(() => undefined)
      })])
      // The agent's edits: a few tracked files and a new one, in each repository, over a second or two.
      const edit = async () => {
        for (const repo of workspace.repos) {
          for (let step = 0; step < 3; step += 1) {
            writeFileSync(join(repo, "src", `part${(wave * 7 + step + index) % 300}`, `file${(wave * 7 + step + index) % 300}.ts`), `export const edited = ${wave}.${step}\n`)
            await delay(150)
          }
          writeFileSync(join(repo, "src", `new-${wave}.ts`), `export const added = ${wave}\n`)
        }
      }
      await edit()
      try {
        await saved
      } catch (error) {
        begin.error = String(error instanceof Error ? error.message : error).split("\n")[0]
      }
      begin.heldMs = heldAt === undefined ? null : Math.round(heldAt - began)
      begin.savedMs = Math.round(performance.now() - began)
      if (held === "late" && begin.heldMs !== null && begin.heldMs < WAIT_MS) begin.heldMs = WAIT_MS + 1
      begins.push(begin)
      await delay(500 + Math.round(random() * 2000))
      // As the host ends a turn: told once the closing files are read (`LiveCheckpoints.settle`).
      await snapshots.endRun(id, () => {}).catch((error: Error) => console.log(`end ${id}: ${error.message.split("\n")[0]}`))
    }))
    const gap = GAP_MIN + Math.round(random() * (GAP_MAX - GAP_MIN))
    const latest = begins.filter((begin) => begin.wave === wave).map((begin) => begin.heldMs ?? -1)
    console.log(`wave ${wave}: held ${latest.join(" ")} ms; next in ${Math.round(gap / 1000)} s; load ${loadavg()[0]!.toFixed(1)}`)
    if (wave < WAVES - 1) await delay(gap)
  }
  stopping = true
  for (const burner of burners) burner.kill()
  await Promise.all(background)

  const held = begins.map((begin) => begin.heldMs ?? Infinity).sort((a, b) => a - b)
  const at = (q: number) => held[Math.min(held.length - 1, Math.floor(q * held.length))]!
  // After the first wave, whose checkpoints are each repository's first, a whole capture whatever the history says.
  const following = begins.filter((begin) => begin.wave > 0).map((begin) => begin.heldMs ?? Infinity).sort((a, b) => a - b)
  const after = (q: number) => following[Math.min(following.length - 1, Math.floor(q * following.length))]!
  const without = begins.filter((begin) => begin.heldMs === null || begin.heldMs > WAIT_MS).length
  const quantile = (list: number[], q: number) => [...list].sort((a, b) => a - b)[Math.min(list.length - 1, Math.floor(q * list.length))] ?? null
  const marks = historyTimes.filter((time) => time.what === "mark").map((time) => time.ms), sinces = historyTimes.filter((time) => time.what === "since").map((time) => time.ms)
  const summary = {
    turns: begins.length,
    heldP50: at(0.5), heldP90: at(0.9), heldMax: held.at(-1),
    afterFirstWave: { turns: following.length, heldP50: after(0.5), heldP90: after(0.9), heldMax: following.at(-1) },
    withoutBefore: without,
    failed: begins.filter((begin) => begin.error).map((begin) => `${begin.thread}#${begin.wave}: ${begin.error}`),
    fullCaptures: gitCalls.get("ls-files --others")?.n ?? 0,
    checkpointHistory: { marks: marks.length, markP50: quantile(marks, 0.5), markMax: quantile(marks, 1), sinces: sinces.length, sinceP50: quantile(sinces, 0.5), sinceMax: quantile(sinces, 1) },
    warnings: Object.fromEntries(warnings),
    git: Object.fromEntries([...gitCalls].filter(([key]) => /^(ls-files|add|diff-files|write-tree|status|read-tree|check-ignore)/.test(key)).map(([key, entry]) => [key, { n: entry.n, avgMs: Math.round(entry.ms / entry.n) }])),
    options: { checkpointChild: values["checkpoint-child"], worktrees: WORKTREES, files: FILES, ignored: IGNORED, waves: WAVES, gap: [GAP_MIN, GAP_MAX], burn: BURN, readers: READERS, poll: POLL, churn: CHURN },
  }
  console.log(JSON.stringify(summary, null, 2))
  if (values.out) writeFileSync(values.out, JSON.stringify({ summary, begins }, null, 2))
  snapshots.close()
} finally {
  stopping = true
  stopLog()
  for (const burner of burners) burner.kill()
  rmSync(root, { recursive: true, force: true })
}
process.exit(0)
