/**
 * Replays a recorded stretch of work in one checkout through the attribution
 * tracker, in time order, and scores who it says wrote each change and each
 * line against what is known to have written it.
 *
 *   npx tsx scripts/attribution-replay.ts <case folder> [--out <file>] [--checkpoints <ms,ms,...>]
 *
 * The tracker runs on fake ports: a clock the replay moves, a file system
 * that is the checkout's base commit (read from its Git objects, never from
 * its working tree) plus every version the timeline writes, and an event
 * source the replay fires. The checkout's repository is only read.
 *
 * A case folder holds (none of it belongs in this repository: it is built
 * from a person's own sessions):
 * - `case.json`: `{ repo, base, t0, t1 }`, the checkout, its HEAD at `t0`;
 * - `baseline.json`: `{ path: content | null }`, files that differed from the
 *   base when tracking began;
 * - `timeline.jsonl`: one event a line, in time order, each with `at`:
 *   - `turn` / `call` with `edge`: a Session's turn or tool call starting or ending;
 *   - `report`: a call's reported effects (`ReportedCall` fields);
 *   - `write`: a file's new content (`null` when deleted) and its `truth`:
 *     `{ kind: "agent", thread }`, `{ kind: "drift", id }` (no call reported
 *     it; `labels.json` may say whose it is) or `{ kind: "synthetic" }` (a
 *     stand-in for content the record can't give, scored nowhere);
 *   - `head`: HEAD moved to `commit`.
 * - `labels.json` (optional): `{ "<drift id>": "<thread>" | "person" | "unknown" }`.
 */
import { ReportedCallSchema, type ActivityMark, type Attribution, type TrackerChangeListener, type TrackerFileStat, type TrackerPorts } from "@mako/protocol"
import { LaptopTracker, type TrackerRepository } from "@mako/host/attribution/tracker"
import { partition, storedView } from "@mako/host/attribution/queries"
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { z } from "zod"

const TruthSchema = z.object({
  kind: z.enum(["agent", "drift", "synthetic"]),
  thread: z.string().nullish(),
  id: z.number().nullish(),
  how: z.string().nullish(),
})
type Truth = z.infer<typeof TruthSchema>

const Edge = z.enum(["start", "end"])
const Optional = z.string().nullish().transform((value) => value ?? undefined)
/** One line of `timeline.jsonl`; fields a builder left null read as absent. */
const TimelineEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.enum(["turn", "background"]), edge: Edge, at: z.number(), thread: z.string(), session: z.string(), id: z.string(), cwd: Optional }),
  z.object({
    type: z.literal("call"),
    edge: Edge,
    at: z.number(),
    thread: z.string(),
    session: z.string(),
    id: z.string(),
    turn: Optional,
    cwd: Optional,
    label: Optional,
    named: z.array(z.string()).nullish(),
    status: Optional,
  }),
  z.object({
    type: z.literal("report"),
    at: z.number(),
    thread: z.string(),
    session: z.string(),
    call: z.string(),
    turn: Optional,
    startedAt: z.number().nullish().transform((value) => value ?? undefined),
    endedAt: z.number().nullish().transform((value) => value ?? undefined),
    status: z.enum(["completed", "failed", "refused", "running"]),
    effects: z.array(z.unknown()),
  }),
  z.object({ type: z.literal("write"), at: z.number(), path: z.string(), content: z.string().nullable(), truth: TruthSchema }),
  z.object({ type: z.literal("head"), at: z.number(), commit: z.string(), op: Optional }),
  z.object({ type: z.literal("outside"), at: z.number(), path: z.string(), thread: z.string() }),
])
type TimelineEvent = z.infer<typeof TimelineEventSchema>

const CaseFileSchema = z.object({ name: z.string(), repo: z.string(), base: z.string(), t0: z.number(), t1: z.number() })
const ExitStatus = z.object({ status: z.number() })

