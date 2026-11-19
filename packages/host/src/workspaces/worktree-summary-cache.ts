import { randomUUID } from "node:crypto"
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import { z } from "zod"
import { JsonObjectSchema, JsonValueSchema, jsonStoreAccess, unknownFields, type JsonObject } from "@mako/sessions/store-format"
import type { WorktreeBranchPull, WorktreeLanding, WorktreeStartPoint, WorktreeSummary } from "../contracts/thread-worktrees.js"
import { hostWarn } from "../base/host-log.js"

/** The format this build writes; a newer one is left as it is (`jsonStoreAccess`). */
const VERSION = 1
/**
 * Changes are written this long after the first of them: with Threads at work something changes every few seconds,
 * and the file is every answer held, written whole. What a host that dies loses of the last half minute it reads again.
 */
const SAVE_DELAY_MS = 30_000
const KNOWN = ["version", "landings", "counts", "trees", "worktrees", "pulls", "points"]

// Objects are read loose throughout: a field a newer build added stays on what's held, and goes back to the file.
const LandingSchema: z.ZodType<WorktreeLanding> = z.union([
  z.looseObject({ kind: z.literal("merged"), into: z.string() }),
  z.looseObject({ kind: z.literal("empty") }),
  z.looseObject({ kind: z.literal("open"), into: z.string(), commits: z.number() }),
  z.looseObject({ kind: z.literal("unknown") }),
])
const PullSchema: z.ZodType<WorktreeBranchPull> = z.looseObject({
  number: z.number(),
  title: z.string(),
  url: z.string(),
  branch: z.string(),
  state: z.enum(["open", "draft", "merged", "closed"]),
  head: z.string(),
  checks: z.enum(["passed", "failed", "running"]).nullable(),
})
const PullsSchema = z.array(PullSchema)
const SummarySchema: z.ZodType<WorktreeSummary> = z.looseObject({
  path: z.string(),
  into: z.string().nullable(),
  ahead: z.number(),
  changes: z.number(),
  landing: LandingSchema,
  pull: PullSchema.nullable(),
  behind: z.looseObject({ from: z.string(), commits: z.number() }).nullable(),
})
const HeldSchema = z.looseObject({
  summary: SummarySchema,
  /** When the summary was last read, and when its `status` was; 0 from a build that didn't say, which reads it again. */
  at: z.number().default(0),
  statusAt: z.number().default(0),
  /** Its index's modification time when the status was read. */
  index: z.number().default(0),
  /** The commits the summary was read at (`summaryRefs`). */
  refs: z.string().default(""),
})
export type HeldSummary = z.infer<typeof HeldSchema>

const StandingSchema: z.ZodType<WorktreeStartPoint["standing"]> = z.union([
  z.object({ kind: z.literal("level") }),
  z.object({ kind: z.literal("alone") }),
  z.object({ kind: z.literal("detached") }),
  z.object({ kind: z.literal("behind"), behind: z.number() }),
  z.object({ kind: z.literal("ahead"), ahead: z.number() }),
  z.object({ kind: z.literal("diverged"), ahead: z.number(), behind: z.number() }),
])
const PointSchema = z.looseObject({
  /** What the point was read at: the main checkout's HEAD, its branch's and upstream's commits, its configuration files' stamps. */
  key: z.string(),
  point: z.looseObject({
    from: z.string(),
    commit: z.string(),
    branch: z.string().nullable(),
    upstream: z.string().nullable(),
    standing: StandingSchema,
  }),
  tracked: z.looseObject({ remote: z.string(), ref: z.string() }).nullable(),
})
export type HeldPoint = z.infer<typeof PointSchema>

const CountSchema = z.number()
const TreeSchema = z.string()

const FileSchema = z.object({
  landings: JsonObjectSchema.default({}),
  counts: JsonObjectSchema.default({}),
  trees: JsonObjectSchema.default({}),
  worktrees: JsonObjectSchema.default({}),
  pulls: JsonObjectSchema.default({}),
  points: JsonObjectSchema.default({}),
})

/** Answers kept by the commits they depend on: a few per worktree, for far more worktrees than a Mac holds. */
const COMMIT_ANSWERS = 4096

/**
 * Answers that depend only on the commits in their key, kept while the host runs and, once they've resolved, between
 * hosts (`known`, for the file): commits never change, so each is read once whoever asks again, the least recently
 * asked let go first. A failed read isn't kept, nor one its asker turns down.
 */
export class CommitAnswers<T> {
  /** Every answer that has resolved, by its key. */
  readonly known = new Map<string, T>()
  private readonly asked = new Map<string, Promise<T>>()
  private readonly changed: () => void

  constructor(changed: () => void) {
    this.changed = changed
  }

  has(key: string): boolean {
    return this.asked.has(key)
  }

  /** The answer for `key`, read by `read` when nobody has asked yet; `keep` says whether what it read is an answer. */
  ask(key: string, read: () => Promise<T>, keep: (answer: T) => boolean = () => true): Promise<T> {
    const known = this.asked.get(key)
    if (known) {
      this.asked.delete(key)
      this.asked.set(key, known)
      return known
    }
    const reading = read()
    this.asked.set(key, reading)
    reading.then((answer) => {
      if (this.asked.get(key) !== reading) return
      if (keep(answer)) this.resolved(key, answer)
      else this.asked.delete(key)
    }, () => this.asked.delete(key))
    while (this.asked.size > COMMIT_ANSWERS) this.asked.delete(this.asked.keys().next().value!)
    return reading
  }

  /** An answer read another way, unless one is held or being read. */
  set(key: string, answer: T): void {
    if (this.asked.has(key)) return
    this.asked.set(key, Promise.resolve(answer))
    this.resolved(key, answer)
  }

