import { createHash, randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { basename, join } from "node:path"
import { isDeepStrictEqual } from "node:util"
import { z } from "zod"
import type { ThreadPage } from "@mako/sessions"
import { RecordStore } from "@mako/sessions/record-store"
import { NativeStores } from "@mako/sessions/read-only-sqlite"
import { STREAMS_ROOT, streamFiles, streamsOf, withStreams } from "@mako/sessions/record-streams"
import { firstLiveStart, mergedBase } from "@mako/host/conversations/stream-merging"
import { declaredStreamOnly } from "@mako/sessions/stream-merge"
import { streamDifferences } from "@mako/sessions/harnesses"
import { withSeed } from "@mako/host/conversations/native-history"
import { wholeField } from "@mako/host/conversations/live-assets"
import { ProviderBindingSchema } from "@mako/host/contracts/conversation-control"
import { entriesToMessages } from "@/lib/entry-messages"
import { foldTools } from "@/lib/tools"
import { STORE_READERS, differences, drawing, liveUpdates, messagesOf, storeReader } from "./decode-compare.ts"
import { readRecording } from "./native-decoding.ts"
import { EntrySchema, type Entry } from "@mako/sessions/entries"

/**
 * Proves the streams a run of real sessions kept, one session at a time,
 * against the harness's own records:
 *
 *   npx tsx --tsconfig tsconfig.app.json scripts/check-streams.ts <flows root>
 *
 * `npm run test:session-flows` runs it on its root once the flows end. For
 * each session in `report.json`:
 *
 * - every launch's stream took the session's id, and the catalog's reader
 *   finds a session of that id: the driver and the catalog name one session;
 * - the record store, capturing the session as the catalog does, holds each
 *   stream whole beside the harness's records, and a restore would write it;
 * - the launches' streams, replayed through the harness's decoder, draw what
 *   Mako showed of the conversation (`views/<conversation>.json`);
 * - the host's merge of the session's record with Mako's blocks
 *   (`mergedBase`), run again on the record as the catalog's reader reads it
 *   now, gives what the host's merge gave when the run read it.
 *
 * What that merge finds the two truths disagree on beyond what the harness
 * declares is each noted, and counted by harness, version, kind and entry
 * type: the counts `stream.mismatch` reports from the app. A stream left
 * unbound (a launch that failed before the harness named its session) is
 * listed. Exits 1 when a session fails any of the checks.
 */

const SessionSchema = z.object({
  harness: z.string(),
  conversation: z.string(),
  nativeId: z.string(),
  path: z.string().nullable(),
  fork: z.boolean().default(false),
  /** When the view was read; what the stream heard after it (a harness reporting as it shuts down) isn't in it. */
  viewAt: z.number().optional(),
})
const LineAtSchema = z.object({ at: z.string() })
const ClosedSchema = z.object({ closed: z.literal(true) })
const KindCountSchema = z.object({ harness: z.string(), version: z.string(), kind: z.string(), type: z.string(), count: z.number() })
const ReportSchema = z.object({ sessions: z.array(SessionSchema).default([]), mismatches: z.array(KindCountSchema).optional() })
/**
 * The host's merge of a conversation's record with its blocks (`mergedBase`):
 * whether it ran, the blocks and the record's live start it took, the seed a
 * record Mako imported begins with, and the merged part it gave.
 */
const MergeSchema = ProviderBindingSchema.pick({ seeded: true }).extend({
  merged: z.boolean(),
  covered: z.number(),
  liveStart: z.number().optional(),
  version: z.string().optional(),
  own: z.array(EntrySchema).optional(),
  base: z.array(EntrySchema).optional(),
  /** A fork's inherited turns as the host showed them: its record's, with what its parent's history added. */
  inherited: z.array(EntrySchema).optional(),
  /** The requests whose turns were cut off (`cutOffRequests`), as the host merged them. */
  cutOff: z.array(z.string()).optional(),
  /** The copy of another session's history a fork began from, when the host hadn't covered a turn yet: the live start is found as the host will find it. */
  copy: z.array(EntrySchema).optional(),
})
/** What Mako showed, the calls it closed itself (`Interruption.closed`) and its merge; a flows root from before these were kept holds less. */
const ViewSchema = z.union([
  z.object({ blocks: z.array(EntrySchema), closed: z.array(z.string()).default([]), merge: MergeSchema.optional() }),
  z.array(EntrySchema).transform((blocks) => ({ blocks, closed: [], merge: undefined })),
])

const root = process.argv[2]
if (!root) {
  console.error("usage: check-streams.ts <flows root>")
  process.exit(2)
}
const streams = join(root, "streams")
const home = homedir()
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex")
const stores = new NativeStores(true)

const sessions = new Map<string, z.infer<typeof SessionSchema>>()
for (const session of ReportSchema.parse(JSON.parse(await readFile(join(root, "report.json"), "utf8"))).sessions)
  sessions.set(`${session.harness}:${session.nativeId}`, session)

const listed = await streamFiles(streams)
const work = await mkdtemp(join(tmpdir(), "mako-check-streams-"))
const store = new RecordStore(join(work, "store"), stores)
let failed = 0
let closedByMako = 0

/**
 * The launches' streams as one recording, in launch order (each launch after
 * the first is a resume, as one file of a pair holds them), each up to where
 * Mako closed it, and all up to `until`. Each launch is a new process with a
 * new decoder and engine, so one after the first begins as an opening that
 * replays nothing (an empty `opening`/`opened` pair): a harness whose resume
 * replays no history (Claude, OpenCode) writes no opening of its own, and its
 * decoder must not carry the previous launch's state (OpenCode's context
 * meter, which words a compaction "from 13k tokens").
 */
const LAUNCHED = JSON.stringify({ opening: true })
const OPENED = JSON.stringify({ opened: true })
async function joined(files: readonly string[], until = Infinity): Promise<string> {
  const ordered = [...files].sort((left, right) => basename(left).split("@")[1]!.localeCompare(basename(right).split("@")[1]!))
  const lines = (await Promise.all(ordered.map((file) => readFile(file, "utf8"))))
    .flatMap((text, index) => {
      const launch = text.split("\n").filter(Boolean).slice(index ? 1 : 0)
      const closed = launch.findIndex((line) => ClosedSchema.safeParse(JSON.parse(line)).success)
      const kept = closed < 0 ? launch : launch.slice(0, closed)
      return index ? [LAUNCHED, OPENED, ...kept] : kept
    })
    .filter((line) => {
      const at = LineAtSchema.safeParse(JSON.parse(line)).data?.at
      return at === undefined || Date.parse(at) <= until
    })
  const path = join(work, `${randomUUID()}.jsonl`)
  await writeFile(path, `${lines.join("\n")}\n`)
  return path
}

/** Mismatches the merges found, by harness, version, kind and entry type. */
const tally = new Map<string, number>()

/** What a side of a mismatch holds, in a line. */
function brief(entries: readonly Entry[]): string {
  if (!entries.length) return "nothing"
  return entries.map((entry) => {
    const said = entry.type === "user" || entry.type === "text" || entry.type === "thinking" ? entry.text
      : entry.type === "event" ? `${entry.label}${entry.detail ? ` — ${entry.detail}` : ""}`
        : entry.type === "tool" ? `${entry.name ?? ""} ${entry.input ?? ""}` : ""
    return `${entry.type}${said ? `: ${said.replace(/\s+/gu, " ").slice(0, 70)}` : ""}`
  }).join(" / ").slice(0, 200)
}

/**
 * The host's merge of the session's record with Mako's blocks, run on the
 * record as the catalog's reader reads it now, with what the host's merge
 * took: what the stream supplied, each mismatch, and whether it gives what
 * the host's merge gave.
 */
/**
 * A fork's inherited turns as the host showed them against its record of
 * them: every entry the record holds, in the record's order, and besides
 * them only what its harness declares the record never keeps, from its
 * parent's history.
 */
function inheritedTurns(harness: string, own: readonly Entry[], shown: readonly Entry[], problems: string[], notes: string[]): void {
  const ids = new Set(own.map((entry) => entry.id))
  const kept = shown.filter((entry) => ids.has(entry.id))
  const added = shown.filter((entry) => !ids.has(entry.id))
  if (kept.length !== own.length || kept.some((entry, index) => entry.id !== own[index]!.id))
    problems.push(`a fork's inherited turns show ${kept.length} of its record's ${own.length} entries, or out of its record's order`)
  const undeclared = added.filter((entry) => !declaredStreamOnly(streamDifferences(harness), entry))
  if (undeclared.length) problems.push(`a fork's inherited turns gained ${undeclared.length} entries its harness doesn't declare: ${brief(undeclared)}`)
  notes.push(`inherited turns: the record's ${own.length} entries, and ${added.length} from its parent's history`)
}

async function merging(
  harness: string,
  path: string,
  blocks: readonly Entry[],
  merge: z.infer<typeof MergeSchema> | undefined,
  problems: string[],
  notes: string[],
): Promise<string> {
  if (!merge) return "no merge: the run kept none of a fork's"
  if (merge.liveStart === undefined && !merge.copy) return "no merge: the host knows no live start in this record"
  const thread = await storeReader(harness, home).read(path)
  if (!thread) {
    problems.push(`the reader reads no session at ${path}`)
    return "no merge"
  }
  const page: ThreadPage = { ref: thread.ref, entries: thread.entries, start: 0, total: thread.entries.length, hasEarlier: false }
  const record = merge.seeded && merge.own ? withSeed(page, merge.own, merge.seeded) ?? page : page
  if (merge.inherited) inheritedTurns(harness, record.entries.slice(0, merge.liveStart), merge.inherited, problems, notes)
  const now = (merged: { entries: readonly Entry[] }) => z.array(EntrySchema).parse(JSON.parse(JSON.stringify(merged.entries)))
  const copy = merge.copy && { ...record, ref: { ...record.ref, nativeId: `${record.ref.nativeId}#copy` }, entries: merge.copy, start: 0, total: merge.copy.length, hasEarlier: false }
  const liveStart = copy ? firstLiveStart(copy, record, blocks.slice(0, merge.covered)) : merge.liveStart
  if (liveStart === undefined) return "no merge: the record can't be aligned with the copy its fork began from"
  merge.liveStart = liveStart
  const options = { cutOff: new Set(merge.cutOff ?? []), ...copy && { inherited: merge.copy } }
  let result = mergedBase(record, blocks, merge.covered, liveStart, options).merge
  if (!result) return "no merge: no live block lies in this record"
  const host = merge.merged ? merge.base : undefined
  // The record can go on after the run read it (OpenCode writes a background command's stop late): merge it as far as the host read it.
  if (host && !isDeepStrictEqual(now(result), host))
    for (let end = record.entries.length - 1; end >= merge.liveStart; end--) {
      const read = mergedBase({ ...record, entries: record.entries.slice(0, end), total: end }, blocks, merge.covered, merge.liveStart, options).merge
      if (!read || !isDeepStrictEqual(now(read), host)) continue
      notes.push(`the record went on by ${record.entries.length - end} entr${record.entries.length - end === 1 ? "y" : "ies"} after the run read it`)
      result = read
      break
    }
  const version = merge.version ?? "unknown"
  for (const mismatch of result.mismatches) {
    const key = `${harness}\0${version}\0${mismatch.kind}\0${mismatch.type}`
    tally.set(key, (tally.get(key) ?? 0) + 1)
    notes.push(`merge ${mismatch.kind} ${mismatch.type} at ${mismatch.at}: stream ${brief(mismatch.stream)} | record ${brief(mismatch.record)}`)
  }
  if (host) {
    const entries = now(result)
    if (!isDeepStrictEqual(entries, host)) {
      const unlike = entries.findIndex((entry, index) => !isDeepStrictEqual(entry, host[index]))
      const at = unlike < 0 ? entries.length : unlike
      problems.push(`the merge now gives ${entries.length} entries where the host's gave ${host.length}; first unlike at ${at}: ${brief(host.slice(at, at + 1))} became ${brief(entries.slice(at, at + 1))}`)
    }
  }
  const found = result.mismatches.length
  return `${merge.merged ? "merged as the host merged it" : "merged (the host hadn't)"}: ${result.supplied} supplied by the stream, ${found ? `${found} mismatch${found === 1 ? "" : "es"}` : "no mismatch"}${result.unaligned ? ", unaligned" : ""}`
}

/** A mismatch count's key, as `merging` makes it, in words. */
function counted(key: string, count: number): string {
  const [harness, version, kind, type] = key.split("\0")
  return `${harness!.padEnd(8)} ${version!.padEnd(10)} ${kind!.padEnd(11)} ${type!.padEnd(13)} ${count}`
}

/**
 * Mako's view as the harness left it: a call Mako itself closed when the
 * person stopped the turn, or when Mako quit or lost the process
 * (`closeCutOffCalls`), is open again, with what it had produced. Closing it
 * was Mako's act, which its log holds, not the harness's stream.
 */
function harnessDrawn({ blocks, closed }: z.infer<typeof ViewSchema>) {
  const ids = new Set(closed)
  let reopened = 0
  const drawn = blocks.map((block) => {
    if (block.type !== "tool") return block
    const whole = wholeCall(block)
    if (!ids.has(block.id)) return whole
    reopened++
    const { unfinished: _unfinished, ...rest } = whole
    return { ...rest, status: "pending" as const }
  })
  return { blocks: drawn, closed: reopened }
}

/**
 * A call as Mako holds it: a field past the wire's preview limit is kept
 * whole in the attachment its preview names (`LiveAssets`), so that is what
 * is compared with the stream, and the attachment, which the stream never
 * had, isn't drawn.
 */
function wholeCall(block: Extract<Entry, { type: "tool" }>): Extract<Entry, { type: "tool" }> {
  const read = (path: string) => { try { return readFileSync(path, "utf8") } catch { return null } }
  const input = block.input === undefined ? undefined : wholeField(block.input, block.attachments, read)
  const output = block.output === undefined ? undefined : wholeField(block.output, block.attachments, read)
  const named = new Set([input?.attachment, output?.attachment].filter((name) => name !== undefined))
  if (!named.size) return block
  const attachments = block.attachments?.filter((attachment) => !named.has(attachment.name))
  return { ...block, ...input && { input: input.text }, ...output && { output: output.text }, attachments: attachments?.length ? attachments : undefined }
}

/** The session's file or row as the catalog's reader finds it, and the id it reads there. */
async function located(harness: string, nativeId: string, hint: string | null, since: number): Promise<{ path: string; nativeId: string } | null> {
  const reader = storeReader(harness, home)
  const files = await reader.discover()
  // A Cursor agent's id also names the desktop's copy of its chat, which the run never read.
  const named = files.filter((file) => file.path === hint || file.path.includes(nativeId))
    .sort((left, right) => Number(right.path === hint) - Number(left.path === hint))
  for (const file of named.length ? named : files.filter((file) => file.mtimeMs >= since)) {
    const ref = await reader.peek(file)
    if (ref?.nativeId === nativeId) return { path: file.path, nativeId: ref.nativeId }
  }
  return null
}

try {
  for (const session of sessions.values()) {
    if (!STORE_READERS.includes(session.harness)) {
      console.log(`skip ${session.harness.padEnd(8)} ${session.nativeId.slice(0, 36)}: its store reader lives in its own definition, not one this check builds`)
      continue
    }
    const problems: string[] = []
    const notes: string[] = []
    const files = await streamsOf(streams, session.harness, session.nativeId)
    const since = Math.min(...files.map((file) => Date.parse(basename(file).split("@")[1]!.slice(0, 24).replace(/T(\d\d)-(\d\d)-(\d\d)-(\d{3})Z/, "T$1:$2:$3.$4Z")))) - 60_000
    if (!files.length) problems.push("no stream took the session's id")

    const found = await located(session.harness, session.nativeId, session.path, Number.isFinite(since) ? since : 0)
    if (!found) problems.push("the catalog's reader finds no session of the id the driver bound its stream to")

    let held = 0
    let restorable = 0
    let drawn = ""
    if (found && files.length) {
      const own = await storeReader(session.harness, home).records(found.path)
      if (!own) problems.push(`the reader keeps no records for ${found.path}`)
      else {
        await store.capture({ harness: session.harness, nativeId: session.nativeId, home, records: withStreams(own, streams, files) })
        for (const file of files) {
          const key = `${STREAMS_ROOT}:${session.harness}/${basename(file)}`
          const parts: Buffer[] = []
          for await (const part of store.content(session.harness, key)) parts.push(Buffer.from(part))
          if (sha(Buffer.concat(parts)) === sha(await readFile(file))) held++
          else problems.push(`${basename(file)} isn't held whole`)
        }
        const restore = await store.restore({ harness: session.harness, nativeId: session.nativeId, home: join(work, "restored"), roots: [{ name: STREAMS_ROOT, path: join(work, "restored-streams") }], dryRun: true })
        restorable = restore.actions.filter((action) => action.path.startsWith(`${STREAMS_ROOT}:`) && action.action === "write").length
        if (restorable !== files.length) problems.push(`a restore writes ${restorable} of ${files.length} streams`)
      }

      const replayed = drawing(messagesOf(session.harness, liveUpdates(session.harness, await readRecording(await joined(files, session.viewAt)))))
      const kept = ViewSchema.parse(JSON.parse(await readFile(join(root, "views", `${session.conversation}.json`), "utf8")))
      const view = harnessDrawn(kept)
      closedByMako += view.closed
      const shown = drawing(foldTools(entriesToMessages(view.blocks, { kind: "live", running: false, provider: session.harness }).messages))
      // A call with no output yet draws ` -> ` and nothing.
      const bare = (lines: readonly string[]) => lines.map((line) => line.replace(/ -> $/u, ""))
      const unshown = differences(bare(replayed), bare(shown))
      // A root from before the run kept the host's merge: a conversation the run started has no history before its blocks.
      const merge = kept.merge ?? (session.fork ? undefined : { merged: false, covered: kept.blocks.length, liveStart: 0 })
      const merged = await merging(session.harness, found.path, kept.blocks, merge, problems, notes)
      drawn = `${replayed.length} lines replayed, ${unshown.length ? `${unshown.length} unlike` : "as"} Mako showed them; ${merged}`
      for (const { side, line } of unshown.slice(0, 12)) problems.push(`${side === "-" ? "only the stream" : "only Mako's view"}: ${line}`)
    }

    const bytes = (await Promise.all(files.map((file) => readFile(file)))).reduce((sum, file) => sum + file.length, 0)
    const summary = `${session.harness.padEnd(8)} ${session.nativeId.slice(0, 36).padEnd(36)} ${files.length} launch${files.length === 1 ? "" : "es"}, ${(bytes / 1024).toFixed(1)} KiB, ${held} held, ${restorable} restorable; ${drawn}`
    if (problems.length) {
      failed++
      console.log(`FAIL ${summary}`)
      for (const problem of problems) console.log(`     ${problem}`)
    } else console.log(`ok   ${summary}`)
    for (const note of notes) console.log(`     note ${note}`)
  }

  const known = new Set([...sessions.values()].map((session) => `${session.harness}:${session.nativeId}`))
  const strangers = listed.sessions.filter((entry) => !known.has(`${entry.harness}:${entry.nativeId}`))
  for (const entry of strangers) console.log(`note ${entry.harness} stream of ${entry.nativeId}, a session the run didn't report: ${basename(entry.path)}`)
  if (closedByMako) console.log(`note ${closedByMako} call${closedByMako === 1 ? "" : "s"} Mako closed itself when a turn stopped, compared as the harness left ${closedByMako === 1 ? "it" : "them"}`)
  for (const path of listed.unbound) console.log(`note unbound stream, a launch the harness never named a session for: ${path.slice(streams.length + 1)}`)
  const counts = [...tally].sort((left, right) => right[1] - left[1])
  console.log(counts.length
    ? `\nMismatches the merges found beyond what each harness declares (harness, version, kind, entry type, count):\n${counts.map(([key, count]) => `  ${counted(key, count)}`).join("\n")}`
    : "\nThe merges found no mismatch beyond what each harness declares")
  const reported = ReportSchema.parse(JSON.parse(await readFile(join(root, "report.json"), "utf8"))).mismatches
  if (reported?.length) console.log(`The host's own merges during the run reported, as \`stream.mismatch\` counts them:\n${reported.map((kind) => `  ${counted([kind.harness, kind.version, kind.kind, kind.type].join("\0"), kind.count)}`).join("\n")}`)
  else if (reported) console.log("The host's own merges during the run reported no mismatch")
  console.log(failed ? `FAIL: ${failed} of ${sessions.size} sessions` : `PASS: ${sessions.size} sessions' streams bound to the catalog's ids, held whole, restorable, replaying what Mako showed, and merging as the host merged them`)
} finally {
  await store.close()
  await rm(work, { recursive: true, force: true })
}
process.exitCode = failed ? 1 : 0