const args = process.argv.slice(2)
const folder = args[0]
if (!folder) {
  console.error("usage: tsx scripts/attribution-replay.ts <case folder> [--out <file>]")
  process.exit(64)
}
const option = (name: string) => {
  const at = args.indexOf(name)
  return at >= 0 ? args[at + 1] : undefined
}

/** A case file, parsed by its schema; `fallback` when the case doesn't have it. */
const readCase = <T extends z.ZodType>(name: string, schema: T, fallback?: z.infer<T>): z.infer<T> =>
  fallback !== undefined && !existsSync(join(folder, name)) ? fallback : schema.parse(JSON.parse(readFileSync(join(folder, name), "utf8")))
const kase = readCase("case.json", CaseFileSchema)
const baseline = readCase("baseline.json", z.record(z.string(), z.string().nullable()), {})
const labels = readCase("labels.json", z.record(z.string(), z.string()), {})
const timeline = readFileSync(join(folder, "timeline.jsonl"), "utf8")
  .split("\n")
  .filter(Boolean)
  .map((line) => TimelineEventSchema.parse(JSON.parse(line)))
const repoPath = kase.repo.replace(/\/$/, "")
const encoder = new TextEncoder()
const decoder = new TextDecoder()

/* ------------------------------------------------------------------ git, read only */

class GitObjects {
  private readonly child: ChildProcessWithoutNullStreams
  private buffer = Buffer.alloc(0)
  private readonly waiting: { resolve: (bytes: Uint8Array | null) => void }[] = []
  private chain = Promise.resolve()

  constructor(repo: string) {
    this.child = spawn("git", ["-C", repo, "cat-file", "--batch"], { stdio: ["pipe", "pipe", "pipe"] })
    this.child.stdout.on("data", (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk])
      this.drain()
    })
  }

  private drain(): void {
    for (;;) {
      const waiter = this.waiting[0]
      if (!waiter) return
      const newline = this.buffer.indexOf(10)
      if (newline < 0) return
      const header = this.buffer.subarray(0, newline).toString()
      if (header.endsWith(" missing") || header.endsWith(" ambiguous")) {
        this.buffer = this.buffer.subarray(newline + 1)
        this.waiting.shift()
        waiter.resolve(null)
        continue
      }
      const size = Number(header.split(" ")[2])
      if (this.buffer.length < newline + 1 + size + 1) return
      const bytes = new Uint8Array(this.buffer.subarray(newline + 1, newline + 1 + size))
      this.buffer = this.buffer.subarray(newline + 1 + size + 1)
      this.waiting.shift()
      waiter.resolve(bytes)
    }
  }

  read(commit: string, path: string): Promise<Uint8Array | null> {
    const next = this.chain.then(
      () =>
        new Promise<Uint8Array | null>((resolve) => {
          this.waiting.push({ resolve })
          this.child.stdin.write(`${commit}:${path}\n`)
        }),
    )
    this.chain = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }

  close(): void {
    this.child.stdin.end()
  }
}

const git = (...argv: string[]) => execFileSync("git", ["-C", repoPath, ...argv], { maxBuffer: 1 << 30 }).toString()
const objects = new GitObjects(repoPath)

/** Every file at a commit with its size. */
function tree(commit: string): Map<string, number> {
  const out = new Map<string, number>()
  for (const entry of git("ls-tree", "-r", "-l", "-z", commit).split("\0")) {
    if (!entry) continue
    const tab = entry.indexOf("\t")
    const [, type, , size] = entry.slice(0, tab).split(/\s+/)
    if (type === "blob") out.set(entry.slice(tab + 1), Number(size))
  }
  return out
}

/* ------------------------------------------------------------------ fake ports */

