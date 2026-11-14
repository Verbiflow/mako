import "./scratch-git.mjs"
import { execFileSync, spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdirSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { constants, tmpdir } from "node:os"
import { join } from "node:path"
import { z } from "zod"
import { Git } from "@mako/git"
import { ThreadStore } from "@mako/host/threads/store"
import { ThreadWorktreeService } from "@mako/host/workspaces/thread-worktrees"

/**
 * The world `bench:host-load` runs a host in: a project folder of two repositories, Threads with worktrees of it,
 * Fins with worktrees of their Apex's, the apps those Threads ran (some still running as process groups), and
 * transcripts for every Fin, as the person's Mac had them the day the host stalled: 29 Threads in the project,
 * 23 Fins of six Apexes, 104 worktrees of the two repositories, 95 apps, about 850 processes on the machine.
 */
export interface WorldScale {
  /** Threads with a worktree of the project folder. */
  threads: number
  /** Fins of the first Apexes, each with a worktree of its Apex's worktree. */
  fins: readonly number[]
  /** Tracked files in each repository. */
  files: readonly [number, number]
  /** Apps with records, and how many of them are running. */
  apps: number
  running: number
  /** Idle processes besides, so the process table is as long as a busy Mac's. */
  processes: number
  /** Sessions in the harness stores besides the Fins' own. */
  sessions: number
}

export const TODAY: WorldScale = { threads: 29, fins: [6, 6, 4, 3, 2, 2], files: [4900, 7400], apps: 95, running: 24, processes: 600, sessions: 1200 }

export interface World {
  root: string
  home: string
  dataRoot: string
  temporary: string
  project: string
  /** Every Thread's checkout, Apexes first, with the worktree of each repository. */
  checkouts: { thread: string; session: string; path: string; repositories: string[]; fin: boolean }[]
  /** The process groups playing the running apps and the busy Mac, by their IDs. */
  fixtures: number[]
  /** Stops those groups; they also end with this process however it ends (`holdFixtures`). */
  release(): void
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
}

/** A repository of `files` tracked files in folders of fifty, as a TypeScript monorepo's look to Git and to a watcher. */
function repository(path: string, files: number): void {
  mkdirSync(path, { recursive: true })
  git(path, "init", "-q", "-b", "main")
  git(path, "config", "user.email", "load@example.invalid")
  git(path, "config", "user.name", "Load")
  writeFileSync(join(path, ".gitignore"), "node_modules/\ndist/\n.turbo/\n")
  for (let n = 0; n < files; n += 1) {
    const folder = join(path, "src", `area-${Math.floor(n / 500)}`, `part-${Math.floor(n / 50)}`)
    if (n % 50 === 0) mkdirSync(folder, { recursive: true })
    writeFileSync(join(folder, `module-${n}.ts`), `export const value${n} = ${n}\n${"// filler line for a file of a few hundred bytes\n".repeat(6)}`)
  }
  git(path, "add", "-A")
  git(path, "commit", "-q", "-m", "first")
  git(path, "commit", "-q", "--allow-empty", "-m", "second")
}

/** What a Claude Code record's message holds: a prompt's text, or blocks of text, calls and their results. */
export type ClaudeContent = string | Array<
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: { file_path: string; content: string } }
  | { type: "tool_result"; tool_use_id: string; content: string }
>

/** One Claude Code session record line, as the CLI appends them, and the record's id for the next one's parent. */
export function claudeLine(session: string, cwd: string, role: "user" | "assistant", content: ClaudeContent, parent: string | null, at = new Date()) {
  const uuid = randomUUID()
  const record = { type: role, uuid, parentUuid: parent, sessionId: session, timestamp: at.toISOString(), cwd, isSidechain: false, ...(role === "user" && { userType: "external" }), message: role === "assistant" ? { role, model: "claude-load", content } : { role, content } }
  return { line: `${JSON.stringify(record)}\n`, uuid }
}

