import { readdir, realpath, stat } from "node:fs/promises"
import { join, relative, sep } from "node:path"
import { run } from "@mako/git"

/** Polling spends at most one part in this many of the time between polls. */
const DUTY = 20
const MIN_MS = 1_500
const MAX_MS = 30_000
/** Dirty files whose size and time are read each poll; past this only their status counts. */
const STAT_LIMIT = 5_000
/** Entries a folder outside Git is walked for; past this, the rest goes unheard. */
const WALK_LIMIT = 20_000
/** What a commit, checkout or reset always touches: the reflog, and the index or the branch HEAD names. */
const GIT_MARKERS = ["index", "HEAD", "logs/HEAD"]

export interface TreePoll {
  close(): void
}

type Snapshot = Map<string, string>

/**
 * Changes under `root`, found by looking rather than being told: for when a
 * watch stands but nothing is delivered, or can't be had at all. Inside a
 * repository Git already knows which files differ, so a poll is one
 * `git status` plus the size and time of each file it names, and of the
 * index and reflog for commits and checkouts; anything else is walked, up to
 * `WALK_LIMIT` entries. Paths come relative to `root`; `quiet` ones are
 * never walked. The next poll waits twenty times as long as this one took,
 * between 1.5 and 30 seconds.
 */
export function pollTree(root: string, quiet: RegExp, onChange: (paths: string[]) => void): TreePoll {
  let closed = false
  let timer: NodeJS.Timeout | undefined
  let previous: Snapshot | undefined
  // Git names paths by where they really are: /tmp is /private/tmp on macOS.
  const setup = realpath(root).catch(() => root).then(async (real) => ({ real, repository: await locate(real) }))

  const run = async () => {
    const began = performance.now()
    const { real, repository } = await setup
    const next = await (repository ? gitSnapshot(real, repository) : walkSnapshot(real, quiet)).catch(() => undefined)
    if (closed) return
    if (next && previous) {
      const changed = [...new Set([...previous.keys(), ...next.keys()])].filter((path) => previous?.get(path) !== next.get(path))
      if (changed.length) onChange(changed)
    }
    previous = next ?? previous
    timer = setTimeout(run, Math.min(MAX_MS, Math.max(MIN_MS, (performance.now() - began) * DUTY)))
    timer.unref()
  }
  void run()
  return {
    close() {
      closed = true
      clearTimeout(timer)
    },
  }
}

interface Repository {
  top: string
  gitDir: string
}

async function locate(root: string): Promise<Repository | undefined> {
  try {
    const [top, gitDir] = (await gitOutput(root, ["rev-parse", "--show-toplevel", "--absolute-git-dir"])).split("\n")
    return top && gitDir ? { top, gitDir } : undefined
  } catch {
    return undefined
  }
}

async function gitSnapshot(root: string, { top, gitDir }: Repository): Promise<Snapshot> {
  const snapshot: Snapshot = new Map()
  const fields = (await gitOutput(root, ["--no-optional-locks", "status", "--porcelain=v1", "-z", "--untracked-files=all"])).split("\0")
  const entries: [string, string][] = []
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index]
    if (!field || field.length < 4) continue
    const state = field.slice(0, 2)
    entries.push([field.slice(3), state])
    // A rename or copy names where it came from in the next field.
    if (state.includes("R") || state.includes("C")) index += 1
  }
  await Promise.all(entries.map(async ([path, state], index) => {
    const absolute = join(top, path)
    const inside = relative(root, absolute).split(sep).join("/")
    if (inside.startsWith("..")) return
    snapshot.set(inside, index < STAT_LIMIT ? `${state} ${await stamp(absolute)}` : state)
  }))
  await Promise.all(GIT_MARKERS.map(async (marker) => snapshot.set(`.git/${marker}`, await stamp(join(gitDir, marker)))))
  return snapshot
}

async function walkSnapshot(root: string, quiet: RegExp): Promise<Snapshot> {
  const files: string[] = []
  const folders = [""]
  let seen = 0
  while (folders.length && seen < WALK_LIMIT) {
    const folder = folders.pop() ?? ""
    const entries = await readdir(join(root, folder), { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (++seen > WALK_LIMIT) break
      const path = folder ? `${folder}/${entry.name}` : entry.name
      if (entry.name === ".git" || quiet.test(path)) continue
      if (entry.isDirectory()) folders.push(path)
      else files.push(path)
    }
  }
  const snapshot: Snapshot = new Map()
  for (let start = 0; start < files.length; start += 256) {
    const batch = files.slice(start, start + 256)
    const stamps = await Promise.all(batch.map((path) => stamp(join(root, path))))
    batch.forEach((path, index) => snapshot.set(path, stamps[index] ?? "gone"))
  }
  return snapshot
}

async function stamp(path: string): Promise<string> {
  try {
    const { mtimeMs, size } = await stat(path)
    return `${mtimeMs}:${size}`
  } catch {
    return "gone"
  }
}

async function gitOutput(cwd: string, args: string[]): Promise<string> {
  const result = await run({ cwd, args, background: true, read: true, maxBytes: 64 * 1024 * 1024 })
  if (result.truncated) throw new Error(`git ${args[0] ?? ""} wrote more than 64 MB`)
  return result.stdout.toString("utf8").replace(/\n$/, "")
}