let now = kase.t0
const baseTree = tree(kase.base)
const overlay = new Map<string, { bytes: Uint8Array | null; mtime: number; ino: number }>()
const inodes = new Map<string, number>()
const inode = (path: string) => {
  let found = inodes.get(path)
  if (found === undefined) inodes.set(path, (found = inodes.size + 1))
  return found
}
const baseAt = kase.t0 - 86_400_000
for (const [path, content] of Object.entries(baseline)) overlay.set(path, { bytes: content === null ? null : encoder.encode(content), mtime: kase.t0 - 1_000, ino: inode(path) })

const relativeOf = (absolute: string) => (absolute === repoPath ? "" : absolute.startsWith(`${repoPath}/`) ? absolute.slice(repoPath.length + 1) : undefined)
const directories = () => {
  const out = new Set<string>()
  const add = (path: string) => {
    for (let at = path.indexOf("/"); at >= 0; at = path.indexOf("/", at + 1)) out.add(path.slice(0, at))
  }
  for (const path of baseTree.keys()) if (overlay.get(path)?.bytes !== null) add(path)
  for (const [path, file] of overlay) if (file.bytes) add(path)
  return out
}
let dirCache: { at: number; dirs: Set<string> } | undefined
let writes = 0
const isDirectory = (path: string) => {
  if (!dirCache || dirCache.at !== writes) dirCache = { at: writes, dirs: directories() }
  return dirCache.dirs.has(path)
}

const fileStat = (path: string, size: number, mtime: number): TrackerFileStat => ({
  kind: "file",
  dev: 1,
  ino: inode(path),
  size,
  mode: 0o100644,
  mtimeNs: BigInt(Math.round(mtime)) * 1_000_000n,
  ctimeNs: BigInt(Math.round(mtime)) * 1_000_000n,
})

const fs: TrackerPorts["fs"] = {
  async stat(absolute) {
    const path = relativeOf(absolute)
    if (path === undefined) return null
    if (path === "") return { kind: "directory", dev: 1, ino: 0, size: 0, mode: 0o40755, mtimeNs: 0n, ctimeNs: 0n }
    const written = overlay.get(path)
    if (written) return written.bytes ? fileStat(path, written.bytes.byteLength, written.mtime) : null
    const size = baseTree.get(path)
    if (size !== undefined) return fileStat(path, size, baseAt)
    if (isDirectory(path)) return { kind: "directory", dev: 1, ino: inode(`${path}/`), size: 0, mode: 0o40755, mtimeNs: 0n, ctimeNs: 0n }
    return null
  },
  async read(absolute) {
    const path = relativeOf(absolute)
    if (!path) return null
    const written = overlay.get(path)
    if (written) return written.bytes
    return baseTree.has(path) ? objects.read(kase.base, path) : null
  },
  async walk(root, skip) {
    const under = relativeOf(root)
    if (under === undefined) return []
    const prefix = under ? `${under}/` : ""
    const all = new Set<string>()
    for (const path of baseTree.keys()) if (overlay.get(path)?.bytes !== null) all.add(path)
    for (const [path, file] of overlay) if (file.bytes) all.add(path)
    const out: string[] = []
    for (const path of all) {
      if (!path.startsWith(prefix)) continue
      const inner = path.slice(prefix.length)
      let skipped = false
      for (let at = inner.indexOf("/"); at >= 0 && !skipped; at = inner.indexOf("/", at + 1)) skipped = skip(inner.slice(0, at))
      if (!skipped) out.push(inner)
    }
    return out
  },
}

let listener: TrackerChangeListener | undefined
const events: TrackerPorts["events"] = {
  async watch(_root, heard) {
    listener = heard
    return { close: () => (listener = undefined) }
  },
  async mark() {
    return null
  },
  async since() {
    return null
  },
}