/** Where Claude Code keeps a session started in `cwd`. */
export function claudeSessionPath(home: string, cwd: string, session: string): string {
  const folder = join(home, ".claude", "projects", cwd.replace(/[^a-zA-Z0-9-]/g, "-"))
  mkdirSync(folder, { recursive: true })
  return join(folder, `${session}.jsonl`)
}

/** Sessions of other days, a few long ones among them, so the catalog has a rail's worth to list. */
function pastSessions(home: string, project: string, count: number): void {
  for (let n = 0; n < count; n += 1) {
    const session = randomUUID()
    const path = claudeSessionPath(home, n % 3 ? project : join(project, "app"), session)
    let parent: string | null = null
    let text = ""
    // Written days ago, as a rail's past sessions were: not stores at work now.
    const at = new Date(Date.now() - ((n % 14) + 1) * 86_400_000)
    const turns = n % 50 === 0 ? 400 : 6
    for (let turn = 0; turn < turns; turn += 1) {
      const asked = claudeLine(session, project, "user", `Question ${turn} of session ${n}.`, parent, at)
      const answered = claudeLine(session, project, "assistant", [{ type: "text", text: `Answer ${turn}. ${"Detail that a real answer carries. ".repeat(20)}` }], asked.uuid, at)
      parent = answered.uuid
      text += asked.line + answered.line
    }
    writeFileSync(path, text)
    utimesSync(path, at, at)
  }
}

/**
 * How long a fixture's `sleep` lives, should nothing else end it: past any bench's run, short of a day. On
 * 2026-11-12 fixtures of `sleep 86400` that runs left behind, 3,300 processes, held this Mac past its per-user process
 * limit, and no Thread could start a process for hours.
 */
const FIXTURE_SECONDS = 2 * 60 * 60

/** Each run's fixtures, by the bench that made them, so the next run sweeps what a killed one left (`sweepLeftFixtures`). */
export const FIXTURE_RUNS = join(tmpdir(), "mako-host-load-runs")

const FixtureRunSchema = z.object({ owner: z.number().int(), groups: z.array(z.number().int()) })

/**
 * A label every fixture's command line carries, so the reaper and a sweep only ever end one of them: a POSIX extended
 * expression, which `grep -E` reads in the reaper as this reads it here.
 */
const FIXTURE_PATTERN = "^/bin/sh -c .* wait mako-load-(app|busy)-[0-9]+ "
const FIXTURE_LABEL = new RegExp(FIXTURE_PATTERN)

/** A process group that lives until the world is released: `sh` holding `sleep`s, its command line as long as a dev server's. */
function idleGroup(label: string, cwd: string, sleeps = 2) {
  const script = `${Array.from({ length: sleeps }, () => `sleep ${FIXTURE_SECONDS} &`).join(" ")} wait`
  const child = spawn("/bin/sh", ["-c", script, label, "--port", "3000", "--watch", "--config", "vite.config.ts"], { cwd, detached: true, stdio: "ignore" })
  child.unref()
  return { pid: child.pid!, stop: () => { try { process.kill(-child.pid!, "SIGKILL") } catch { /* gone */ } } }
}

/** An app's run as the host records it (`runs.json`). */
interface AppRun {
  kind: "process" | "check"
  name: string
  command: string
  cwd: string
  port?: number
  pid: number
  startedMs: number
  at: number
}

/** When the process table says `pid` started, in milliseconds, as the host reads it. */
function startedMs(pid: number): number {
  const text = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", env: { ...process.env, LC_ALL: "C" } }).trim()
  return Date.parse(text)
}

