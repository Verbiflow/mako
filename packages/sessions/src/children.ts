import { open, stat } from "node:fs/promises"
import { z } from "zod"
import { recordChunks, recordEncoding, statRecord } from "./record-files.js"

/**
 * The agents a session started (Claude Code's subagents, Codex's spawned
 * threads, Grok's and Devin's subagents, Cursor's Task children, OpenCode's
 * child sessions), as the harness's own store links them to it.
 *
 * A child keeps its own transcript, beside the parent or inside the same
 * store, and the parent's tool call holds only what the child reported. The
 * reader that lists a parent's children reads what links them (sidecars,
 * index rows, the parent's lines that name a child) and never a child's
 * transcript: a child opens through its harness's reader like any session,
 * by the `path` listed here, and is followed the same way while it runs.
 *
 * A roster of agents observed live is not this list. The roster forgets
 * settled agents to stay bounded; a child stays listed for as long as its
 * harness or Mako's archive keeps its record.
 */

/**
 * How much of a child's record is on this Mac.
 * - `complete`: its record is located and reaches its end: the store says the
 *   child finished (answered, failed or was stopped) and holds what it did.
 * - `partial`: its record is located but is not shown to be whole: it is still
 *   being written, it ended without the store saying so, the harness kept
 *   only a lossy copy, or the link to the parent's call was inferred.
 * - `missing`: the parent names it and nothing on this Mac holds its record.
 */
export const ChildStateSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("complete") }),
  z.object({ kind: z.literal("partial"), reason: z.string() }),
  z.object({ kind: z.literal("missing"), reason: z.string() }),
])
export type ChildState = z.infer<typeof ChildStateSchema>

export const ChildTranscriptSchema = z.object({
  /** The harness's own id for the child: what its tool results and the live roster name it by. */
  nativeId: z.string(),
  /** The parent's tool call that started it, as the parent's transcript identifies that call (`EntryBlock.id`). */
  toolId: z.string().optional(),
  /** The child agent that started this one; unset when the session itself did. */
  spawnedBy: z.string().optional(),
  title: z.string().optional(),
  /** The agent type or profile the harness ran it as. */
  role: z.string().optional(),
  model: z.string().optional(),
  /**
   * Its transcript, opened through the harness's reader like any session's
   * path (`read`, `createFollower`, `tail`, a catalog page). Unset when missing.
   */
  path: z.string().optional(),
  state: ChildStateSchema,
  startedAt: z.string().optional(),
  updatedAt: z.string().optional(),
  /** Only Mako's archive still holds it; the harness's record is gone. */
  archived: z.literal(true).optional(),
})
export type ChildTranscript = z.infer<typeof ChildTranscriptSchema>

/** At most this many children are listed for one session, the newest kept. */
export const CHILD_LIMIT = 1024

export const ChildTranscriptsSchema = z.object({
  parent: z.object({ harness: z.string(), nativeId: z.string(), path: z.string() }),
  children: z.array(ChildTranscriptSchema).max(CHILD_LIMIT),
  /** More were found than `CHILD_LIMIT`; the oldest were left out. */
  limited: z.literal(true).optional(),
  /** Why this session's children can't be listed: its reader names none. */
  unsupported: z.string().optional(),
})
export type ChildTranscripts = z.infer<typeof ChildTranscriptsSchema>

/** `raw` parsed as JSON and read by `schema`; undefined when it is neither. */
export function parsedJson<Schema extends z.ZodType>(schema: Schema, raw: string): z.infer<Schema> | undefined {
  try {
    const parsed = schema.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data : undefined
  } catch {
    return undefined
  }
}

/** How many children are in each state, for a report or a test. */
export function childStateCounts(children: readonly ChildTranscript[]) {
  const counts = { complete: 0, partial: 0, missing: 0 }
  for (const child of children) counts[child.state.kind]++
  return counts
}

/** At most `CHILD_LIMIT` children, the newest kept, and whether any were left out. */
export type BoundedChildren = Pick<ChildTranscripts, "children" | "limited">

/** The newest `CHILD_LIMIT` children, oldest first, and whether any were left out. */
export function boundedChildren(children: ChildTranscript[]): BoundedChildren {
  if (children.length <= CHILD_LIMIT) return { children }
  const ordered = [...children].sort((left, right) => (left.startedAt ?? "").localeCompare(right.startedAt ?? ""))
  return { children: ordered.slice(-CHILD_LIMIT), limited: true }
}

/** A record line longer than this is not one that links a child, and is skipped unread. */
const MAX_MARKED_LINE = 4 * 1024 * 1024

/**
 * Call `onLine` with each complete line from `fromByte` on that holds one of
 * `markers`, decoded; every other line is passed over as bytes. A parent's
 * record can be gigabytes of tool output around a few lines that name a
 * child, and decoding each line to look at it once cost more than reading
 * the file. Returns where the last complete line ended, so a later scan
 * resumes there; a file shorter than `fromByte` was rewritten and is
 * scanned from the start.
 */