let head = kase.base
const repository: TrackerRepository = {
  async head() {
    return head
  },
  async inventory() {
    const changed = Object.keys(baseline).filter((path) => baseTree.has(path))
    const untracked = Object.entries(baseline)
      .filter(([path, content]) => !baseTree.has(path) && content !== null)
      .map(([path]) => path)
    return { tracked: [...baseTree.keys()], untracked, changed }
  },
  async ignored(paths) {
    // Today's checkout answers for the rules; a path its folders no longer reach (a folder since made a symlink) counts as not ignored.
    const check = (batch: readonly string[]): string[] => {
      if (!batch.length) return []
      try {
        return execFileSync("git", ["-C", repoPath, "check-ignore", "--no-index", "-z", "--stdin"], { input: `${batch.join("\0")}\0`, stdio: ["pipe", "pipe", "ignore"] })
          .toString()
          .split("\0")
          .filter(Boolean)
      } catch (error) {
        if (ExitStatus.safeParse(error).data?.status === 1) return []
        return batch.length === 1 ? [] : batch.flatMap((path) => check([path]))
      }
    }
    return new Set(check(paths))
  },
  read: (commit, path) => objects.read(commit, path),
  async changed(from, to) {
    if (!from) return [...tree(to).keys()]
    return git("diff", "--name-only", "-z", "--no-renames", from, to).split("\0").filter(Boolean)
  },
}

/* ------------------------------------------------------------------ the oracle: last writer per line */

/** Lines with their endings, as the tracker splits them. */
function splitLines(text: string): string[] {
  const out = text.match(/[^\n]*\n|[^\n]+$/g)
  return out ? [...out] : []
}

/** Longest common subsequence alignment by Myers' greedy algorithm: which lines of `a` survive into `b`. */
function keptLines(a: readonly string[], b: readonly string[]): Int32Array {
  // kept[j] = index in a of b[j], or -1 when b[j] is new.
  const kept = new Int32Array(b.length).fill(-1)
  let lo = 0
  while (lo < a.length && lo < b.length && a[lo] === b[lo]) kept[lo] = lo++
  let hiA = a.length
  let hiB = b.length
  while (hiA > lo && hiB > lo && a[hiA - 1] === b[hiB - 1]) kept[--hiB] = --hiA
  const n = hiA - lo
  const m = hiB - lo
  if (!n || !m) return kept
  if (n * m > 4e7) return gitKept(a, b, lo, hiA, hiB, kept)
  // Dynamic-programming LCS on the middle, from the end, so ties keep the earliest match.
  const width = m + 1
  const table = new Uint32Array((n + 1) * width)
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      table[i * width + j] = a[lo + i] === b[lo + j] ? table[(i + 1) * width + j + 1]! + 1 : Math.max(table[(i + 1) * width + j]!, table[i * width + j + 1]!)
  for (let i = 0, j = 0; i < n && j < m; ) {
    if (a[lo + i] === b[lo + j]) {
      kept[lo + j] = lo + i
      i++
      j++
    } else if (table[(i + 1) * width + j]! >= table[i * width + j + 1]!) i++
    else j++
  }
  return kept
}

/**
 * The middle `a[lo, hiA)` against `b[lo, hiB)` too large for the table: Git's
 * minimal diff aligns it, an algorithm apart from the tracker's own.
 */
function gitKept(a: readonly string[], b: readonly string[], lo: number, hiA: number, hiB: number, kept: Int32Array): Int32Array {
  const scratch = mkdtempSync(join(tmpdir(), "mako-attribution-oracle-"))
  try {
    writeFileSync(join(scratch, "a"), a.slice(lo, hiA).join(""))
    writeFileSync(join(scratch, "b"), b.slice(lo, hiB).join(""))
    let diff = ""
    try {
      execFileSync("git", ["diff", "--no-index", "--minimal", "--no-color", "-U0", "a", "b"], { cwd: scratch, maxBuffer: 1 << 30 })
    } catch (error) {
      diff = DiffOutput.parse(error).stdout.toString()
    }
    // Lines outside every hunk are kept, in order.
    let i = 0
    let j = 0
    const keepUntil = (toA: number, toB: number) => {
      for (; i < toA && j < toB; i++, j++) kept[lo + j] = lo + i
    }
    for (const match of diff.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)) {
      const removed = match[2] === undefined ? 1 : Number(match[2])
      const added = match[4] === undefined ? 1 : Number(match[4])
      // A side with no lines names the line before the hunk.
      const startA = removed ? Number(match[1]) - 1 : Number(match[1])
      const startB = added ? Number(match[3]) - 1 : Number(match[3])
      keepUntil(startA, startB)
      i = startA + removed
      j = startB + added
    }
    keepUntil(hiA - lo, hiB - lo)
    return kept
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}
/** `git diff --no-index` exits 1 when the files differ, with the diff on stdout. */
const DiffOutput = z.object({ status: z.literal(1), stdout: z.instanceof(Buffer) })

