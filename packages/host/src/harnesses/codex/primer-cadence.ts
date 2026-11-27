import { open } from "node:fs/promises"
import { z } from "zod"

/** The prefix of the keys Mako's instructions go under in `turn/start`'s `additionalContext`; Codex renders each `<mako_01>…</mako_01>`. */
export const PRIMER_KEY = "mako"

/**
 * The most of one `additionalContext` value Codex shows whole: 1,000 tokens, counted as 4 bytes a token. It replaces
 * the middle of a longer one with "…387 tokens truncated…" and tells the client nothing. Mako's routes, policy and
 * server block went as one entry of about 5.9 KB until 2026-11-26, and Codex Threads lost the policy, the Fins' report
 * rule and the pull request wait rule from its middle.
 */
export const CONTEXT_ENTRY_BYTES = 4_000

/** Mako's instructions as Codex's entries, by key: `mako_01`, `mako_02`, … in the order Codex shows them, its keys' order. */
export type PrimerEntries = Readonly<Record<string, string>>

const bytes = (text: string) => Buffer.byteLength(text, "utf8")

/** A text as pieces of at most `CONTEXT_ENTRY_BYTES`: whole lines where they fit, else sentences, else as many characters as fit. */
function pieces(text: string, limit: number): string[] {
  if (bytes(text) <= limit) return [text]
  const out: string[] = []
  let piece = ""
  const add = (part: string, joiner: string) => {
    if (bytes(part) > limit) {
      if (piece) out.push(piece)
      piece = ""
      // A line too long: its sentences, each ending on its ". ", or past one too long its characters.
      const smaller = joiner === "\n" ? part.split(/(?<=\. )/) : [...part]
      for (const each of smaller.length > 1 ? smaller : [...part]) add(each, "")
      return
    }
    if (bytes(piece + joiner + part) > limit) {
      if (piece) out.push(piece)
      piece = part
    } else piece = piece ? piece + joiner + part : part
  }
  for (const line of text.split("\n")) add(line, "\n")
  if (piece) out.push(piece)
  return out
}

/**
 * Mako's blocks as Codex's `additionalContext` entries, each whole: a block that fits is one entry, a longer one
 * several, cut between lines. Keys number them in order (`mako_01`), since Codex shows entries in its keys' order.
 */
export function primerEntries(blocks: readonly string[], limit = CONTEXT_ENTRY_BYTES): PrimerEntries {
  const parts = blocks.flatMap((block) => pieces(block, limit))
  return Object.fromEntries(parts.map((part, index) => [`${PRIMER_KEY}_${String(index + 1).padStart(2, "0")}`, part]))
}

/** How far back a rollout is read for the primer at most; past it, the transcript is taken to lack it. */
const SCAN_LIMIT = 256 * 1024 * 1024
const CHUNK = 1024 * 1024
/** A line longer than this is skipped unread, as every reader skips one. */
const MAX_LINE = 16 * 1024 * 1024

/** What a rollout line says about the primer, read back from its end: forgotten, or the texts of Mako's entries it holds. */
type Mark = "forgot" | string[] | undefined

/** The rollout records that say something about the primer; every other line parses to nothing. */
const PrimerRecordSchema = z.union([
  z.object({ type: z.literal("compacted") }),
  z.object({ type: z.literal("event_msg"), payload: z.object({ type: z.literal("thread_rolled_back") }) }),
  z.object({
    type: z.literal("response_item"),
    payload: z.object({ type: z.literal("message"), role: z.literal("developer"), content: z.array(z.object({ text: z.string().optional() })) }),
  }),
])

function lineMark(line: string): Mark {
  if (!line.includes('"compacted"') && !line.includes('"thread_rolled_back"') && !line.includes(`<${PRIMER_KEY}`)) return undefined
  let json: unknown
  try {
    json = JSON.parse(line)
  } catch {
    return undefined
  }
  const record = PrimerRecordSchema.safeParse(json)
  if (!record.success) return undefined
  if (record.data.type !== "response_item") return "forgot"
  const texts = record.data.payload.content.flatMap((part) => part.text === undefined ? [] : [part.text.trim()]).filter((text) => text.startsWith(`<${PRIMER_KEY}`))
  return texts.length ? texts : undefined
}

