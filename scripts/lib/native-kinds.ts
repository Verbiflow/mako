import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import { z } from "zod"
import type { JsonValue } from "@mako/host/contracts/json"
import { decoderFor, type Recording } from "../native-decoding.ts"

/**
 * What a recorded session says that Mako has no place for yet, for the daily bump's report
 * (`scripts/bump-harness-versions.ts`): the native kinds its live decoder reports `unknown`, where in the code the
 * nearest kind it does know is placed, and what the session spent when its harness ran on its own model.
 */

const REPO = join(import.meta.dirname, "..", "..")

/**
 * Kinds a kept pair holds that its harness's decoder reports `unknown` on purpose, each with why it isn't placed yet.
 * Every other `unknown` in a recording fails the session flows and `test:decoders`: a release's new kind can't pass
 * silently, and neither can one an earlier release brought that was never placed.
 */
export const LISTED_UNKNOWN: ReadonlyMap<string, string> = new Map([
  // Live, `acp.ts` asks it on the question card (`requestElicitation`). Decoding it as an ask would load the ACP SDK's
  // elicitation schemas into the decoder, which imports only the SDK's types today: a choice for the decoder's owner.
  ["devin elicitation/create", "ACP's form request, asked live by acp.ts; the decoder can't build its questions without loading the ACP SDK"],
  // Only the kept floor pair of dev build 0.0.0-beta-19271 holds it, with no data: which of the catalogs it meant
  // (models, agents, commands, skills) isn't known, and no release sends it.
  ["opencode catalog.updated", "a dev prerelease's event (resumed-turn@0.0.0-beta-19271) that names no catalog; no release sends it"],
])

/** Why `type` is a listed unknown of `harness`, or undefined when it isn't listed. */
export const listedUnknown = (harness: string, type: string): string | undefined => LISTED_UNKNOWN.get(`${harness} ${type}`)

export interface UnknownKind {
  type: string
  reason: string
  count: number
}

/** Each kind the harness's live decoder reported `unknown` for in `recording`, with how often. */
export function unknownKinds(harness: string, recording: Recording): UnknownKind[] {
  const decoder = decoderFor(harness).open(recording.session)
  const found = new Map<string, UnknownKind>()
  for (const message of recording.messages) {
    for (const event of decoder.decode(message)) {
      if (event.kind !== "unknown") continue
      const seen = found.get(event.type) ?? { type: event.type, reason: event.reason, count: 0 }
      seen.count++
      found.set(event.type, seen)
    }
  }
  return [...found.values()]
}

export interface Placement {
  /** The known kind whose name shares the longest prefix with the new one. */
  known: string
  /** The table (the `const` it's declared in) and where. */
  table?: string
  file: string
  line: number
}

const words = (name: string) => name.split(/[./_-]+/).filter(Boolean)

/** How many leading words two kind names share. */
function shared(left: string, right: string): number {
  const a = words(left)
  const b = words(right)
  let count = 0
  while (count < a.length && count < b.length && a[count] === b[count]) count++
  return count
}

function sources(folder: string): string[] {
  if (!existsSync(folder)) return []
  return readdirSync(folder, { recursive: true }).map(String).filter((name) => name.endsWith(".ts")).map((name) => join(folder, name))
    .filter((file) => statSync(file).isFile())
}

/**
 * Where the kind nearest to `type` is placed in the harness's own decoder and reader code: the string literal sharing
 * the most leading words with it (`session.step.streamed` for `session.step.first-token`), the table it's declared
 * in, and its line. Undefined when no known kind shares even its first word.
 */