interface OracleFile {
  lines: string[]
  /** The truth behind each current line: a Thread, `drift:<id>`, `synthetic`, or null for the base. */
  authors: (string | null)[]
}

const oracle = new Map<string, OracleFile>()
/** Files a synthetic stand-in ever wrote: their line alignment says nothing about the tracker, so no line of theirs is scored. */
const standIns = new Set<string>()
const truthLabel = (truth: Truth): string => {
  if (truth.kind === "agent") return truth.thread ?? "unknown"
  if (truth.kind === "drift") {
    const label = labels[String(truth.id)]
    return label ?? `drift:${truth.id}`
  }
  return "synthetic"
}
async function oracleOf(path: string): Promise<OracleFile> {
  let found = oracle.get(path)
  if (!found) {
    const bytes = await fs.read(join(repoPath, path))
    const lines = bytes ? splitLines(decoder.decode(bytes)) : []
    const base = baseTree.has(path) ? await objects.read(kase.base, path) : null
    // Lines a dirty file already had at the start are the base's if the base has them, else nobody known.
    const baseLines = base ? splitLines(decoder.decode(base)) : []
    const kept = keptLines(baseLines, lines)
    found = { lines, authors: lines.map((_, index) => (kept[index]! >= 0 ? null : "before-tracking")) }
    oracle.set(path, found)
  }
  return found
}
/** `--trace <path>`: each write and HEAD move of one file, with how many of its lines each writer owns, on stderr. */
const traced = option("--trace")
const trace = (path: string, step: string) => {
  if (path !== traced) return
  const owners = new Map<string, number>()
  for (const author of oracle.get(path)?.authors ?? []) owners.set(author ?? "base", (owners.get(author ?? "base") ?? 0) + 1)
  console.error(`${new Date(now).toISOString()} ${path} ${step}: ${[...owners].map(([owner, count]) => `${owner.slice(0, 8)} ${count}`).join(", ")}`)
}
async function oracleWrite(path: string, content: string | null, author: string): Promise<void> {
  const file = await oracleOf(path)
  const next = content === null ? [] : splitLines(content)
  const kept = keptLines(file.lines, next)
  file.authors = next.map((_, index) => (kept[index]! >= 0 ? file.authors[kept[index]!]! : author))
  file.lines = next
  trace(path, `write by ${author.slice(0, 8)}`)
}
/** HEAD moved: lines the new commit has become base lines again. */
async function oracleRebase(commit: string): Promise<void> {
  for (const [path, file] of oracle) {
    const bytes = await objects.read(commit, path)
    const committed = bytes ? splitLines(decoder.decode(bytes)) : []
    const kept = keptLines(committed, file.lines)
    file.authors = file.authors.map((author, index) => (kept[index]! >= 0 ? null : author))
    trace(path, `HEAD ${commit.slice(0, 10)}`)
  }
}

/* ------------------------------------------------------------------ replay */

const storage = mkdtempSync(join(tmpdir(), "mako-attribution-replay-"))
const ports: TrackerPorts = { fs, events, clock: { now: () => now }, storage, device: "replay" }
const tracker = await LaptopTracker.open(ports, { repository: async () => repository })
const rootId = "r-replay"
const startedAt = performance.now()
await tracker.track({ id: rootId, path: repoPath, kind: "workspace" })
const trackMs = performance.now() - startedAt