export async function scanMarkedLines(
  path: string,
  fromByte: number,
  markers: readonly string[],
  onLine: (line: string) => void
): Promise<{ nextByte: number; size: number; identity: string }> {
  const needles = markers.map((marker) => Buffer.from(marker))
  const marked = (line: Buffer) => needles.some((needle) => line.includes(needle))
  const handle = recordEncoding(path) === "plain" ? await open(path, "r") : undefined
  try {
    const info = handle ? await handle.stat() : await stat(path)
    const size = handle ? info.size : ((await statRecord(path, info))?.bytes ?? 0)
    const from = size < fromByte ? 0 : fromByte
    let consumed = from
    // The start of a line the previous chunks cut, while it stays under the cap.
    let parts: Buffer[] = []
    let held = 0
    let skipping = false
    let awaitingPrior = from > 0
    const hold = (bytes: Buffer) => {
      if (skipping) return
      if (held + bytes.length > MAX_MARKED_LINE) {
        parts = []
        held = 0
        skipping = true
      } else {
        parts.push(Buffer.from(bytes))
        held += bytes.length
      }
    }
    for await (const chunk of recordChunks(path, Math.max(0, from - 1), handle ? size : Number.MAX_SAFE_INTEGER, handle)) {
      let view = chunk.bytes
      let startByte = chunk.at
      if (awaitingPrior) {
        awaitingPrior = false
        skipping = view[0] !== 0x0a
        view = view.subarray(1)
        startByte += 1
      }
      const first = view.indexOf(0x0a)
      if (first === -1) {
        hold(view)
        continue
      }
      // The line the earlier chunks began, ended here.
      if (!skipping) {
        const line = parts.length ? Buffer.concat([...parts, view.subarray(0, first)], held + first) : view.subarray(0, first)
        if (marked(line)) onLine(line.toString("utf8"))
      }
      parts = []
      held = 0
      skipping = false
      // Whole lines: only those a marker is found in are cut out and decoded.
      const last = view.lastIndexOf(0x0a)
      const starts = new Set<number>()
      for (const needle of needles) {
        let at = view.indexOf(needle, first + 1)
        while (at !== -1 && at < last) {
          const end = view.indexOf(0x0a, at)
          starts.add(view.lastIndexOf(0x0a, at) + 1)
          at = view.indexOf(needle, end + 1)
        }
      }
      for (const lineStart of [...starts].sort((left, right) => left - right)) {
        const end = view.indexOf(0x0a, lineStart)
        if (end - lineStart <= MAX_MARKED_LINE) onLine(view.toString("utf8", lineStart, end))
      }
      consumed = startByte + last + 1
      hold(view.subarray(last + 1))
    }
    return { nextByte: consumed, size, identity: `${info.dev}:${info.ino}` }
  } finally {
    await handle?.close()
  }
}

/**
 * What one parent's marked lines say, kept between scans and carried forward
 * over only the bytes appended since. A rewritten file (smaller, or another
 * inode) is scanned again from its start. Bounded by parents held.
 */
export class MarkedLineScans<State> {
  private readonly held = new Map<string, { nextByte: number; identity: string; mark: string; state: State }>()
  private readonly markers: readonly string[]
  private readonly empty: () => State
  private readonly fold: (state: State, line: string) => void

  constructor(markers: readonly string[], empty: () => State, fold: (state: State, line: string) => void) {
    this.markers = markers
    this.empty = empty
    this.fold = fold
  }

  /** The state of `path` through its last complete line. */
  async read(path: string): Promise<State | null> {
    const info = await statRecord(path).catch(() => null)
    if (!info) {
      this.held.delete(path)
      return null
    }
    let held = this.held.get(path)
    // Rewritten in place keeps the inode; the bytes just before the mark don't.
    // A compressed record is written once, never in place.
    if (held && (held.identity !== info.identity || info.bytes < held.nextByte ||
      (info.encoding === "plain" && (await bytesBefore(path, held.nextByte)) !== held.mark)))
      held = undefined
    if (held && held.nextByte === info.bytes) return held.state
    const state = held?.state ?? this.empty()
    const scan = await scanMarkedLines(path, held?.nextByte ?? 0, this.markers, (line) => this.fold(state, line))
    this.held.delete(path)
    this.held.set(path, { nextByte: scan.nextByte, identity: scan.identity, mark: info.encoding === "plain" ? await bytesBefore(path, scan.nextByte) : "", state })
    while (this.held.size > 64) {
      const oldest = this.held.keys().next().value
      if (oldest === undefined) break
      this.held.delete(oldest)
    }
    return state
  }
}

async function bytesBefore(path: string, at: number): Promise<string> {
  if (at === 0) return ""
  const handle = await open(path, "r").catch(() => null)
  if (!handle) return ""
  try {
    const length = Math.min(64, at)
    const buffer = Buffer.allocUnsafe(length)
    const { bytesRead } = await handle.read(buffer, 0, length, at - length)
    return buffer.subarray(0, bytesRead).toString("base64")
  } finally {
    await handle.close()
  }
}