export async function makeWorld(root: string, scale: WorldScale): Promise<World> {
  const swept = sweepLeftFixtures()
  if (swept) process.stderr.write(`ended ${swept} fixture groups an earlier run left behind\n`)
  const home = join(root, "home")
  const dataRoot = join(root, "data")
  const temporary = join(root, "tmp")
  const project = join(root, "project")
  for (const folder of [home, dataRoot, temporary, project]) mkdirSync(folder, { recursive: true })
  repository(join(project, "app"), scale.files[0])
  repository(join(project, "backend"), scale.files[1])

  // Made as the host makes them, into the store the host opens: an isolated host's user root is its data root.
  const store = new ThreadStore(join(dataRoot, "threads.sqlite"))
  const runner = new Git()
  const worktrees = new ThreadWorktreeService(runner, join(dataRoot, "worktrees"), store)
  const checkouts: World["checkouts"] = []
  const make = async (cwd: string, name: string, fin: boolean) => {
    const conversation = randomUUID()
    const session = randomUUID()
    // The Session its agent writes, bound before its worktree is made, as a Thread's start binds it.
    const placed = store.registerJournal({ conversationId: conversation, createdAt: Date.now(), harness: "claude", bindings: [{ provider: "claude", nativeId: session }] }, { kind: "service", name: "migration" })
    const made = await worktrees.prepare(conversation, cwd, name)
    await worktrees.attach(conversation)
    const repositories = store.worktrees().filter((row) => row.path.startsWith(`${made.path}/`) || row.path === made.path).map((row) => row.path)
    checkouts.push({ thread: placed.thread, session, path: made.path, repositories, fin })
    return made.path
  }
  for (let n = 0; n < scale.threads; n += 1) await make(project, `thread ${n}`, false)
  const apexes = checkouts.slice(0, scale.fins.length).map((checkout) => checkout.path)
  for (const [index, count] of scale.fins.entries())
    for (let n = 0; n < count; n += 1) await make(apexes[index]!, `fin ${index}-${n}`, true)
  await worktrees.settled()
  store.close()
  await runner.close()

  pastSessions(home, project, scale.sessions)

  // The apps: each checkout's records, the first `running` with a process group up, the rest with checks that ended.
  const groups: { pid: number; stop(): void }[] = []
  const environments = join(dataRoot, "thread-environments")
  for (let n = 0; n < scale.apps; n += 1) {
    const checkout = checkouts[n % checkouts.length]!.path
    const folder = join(environments, randomUUID())
    mkdirSync(folder, { recursive: true })
    const runs: Record<string, AppRun> = {}
    const now = Date.now()
    runs["check-quick"] = { kind: "check", name: "quick", command: "npm run typecheck", cwd: checkout, pid: 1_000_000 + n, startedMs: now - 3_600_000, at: now - 3_600_000 }
    writeFileSync(join(folder, "check-quick.exit"), "0\n")
    if (n < scale.running) {
      const group = idleGroup(`mako-load-app-${n}`, checkout)
      groups.push(group)
      runs["process-web"] = { kind: "process", name: "web", command: "npm run dev", cwd: checkout, port: 41_000 + n, pid: group.pid, startedMs: startedMs(group.pid), at: now }
    }
    writeFileSync(join(folder, "runs.json"), JSON.stringify({ runs }))
    writeFileSync(join(folder, "checkout"), checkout)
    writeFileSync(join(folder, "used"), String(now))
  }
  for (let n = 0; n < scale.processes / 2; n += 1) groups.push(idleGroup(`mako-load-busy-${n}`, temporary, 1))

  return { root, home, dataRoot, temporary, project, checkouts, fixtures: groups.map((group) => group.pid), release: holdFixtures(groups) }
}

/**
 * A reaper (one `sh`, in a group of its own) that watches `owner` and, once it's gone, kills each of `pgids` whose
 * leader is still its own group's and still a fixture (`FIXTURE_PATTERN`), so another program's group, one that took a
 * fixture's ID since, is never touched. It gives up after `seconds`, when the fixtures' sleeps have ended anyway.
 */