interface Expected {
  seq: number
  path: string
  truth: Truth
  label: string
  at: number
}
const expected: Expected[] = []
const writeMs: number[] = []
const checkpoints = (option("--checkpoints") ?? "").split(",").filter(Boolean).map(Number)
let lastSeq = tracker.changes(0, 1_000_000).at(-1)?.seq ?? 0
const absolute = (path: string | undefined, cwd: string | undefined) => (!path ? undefined : path.startsWith("/") ? path : cwd ? join(cwd, path) : undefined)

/**
 * The checkout a Session's folder is in, as the host finds it (`openAttribution`): the repository the folder
 * is in, or the folder itself when it holds the repository (a project folder of several).
 */
const checkoutOf = (cwd: string | undefined) => {
  if (!cwd) return undefined
  if (cwd === repoPath || cwd.startsWith(`${repoPath}/`)) return repoPath
  return repoPath.startsWith(`${cwd}/`) && cwd !== "/" ? cwd : undefined
}
/** Each Session's folder, from its first mark that says. */
const folders = new Map<string, string>()

const markOf = (event: Extract<TimelineEvent, { type: "turn" | "background" | "call" }>): ActivityMark => {
  const mark: ActivityMark = { kind: event.type, id: event.id.slice(0, 200), edge: event.edge, at: event.at, thread: event.thread, session: event.session }
  if (event.type === "call" && event.turn) mark.turn = event.turn.slice(0, 200)
  if (event.cwd?.startsWith("/") && !folders.has(event.session)) folders.set(event.session, event.cwd)
  const cwd = folders.get(event.session)
  if (cwd) mark.cwd = cwd
  const checkout = checkoutOf(cwd)
  if (checkout) mark.checkout = checkout
  if (event.type === "call" && event.label) mark.label = event.label.slice(0, 500)
  if (event.type === "call" && event.named?.length) {
    const named = [...new Set(event.named.map((path) => absolute(path, event.cwd)).filter((path): path is string => Boolean(path)))]
    if (named.length) mark.named = named.slice(0, 256)
  }
  return mark
}

let rejected = 0
for (const event of timeline) {
  now = Math.max(now, event.at)
  switch (event.type) {
    case "turn":
    case "background":
    case "call":
      try {
        tracker.activity(markOf(event))
      } catch {
        rejected++
      }
      break
    case "report": {
      const { type: _type, at: _at, ...call } = event
      // `--reports-without-checkout`: as `openAttribution`'s `effects()` hook reports, which names no checkout.
      const checkout = args.includes("--reports-without-checkout") ? undefined : checkoutOf(folders.get(call.session))
      const parsed = ReportedCallSchema.safeParse(Object.fromEntries(Object.entries({ ...call, checkout }).filter(([, value]) => value !== undefined)))
      if (!parsed.success) {
        rejected++
        break
      }
      try {
        tracker.reported(parsed.data)
      } catch {
        rejected++
      }
      break
    }
    case "write": {
      if (event.content === "\u0000UNKNOWN") break
      const t = performance.now()
      overlay.set(event.path, { bytes: event.content === null ? null : encoder.encode(event.content), mtime: event.at, ino: inode(event.path) })
      writes++
      listener?.changed([event.path])
      await tracker.settled()
      writeMs.push(performance.now() - t)
      const label = truthLabel(event.truth)
      if (event.truth.kind === "synthetic") standIns.add(event.path)
      await oracleWrite(event.path, event.content, label)
      for (const entry of tracker.changes(lastSeq, 100_000)) {
        expected.push({ seq: entry.seq, path: entry.path, truth: event.truth, label, at: event.at })
        lastSeq = entry.seq
      }
      break
    }
    case "head":
      head = event.commit
      listener?.changed([".git/HEAD"])
      await tracker.settled()
      await oracleRebase(event.commit)
      lastSeq = tracker.changes(lastSeq, 100_000).at(-1)?.seq ?? lastSeq
      break
    case "outside":
      break
  }
  if (checkpoints.length && event.at >= checkpoints[0]!) checkpoints.shift()
}
// Let every pending change settle: move the clock past the settle window.
now += 60_000
tracker.sweep()
await tracker.settled()
const replayMs = performance.now() - startedAt