export function nearestPlacement(harness: string, type: string): Placement | undefined {
  const files = [
    ...sources(join(REPO, "packages/host/src/harnesses", harness)),
    join(REPO, "packages/sessions/src/harnesses", `${harness}.ts`),
  ].filter((file) => existsSync(file))
  let best: (Placement & { score: number }) | undefined
  for (const file of files) {
    const lines = readFileSync(file, "utf8").split("\n")
    lines.forEach((text, index) => {
      for (const match of text.matchAll(/"([\w./-]{3,})"/g)) {
        const known = match[1]!
        if (known === type) continue
        // Words shared first; between equals, the longer common start (`_x.ai/session/` over `_x.ai/session_`).
        const words = shared(known, type)
        let start = 0
        while (start < known.length && known[start] === type[start]) start++
        // A table's entry (a line that is only names) over a comparison in code: the table is where a new kind goes.
        const listed = /^\s*("[^"]+",?\s*)+(\/\/.*)?$/.test(text) ? 0.5 : 0
        const score = words + listed + start / 1000
        if (words === 0 || (best && score <= best.score)) continue
        let table: string | undefined
        for (let at = index; at >= 0 && at > index - 400; at--) {
          const declared = /^(?:export )?const (\w+)/.exec(lines[at]!)
          if (declared) {
            table = declared[1]
            break
          }
        }
        best = { known, file: relative(REPO, file), line: index + 1, score, ...table && { table } }
      }
    })
  }
  if (!best) return undefined
  const { score: _score, ...placement } = best
  return placement
}

/** Token counts a recording's own messages report, summed: what a run on the harness's own model spent. */
export const Spent = z.object({ input: z.number(), output: z.number(), cacheRead: z.number(), cacheWrite: z.number() })
export type Spent = z.infer<typeof Spent>

/** A `usage` object as Cursor's SDK (camel case) or a Messages API (snake case) writes it. */
const Usage = z.object({
  inputTokens: z.number().optional(), input_tokens: z.number().optional(),
  outputTokens: z.number().optional(), output_tokens: z.number().optional(),
  cacheReadTokens: z.number().optional(), cache_read_input_tokens: z.number().optional(),
  cacheWriteTokens: z.number().optional(), cache_creation_input_tokens: z.number().optional(),
}).loose()
const JsonObject = z.record(z.string(), z.json())

/** The `usage` objects the recorded messages carry (Cursor's SDK sends one per turn), summed. */
export function recordingSpend(recording: Recording): Spent {
  const spent: Spent = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  const walk = (value: JsonValue) => {
    if (Array.isArray(value)) return value.forEach(walk)
    const object = JsonObject.safeParse(value)
    if (!object.success) return
    for (const [key, inner] of Object.entries(object.data)) {
      const usage = key === "usage" ? Usage.safeParse(inner) : undefined
      if (!usage?.success) {
        walk(inner)
        continue
      }
      const counts = usage.data
      spent.input += counts.inputTokens ?? counts.input_tokens ?? 0
      spent.output += counts.outputTokens ?? counts.output_tokens ?? 0
      spent.cacheRead += counts.cacheReadTokens ?? counts.cache_read_input_tokens ?? 0
      spent.cacheWrite += counts.cacheWriteTokens ?? counts.cache_creation_input_tokens ?? 0
    }
  }
  recording.messages.forEach(walk)
  return spent
}

export const spentTotal = (spent: Spent) => spent.input + spent.output + spent.cacheRead + spent.cacheWrite

const PlacementSchema = z.object({ known: z.string(), table: z.string().optional(), file: z.string(), line: z.number() })

/** One finding of a decode-pairs run, written a line each to its `--report` file for the bump to read. */
export const PairFinding = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("unknown-kind"), harness: z.string(), scenario: z.string(), type: z.string(), reason: z.string(), count: z.number(), placement: PlacementSchema.optional() }),
  z.object({ kind: z.literal("unexplained"), harness: z.string(), scenario: z.string(), reader: z.string(), side: z.string(), line: z.string(), proposal: z.object({ reason: z.string(), from: z.string() }).optional() }),
  z.object({ kind: z.literal("spend"), harness: z.string(), scenario: z.string(), spent: Spent }),
  z.object({ kind: z.literal("budget"), harness: z.string(), spent: z.number(), budget: z.number(), left: z.array(z.string()) }),
])
export type PairFinding = z.infer<typeof PairFinding>