/**
 * Whether a Codex thread's rollout already holds `entries` as Mako's primer:
 * for each key, the newest developer message under it, with no compaction or
 * rollback after it, says exactly this entry. An entry under a key Mako no
 * longer sends (an earlier build's single `<mako>`) says nothing. Read back
 * from the file's end a chunk at a time, stopping at the first line that
 * decides; a file that can't be read, or doesn't hold them all within
 * `SCAN_LIMIT`, doesn't.
 */
export async function rolloutHoldsPrimer(path: string, entries: PrimerEntries): Promise<boolean> {
  const wanted = new Map(Object.entries(entries).map(([key, value]) => [key, `<${key}>${value}</${key}>`.trim()]))
  if (!wanted.size) return true
  const file = await open(path, "r").catch(() => undefined)
  if (!file) return false
  try {
    const { size } = await file.stat()
    const decide = (line: Buffer): boolean | undefined => {
      const mark = lineMark(line.toString("utf8"))
      if (mark === undefined) return undefined
      if (mark === "forgot") return false
      for (const text of mark) {
        const key = /^<([A-Za-z0-9_]+)>/.exec(text)?.[1]
        const rendered = key === undefined ? undefined : wanted.get(key)
        if (rendered === undefined) continue
        // The newest under this key says something else: the primer changed since.
        if (text !== rendered) return false
        wanted.delete(key!)
      }
      return wanted.size ? undefined : true
    }
    let end = size
    // The end of a line whose start lies before `end`; empty while `skipping` one past `MAX_LINE`.
    let carry = Buffer.alloc(0)
    let skipping = false
    while (end > 0 && size - end < SCAN_LIMIT) {
      const start = Math.max(0, end - CHUNK)
      const chunk = Buffer.alloc(end - start)
      await file.read(chunk, 0, chunk.length, start)
      end = start
      const buffer = carry.length ? Buffer.concat([chunk, carry]) : chunk
      let cut = buffer.length
      for (let at = buffer.lastIndexOf(10, cut - 1); at >= 0; at = cut > 0 ? buffer.lastIndexOf(10, cut - 1) : -1) {
        const line = buffer.subarray(at + 1, cut)
        if (!skipping && line.length) {
          const decided = decide(line)
          if (decided !== undefined) return decided
        }
        skipping = false
        cut = at
      }
      carry = Buffer.from(buffer.subarray(0, cut))
      if (carry.length > MAX_LINE) {
        carry = Buffer.alloc(0)
        skipping = true
      }
    }
    return end === 0 && !skipping && carry.length ? decide(carry) ?? false : false
  } catch {
    return false
  } finally {
    await file.close().catch(() => undefined)
  }
}

/**
 * When Mako's primer goes with a Codex turn: once per transcript, never once
 * per process. Codex gives the model each `additionalContext` entry that
 * differs from the turn before's, and an entry left out is forgotten
 * (`AdditionalContextStore::merge` replaces the whole map), so the primer goes
 * only when the thread's transcript lacks it (`heard`: read from the rollout
 * as the thread opens, cleared by a compaction or rollback), and is left out
 * of every other turn. `held` is whether Codex's store has it from the turn
 * before, where passing it again would be skipped as unchanged: that turn
 * leaves it out, which empties the store, and the next carries it.
 */
export class CodexPrimer {
  readonly entries: PrimerEntries
  heard: boolean
  private held = false

  constructor(entries: PrimerEntries, heard: boolean) {
    this.entries = entries
    this.heard = heard
  }

  /** Whether this `turn/start` carries the primer; `started` or `failed` says how it went. */
  forTurn(): boolean {
    const send = !this.heard && !this.held
    this.held = send
    if (send) this.heard = true
    return send
  }

  /** A `turn/start` Codex refused: what it carried may not be in the transcript, and Codex may hold it. */
  failed(sent: boolean): void {
    if (!sent) return
    this.heard = false
    this.held = true
  }

  /** A steer carries no context, which empties Codex's store. */
  steered(): void {
    this.held = false
  }

  /** A compaction or rollback may have dropped it from the transcript. */
  forgot(): void {
    this.heard = false
  }
}