/* ------------------------------------------------------------------ scoring */

/** A truth no metric counts: content the record can't give, a change nobody could be named for, several writers at once. */
const unscoredLabel = (label: string) => label === "synthetic" || label.startsWith("drift:") || label === "unknown" || label === "mixed" || label === "before-tracking"

type Verdict = "right" | "wrong-thread" | "covered" | "not-covered" | "person-right" | "person-wrong" | "mako" | "unscored"
const verdictOf = (author: Attribution, label: string): Verdict => {
  if (unscoredLabel(label)) return "unscored"
  const truthIsPerson = label === "person"
  switch (author.certainty) {
    case "exact":
    case "named":
    case "window":
      return truthIsPerson ? "wrong-thread" : author.author.thread === label ? "right" : "wrong-thread"
    case "ambiguous":
      return author.candidates.some((candidate) => candidate.thread === label) ? "covered" : "not-covered"
    case "person":
      return truthIsPerson ? "person-right" : "person-wrong"
    case "mako":
      return "mako"
  }
}

const byCertainty: Record<string, Record<string, number>> = {}
const details: unknown[] = []
/** Every entry's verdict, compact, for drawing a review sample of agreements too. */
const verdicts: unknown[] = []
for (const item of expected) {
  const author = tracker.authorOf(item.seq)
  if (!author) continue
  const verdict = verdictOf(author, item.label)
  const row = (byCertainty[author.certainty] ??= {})
  row[verdict] = (row[verdict] ?? 0) + 1
  row.total = (row.total ?? 0) + 1
  const named = "author" in author ? author.author : undefined
  verdicts.push({ seq: item.seq, at: item.at, path: item.path, truth: item.label, how: item.truth.how, certainty: author.certainty, verdict, thread: named?.thread, call: named?.call })
  if (verdict !== "right" && verdict !== "person-right")
    details.push({ seq: item.seq, at: item.at, path: item.path, truth: item.label, how: item.truth.how, author })
}

// Lines: the tracker's last writer of each current line against the oracle's.
const lines: Record<string, number> = {}
const lineDetails: unknown[] = []
let blameMs = 0
let blamed = 0
for (const [path, file] of oracle) {
  if (standIns.has(path)) {
    lines.unscored = (lines.unscored ?? 0) + file.lines.length
    continue
  }
  const t = performance.now()
  const runs = tracker.blame(rootId, path)
  blameMs += performance.now() - t
  blamed++
  if (!runs) continue
  const engine: (Attribution | null | "base")[] = Array.from({ length: file.lines.length }, () => "base")
  for (const run of runs) for (let i = 0; i < run.length; i++) engine[run.start + i] = run.entry === null ? "base" : run.author
  file.authors.forEach((truth, index) => {
    const said = engine[index]
    let verdict: string
    if (truth === null) verdict = said === "base" ? "base-agree" : "claimed-base-line"
    else if (unscoredLabel(truth)) verdict = "unscored"
    else if (said === "base" || said === null || said === undefined) verdict = "missed"
    else verdict = `${said.certainty}:${verdictOf(said, truth)}`
    lines[verdict] = (lines[verdict] ?? 0) + 1
    if (verdict === "claimed-base-line" || verdict === "missed" || verdict.endsWith("wrong-thread") || verdict.endsWith("not-covered") || verdict.endsWith("person-wrong"))
      lineDetails.push({ path, line: index, truth, said: said === "base" ? "base" : said, text: file.lines[index]!.length })
  })
}