  /** What an earlier host held, for the keys nothing has been asked of since. */
  restore(answers: ReadonlyMap<string, T>): void {
    for (const [key, answer] of answers) {
      if (this.asked.has(key)) continue
      this.asked.set(key, Promise.resolve(answer))
      this.known.set(key, answer)
    }
  }

  private resolved(key: string, answer: T): void {
    this.known.delete(key)
    this.known.set(key, answer)
    while (this.known.size > COMMIT_ANSWERS) this.known.delete(this.known.keys().next().value!)
    this.changed()
  }
}

/** What the summaries keep between hosts: each by what it was read at, so a start reads only what moved since. */
export interface SummaryMemory {
  /** Answers fixed by commits (`CommitAnswers`): each landing, each count of commits, each commit's tree. */
  landings: Map<string, WorktreeLanding>
  counts: Map<string, number>
  trees: Map<string, string>
  /** Each worktree's summary as last read, by its path. */
  worktrees: Map<string, HeldSummary>
  /** Each repository's pull requests as last read. */
  pulls: Map<string, WorktreeBranchPull[]>
  /** Each repository's start point, by what it depends on. */
  points: Map<string, HeldPoint>
}

const emptyMemory = (): SummaryMemory => ({ landings: new Map(), counts: new Map(), trees: new Map(), worktrees: new Map(), pulls: new Map(), points: new Map() })

function parsed<T>(entries: JsonObject, schema: z.ZodType<T>): Map<string, T> {
  const found = new Map<string, T>()
  for (const [key, value] of Object.entries(entries)) {
    const entry = schema.safeParse(value)
    if (entry.success) found.set(key, entry.data)
  }
  return found
}

/**
 * The worktree summaries' answers, kept in one JSON file beside the worktrees, so the first pass after a host starts
 * reads only the worktrees whose HEAD, index or refs moved while it was away: each answer is held by the commits, the
 * index's time or the files it was read at, and is only as good as that still being so. Read cold, a hundred worktrees
 * cost about 700 Git processes, four at a time, behind every read someone waited on.
 *
 * Every host of this user shares the file. Each writes what it holds, with whatever fields a newer build added
 * (`unknownFields`), and leaves a file in a newer format alone. Two hosts writing over each other lose nothing but
 * answers one of them reads again.
 */
export class WorktreeSummaryCache {
  private readonly file: string
  private loading: Promise<SummaryMemory> | undefined
  private rest: JsonObject = {}
  private newer = false
  private timer: NodeJS.Timeout | undefined
  private saving: Promise<void> = Promise.resolve()
  private source: (() => SummaryMemory) | undefined
  /** Its owner is closing: what's held is written once more, and nothing after it until it's followed again. */
  private stopped = false

  constructor(file: string) {
    this.file = file
  }

  /** What the file holds, read once; nothing when it's absent, torn, or a newer build's. */
  load(): Promise<SummaryMemory> {
    return this.loading ??= this.read()
  }

  private async read(): Promise<SummaryMemory> {
    const text = await readFile(this.file, "utf8").catch(() => null)
    if (text === null) return emptyMemory()
    try {
      const value = JsonValueSchema.parse(JSON.parse(text))
      if (jsonStoreAccess(value, VERSION) !== "write") {
        this.newer = true
        return emptyMemory()
      }
      const file = FileSchema.safeParse(value)
      if (!file.success) return emptyMemory()
      this.rest = unknownFields(value, KNOWN)
      return {
        landings: parsed(file.data.landings, LandingSchema),
        counts: parsed(file.data.counts, CountSchema),
        trees: parsed(file.data.trees, TreeSchema),
        worktrees: parsed(file.data.worktrees, HeldSchema),
        pulls: parsed(file.data.pulls, PullsSchema),
        points: parsed(file.data.points, PointSchema),
      }
    } catch {
      // A torn file starts over: every answer in it can be read again.
      return emptyMemory()
    }
  }

  /** Something held changed: `memory` is written soon, as it is then. */
  changed(memory: () => SummaryMemory): void {
    if (this.stopped) return
    this.source = memory
    if (this.timer || this.newer) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.flush()
    }, SAVE_DELAY_MS)
    this.timer.unref()
  }

  /** Writes what changed and takes no more changes: a pass still ending as its host stops doesn't write after it. */
  stop(): Promise<void> {
    const saved = this.flush()
    this.stopped = true
    return saved
  }

  /** Takes changes again. */
  resume(): void {
    this.stopped = false
  }

  /** Writes what changed now, and resolves once every write has finished. */
  flush(): Promise<void> {
    clearTimeout(this.timer)
    this.timer = undefined
    const source = this.source
    this.source = undefined
    if (source && !this.newer) this.saving = this.saving.then(() => this.write(source())).catch((error: Error) => hostWarn("worktrees", "the summaries' answers couldn't be saved", { error: error.message }))
    return this.saving
  }

  private async write(memory: SummaryMemory): Promise<void> {
    await this.load()
    const body = JSON.stringify({
      ...this.rest,
      version: VERSION,
      landings: Object.fromEntries(memory.landings),
      counts: Object.fromEntries(memory.counts),
      trees: Object.fromEntries(memory.trees),
      worktrees: Object.fromEntries(memory.worktrees),
      pulls: Object.fromEntries(memory.pulls),
      points: Object.fromEntries(memory.points),
    })
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 })
    const pending = `${this.file}.${randomUUID()}.tmp`
    try {
      await writeFile(pending, body, { mode: 0o600 })
      await rename(pending, this.file)
    } catch (error) {
      await rm(pending, { force: true })
      throw error
    }
  }
}
