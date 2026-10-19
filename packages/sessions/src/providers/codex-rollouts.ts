import { basename } from "node:path"
import { z } from "zod"
import { readLines, walkFiles, walkRecordFiles, type RecordSpan } from "../jsonl.js"
import { plainRecordPath } from "../record-files.js"

/**
 * Codex's rollout files, found and named as Codex finds and names them; the
 * one place the provider, its children and its records learn which file is
 * which thread's.
 *
 * A rollout is `rollout-<time>-<thread>.jsonl`, or
 * `rollout-<time>-<thread>_<rollout>.jsonl` after `thread/revert`, which
 * keeps the thread and starts a new rollout. Either may be compressed in
 * place to `.jsonl.zst` (`record-files.ts`) and archived, flattened, into
 * `archived_sessions`; a plain file hides its compressed sibling.
 *
 * A rollout may continue an earlier one: its `session_meta.history_base`
 * names that rollout and the byte its history ends at, and the thread's
 * history is that stretch, then this file. A revert continues the thread's
 * own earlier rollout; a fork continues its source's. `lineage` follows
 * those links, oldest first, as Codex's `RolloutLineage` does.
 */

const UUID = "[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}"
const ROLLOUT_NAME = new RegExp(`^rollout-.{19}-(${UUID})(?:_(${UUID}))?\\.jsonl$`, "i")
const ANY_ID = new RegExp(UUID, "i")
/** How many earlier rollouts a lineage follows; a longer one stops there, as a loop would. */
const MAX_LINEAGE = 64
/** How long a listing answers again, for the reads that each need one. */
const LISTING_MS = 5_000

/** The thread a rollout belongs to and the rollout's own id, from its file name. */
export interface RolloutName {
  thread: string
  rollout: string
}

export function rolloutName(path: string): RolloutName | undefined {
  const match = basename(plainRecordPath(path)).match(ROLLOUT_NAME)
  if (!match) return undefined
  const thread = match[1]!.toLowerCase()
  return { thread, rollout: (match[2] ?? thread).toLowerCase() }
}

/** The thread a rollout belongs to: its name's first id, else any id in it. */
export function rolloutThread(path: string): string | undefined {
  return rolloutName(path)?.thread ?? basename(path).match(ANY_ID)?.[0]?.toLowerCase()
}

const isRollout = (plainName: string) => plainName.endsWith(".jsonl")

/**
 * Of a thread's rollouts, the one Codex's state database names as current.
 * The database keeps the plain name while the file is compressed.
 */
export function namedRollout(candidates: readonly string[], named: string | undefined): string | undefined {
  if (!named) return undefined
  const plain = plainRecordPath(named)
  return candidates.find((path) => plainRecordPath(path) === plain)
}

const HistoryBase = z.object({
  thread_id: z.string().regex(ANY_ID),
  end_byte_offset: z.number().int().nonnegative(),
})
const Meta = z.object({
  type: z.literal("session_meta"),
  payload: z.object({
    id: z.string(),
    cwd: z.string().optional(),
    timestamp: z.string().optional(),
    forked_from_id: z.string().nullish(),
    /** The thread that started this one: a spawned agent's, and a review's (`source: {"subagent": "review"}`), which no spawn edge names. */
    parent_thread_id: z.string().nullish(),
    agent_nickname: z.string().nullish(),
    agent_role: z.string().nullish(),
    agent_path: z.string().nullish(),
    source: z.unknown().optional(),
    history_base: HistoryBase.nullish(),
  }),
})
export type RolloutMeta = z.infer<typeof Meta>["payload"]

/** A rollout's history, oldest first, and what of it this machine doesn't keep. */
export interface RolloutLineage {
  spans: RecordSpan[]
  /** The rollout the earliest span continues, when Codex no longer keeps it here. */
  missing?: string
}

export class CodexRollouts {
  private readonly roots: readonly string[]
  private listing: { at: number; files: Promise<string[]> } | null = null