// Partitions: every Thread's share of the checkout, as a worktree move would take it.
const leaks: { thread: string; path: string; owner: string | null | undefined; length: number }[] = []
const threads = [...new Set(expected.map((item) => item.label).filter((label) => !unscoredLabel(label) && label !== "person"))]
const view = storedView(tracker.store)
const partitions = threads.map((thread) => {
  const result = partition(view, repoPath, thread)
  // Counted by line text: the Thread's side must hold every line the Thread last wrote, and no other writer's line beyond what the base and the Thread's own lines account for.
  let leaked = 0
  let left = 0
  let carried = 0
  const count = (lines: readonly string[]) => {
    const out = new Map<string, number>()
    for (const line of lines) out.set(line, (out.get(line) ?? 0) + 1)
    return out
  }
  for (const file of result.files) {
    const truth = oracle.get(file.path)
    if (!truth || file.thread.kind !== "text" || standIns.has(file.path)) continue
    const moved = count(splitLines(file.thread.text))
    const own = count(truth.lines.filter((_, index) => truth.authors[index] === thread))
    const others = count(truth.lines.filter((_, index) => {
      const owner = truth.authors[index]
      return owner !== null && owner !== thread && !unscoredLabel(owner)
    }))
    const kept = count(truth.lines.filter((_, index) => truth.authors[index] === null))
    for (const [line, n] of own) {
      const there = moved.get(line) ?? 0
      carried += Math.min(n, there)
      left += Math.max(0, n - there)
    }
    for (const [line, n] of others) {
      const extra = Math.min(n, Math.max(0, (moved.get(line) ?? 0) - (own.get(line) ?? 0) - (kept.get(line) ?? 0)))
      if (!extra) continue
      leaked += extra
      leaks.push({ thread, path: file.path, owner: truth.authors[truth.lines.indexOf(line)], length: line.length })
    }
  }
  return { thread, files: result.files.length, whole: result.whole.length, uncertain: result.uncertain.length, ms: Math.round(result.ms * 10) / 10, carried, left, leaked }
})

const size = (file: string) => (existsSync(file) ? statSync(file).size : 0)
const journalBytes = size(join(storage, "journal.sqlite")) + size(join(storage, "journal.sqlite-wal"))
const sorted = [...writeMs].sort((a, b) => a - b)
// The tracker's own work per flush (stat, hash, diff and journal write), without the replay's fake ports around it.
const flushWork = tracker.recent().map((flush) => flush.statMs + flush.hashMs + flush.diffMs + flush.writeMs).sort((a, b) => a - b)
const flushPct = (q: number) => Math.round((flushWork[Math.min(flushWork.length - 1, Math.floor(q * flushWork.length))] ?? 0) * 100) / 100
const pct = (q: number) => Math.round((sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0) * 100) / 100
const summary = {
  case: kase.name,
  entries: expected.length,
  rejectedMarks: rejected,
  byCertainty,
  lines,
  partitions,
  performance: {
    trackMs: Math.round(trackMs),
    replayMs: Math.round(replayMs),
    writes: writeMs.length,
    perChangeMs: { p50: pct(0.5), p90: pct(0.9), p99: pct(0.99), max: pct(1) },
    blame: { files: blamed, totalMs: Math.round(blameMs * 10) / 10 },
    rssMb: Math.round(process.memoryUsage().rss / 1e6),
    journalBytes,
    flushes: tracker.recent().length,
    flushWorkMs: { p50: flushPct(0.5), p90: flushPct(0.9), p99: flushPct(0.99), max: flushPct(1) },
  },
}
console.log(JSON.stringify(summary, null, 1))
const out = option("--out")
if (out) writeFileSync(out, JSON.stringify({ summary, details, verdicts, lineDetails: lineDetails.slice(0, 5000), leaks }, null, 1))
await tracker.close()
objects.close()
if (args.includes("--keep")) console.error(`journal kept in ${storage}`)
else rmSync(storage, { recursive: true, force: true })