export function reapWhenGone(owner: number, pgids: readonly number[], seconds = FIXTURE_SECONDS) {
  const script = [
    'owner=$1; pattern=$2; until=$(( $(date +%s) + $3 )); shift 3',
    'while kill -0 "$owner" 2>/dev/null; do [ "$(date +%s)" -ge "$until" ] && exit 0; sleep 2; done',
    'for g in "$@"; do',
    '  [ "$(ps -o pgid= -p "$g" 2>/dev/null | tr -d " ")" = "$g" ] || continue',
    // No `--`: dash's `kill` (Ubuntu's /bin/sh) refuses it, and a group after `-KILL` is an operand in every sh.
    '  ps -o command= -p "$g" 2>/dev/null | grep -Eq "$pattern" && kill -KILL "-$g" 2>/dev/null',
    'done',
  ].join("\n")
  const reaper = spawn("/bin/sh", ["-c", script, "mako-load-reaper", String(owner), FIXTURE_PATTERN, String(seconds), ...pgids.map(String)], { detached: true, stdio: "ignore" })
  reaper.unref()
  return reaper
}

/**
 * The fixtures end with this bench however it ends. `release`, the process's exit (an uncaught error's too) and a
 * signal stop them here; a reaper (`reapWhenGone`) stops them when this process dies, killed included; the run's record
 * lets the next run sweep them should the reaper be killed too; and their sleeps end after `FIXTURE_SECONDS` whatever
 * happens.
 */
function holdFixtures(groups: { pid: number; stop(): void }[]): () => void {
  const pgids = groups.map((group) => group.pid)
  const reaper = reapWhenGone(process.pid, pgids)
  mkdirSync(FIXTURE_RUNS, { recursive: true })
  const record = join(FIXTURE_RUNS, `${process.pid}-${randomUUID()}.json`)
  writeFileSync(record, JSON.stringify({ owner: process.pid, groups: pgids }))
  let released = false
  const release = () => {
    if (released) return
    released = true
    for (const group of groups) group.stop()
    try { process.kill(-reaper.pid!, "SIGKILL") } catch { /* gone */ }
    rmSync(record, { force: true })
  }
  process.once("exit", release)
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const)
    process.once(signal, () => {
      release()
      // Ends as the signal would have: raising it again isn't enough under tsx, whose own listener takes it.
      process.exit(128 + constants.signals[signal])
    })
  return release
}

/**
 * Ends what runs whose bench is gone left behind, by their records: only a group whose leader is still one of these
 * fixtures (`FIXTURE_LABEL`), so a reused process ID is never another's. Returns how many groups it ended.
 */
export function sweepLeftFixtures(records = FIXTURE_RUNS): number {
  let files: string[]
  try {
    files = readdirSync(records).filter((name) => name.endsWith(".json"))
  } catch {
    return 0
  }
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0)
      return true
    } catch (error) {
      return !(error instanceof Error && "code" in error && error.code === "ESRCH")
    }
  }
  const left = files.flatMap((name): { name: string; groups: number[] }[] => {
    try {
      const { owner, groups } = FixtureRunSchema.parse(JSON.parse(readFileSync(join(records, name), "utf8")))
      return alive(owner) ? [] : [{ name, groups }]
    } catch {
      return [{ name, groups: [] }]
    }
  })
  if (!left.length) return 0
  // Each group's leader: a process whose ID is its group's.
  const leaders = new Map(execFileSync("/bin/ps", ["-axo", "pid=,pgid=,command="], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)
    return match && match[1] === match[2] ? [[Number(match[1]), match[3]!] as const] : []
  }))
  let ended = 0
  for (const { name, groups } of left) {
    for (const pgid of groups) {
      if (!FIXTURE_LABEL.test(leaders.get(pgid) ?? "")) continue
      try {
        process.kill(-pgid, "SIGKILL")
        ended += 1
      } catch { /* gone */ }
    }
    rmSync(join(records, name), { force: true })
  }
  return ended
}
