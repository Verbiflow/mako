import { open } from "node:fs/promises"
import { z } from "zod"

/** The key Mako's instructions go under in `turn/start`'s `additionalContext`; Codex renders it `<mako>…</mako>`. */
export const PRIMER_KEY = "mako"

/** How far back a rollout is read for the primer at most; past it, the transcript is taken to lack it. */
const SCAN_LIMIT = 256 * 1024 * 1024
const CHUNK = 1024 * 1024
/** A line longer than this is skipped unread, as every reader skips one. */
const MAX_LINE = 16 * 1024 * 1024

/** What a rollout line says about the primer, read back from its end. */
type Mark = "primer" | "other-primer" | "forgot" | undefined

/** The rollout records that say something about the primer; every other line parses to nothing. */
const PrimerRecordSchema = z.union([
  z.object({ type: z.literal("compacted") }),
  z.object({ type: z.literal("event_msg"), payload: z.object({ type: z.literal("thread_rolled_back") }) }),
  z.object({
    type: z.literal("response_item"),
    payload: z.object({ type: z.literal("message"), role: z.literal("developer"), content: z.array(z.object({ text: z.string().optional() })) }),
  }),
])

function lineMark(line: string, rendered: string): Mark {
  if (!line.includes('"compacted"') && !line.includes('"thread_rolled_back"') && !line.includes(`<${PRIMER_KEY}>`)) return undefined
  let json: unknown
  try {
    json = JSON.parse(line)
  } catch {
    return undefined
  }
  const record = PrimerRecordSchema.safeParse(json)
  if (!record.success) return undefined
  if (record.data.type !== "response_item") return "forgot"
  const texts = record.data.payload.content.flatMap((part) => part.text === undefined ? [] : [part.text.trim()])
  if (!texts.some((text) => text.startsWith(`<${PRIMER_KEY}>`))) return undefined
  return texts.includes(rendered) ? "primer" : "other-primer"
}

/**
 * Whether a Codex thread's rollout already holds `value` as Mako's primer: the
 * newest `<mako>` developer message, with no compaction or rollback after it,
 * says exactly this. Read back from the file's end a chunk at a time, stopping
 * at the first that decides; a file that can't be read, or holds no such
 * message within `SCAN_LIMIT`, doesn't.
 */
export async function rolloutHoldsPrimer(path: string, value: string): Promise<boolean> {
  const rendered = `<${PRIMER_KEY}>${value}</${PRIMER_KEY}>`.trim()
  const file = await open(path, "r").catch(() => undefined)
  if (!file) return false
  try {
    const { size } = await file.stat()
    const decide = (line: Buffer): boolean | undefined => {
      const mark = lineMark(line.toString("utf8"), rendered)
      return mark === undefined ? undefined : mark === "primer"
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
  readonly value: string
  heard: boolean
  private held = false

  constructor(value: string, heard: boolean) {
    this.value = value
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