  /** The roots in Codex's own search order: live sessions, then archived. */
  constructor(roots: readonly string[]) {
    this.roots = roots
  }

  /** Whether `path` is a rollout under these roots, in any encoding. */
  holds(path: string): boolean {
    return this.roots.some((root) => path.startsWith(`${root}/`)) && isRollout(plainRecordPath(path))
  }

  /** Every rollout, each once, in its live encoding; a listing younger than `maxAgeMs` answers again. */
  list(maxAgeMs = LISTING_MS): Promise<string[]> {
    if (this.listing && Date.now() - this.listing.at < maxAgeMs) return this.listing.files
    const files = Promise.all(this.roots.map((root) => walkRecordFiles(root, isRollout))).then((found) => found.flat())
    this.listing = { at: Date.now(), files }
    return files
  }

  /** Every file of a thread's rollouts, in every encoding: what removing it removes. */
  async filesOf(thread: string): Promise<string[]> {
    return this.filesOfThreads([thread])
  }

  /** Every file of these threads' rollouts, in every encoding, from one walk of the roots. */
  async filesOfThreads(threads: readonly string[]): Promise<string[]> {
    if (!threads.length) return []
    const wanted = new Set(threads.map((thread) => thread.toLowerCase()))
    const files = await Promise.all(this.roots.map((root) => walkFiles(root, (name) => isRollout(plainRecordPath(name)))))
    return files.flat().filter((file) => wanted.has(rolloutThread(file) ?? ""))
  }

  /** The rollout with id `rollout`, live before archived, as Codex looks it up. */
  async byRollout(rollout: string): Promise<string | undefined> {
    const wanted = rollout.toLowerCase()
    const files = await this.list()
    for (const root of this.roots) {
      const found = files.find((file) => file.startsWith(`${root}/`) && rolloutName(file)?.rollout === wanted)
      if (found) return found
    }
    return undefined
  }

  /** A rollout's `session_meta`, its first line. */
  async meta(path: string): Promise<RolloutMeta | null> {
    let first: string | undefined
    await readLines(path, 0, (line) => {
      first = line
      return false
    }).catch(() => 0)
    if (first === undefined) return null
    try {
      return Meta.safeParse(JSON.parse(first)).data?.payload ?? null
    } catch {
      return null
    }
  }

  /**
   * The rollout's whole history: each earlier rollout it continues up to the
   * byte its successor names, oldest first, then the rollout itself.
   */
  async lineage(path: string): Promise<RolloutLineage> {
    const spans: RecordSpan[] = [{ path }]
    const seen = new Set([rolloutName(path)?.rollout])
    let base = (await this.meta(path))?.history_base
    while (base && spans.length <= MAX_LINEAGE) {
      const rollout = base.thread_id.toLowerCase()
      if (seen.has(rollout)) break
      seen.add(rollout)
      const earlier = await this.byRollout(rollout)
      if (!earlier) return { spans, missing: rollout }
      spans.unshift({ path: earlier, until: base.end_byte_offset })
      base = (await this.meta(earlier))?.history_base
    }
    return { spans }
  }

  /**
   * The rollouts another thread's history continues, by thread: a thread
   * whose rollout one of them is can't go without breaking that history.
   */
  async continuedBy(threads: ReadonlySet<string>): Promise<Map<string, string>> {
    const found = new Map<string, string>()
    const files = await this.list(0)
    const ours = new Map<string, string>()
    for (const file of files) {
      const name = rolloutName(file)
      if (name && threads.has(name.thread)) ours.set(name.rollout, name.thread)
    }
    for (const file of files) {
      const name = rolloutName(file)
      if (!name || threads.has(name.thread)) continue
      const base = (await this.meta(file))?.history_base
      const owner = base ? ours.get(base.thread_id.toLowerCase()) : undefined
      if (owner) found.set(owner, name.thread)
    }
    return found
  }
}
