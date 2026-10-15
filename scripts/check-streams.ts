import { createHash, randomUUID } from "node:crypto"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { basename, join } from "node:path"
import { z } from "zod"
import { RecordStore } from "@mako/sessions/record-store"
import { NativeStores } from "@mako/sessions/read-only-sqlite"
import { STREAMS_ROOT, streamFiles, streamsOf, withStreams } from "@mako/sessions/record-streams"
import { LiveBlockSchema, type LiveBlock } from "@mako/sessions/live-content"
import { STOPPED_CALL_NOTE } from "@mako/host/conversations/interrupted-turn"
import { acpBlocksToMessages } from "@/lib/acp-blocks"
import { foldTools } from "@/lib/tools"
import { differences, drawing, liveUpdates, messagesOf, storeMessages, storeReader } from "./decode-compare.ts"
import { readRecording } from "./native-decoding.ts"

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
 *   Mako showed of the conversation (`views/<conversation>.json`).
 *
 * Where the replay and the harness's store draw differently, each line is
 * noted: what the two truths disagree on, which views merge. A stream left
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
const ReportSchema = z.object({ sessions: z.array(SessionSchema).default([]) })

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
 * Mako closed it, and all up to `until`.
 */
async function joined(files: readonly string[], until = Infinity): Promise<string> {
  const ordered = [...files].sort((left, right) => basename(left).split("@")[1]!.localeCompare(basename(right).split("@")[1]!))
  const lines = (await Promise.all(ordered.map((file) => readFile(file, "utf8"))))
    .flatMap((text, index) => {
      const launch = text.split("\n").filter(Boolean).slice(index ? 1 : 0)
      const closed = launch.findIndex((line) => ClosedSchema.safeParse(JSON.parse(line)).success)
      return closed < 0 ? launch : launch.slice(0, closed)
    })
    .filter((line) => {
      const at = LineAtSchema.safeParse(JSON.parse(line)).data?.at
      return at === undefined || Date.parse(at) <= until
    })
  const path = join(work, `${randomUUID()}.jsonl`)
  await writeFile(path, `${lines.join("\n")}\n`)
  return path
}

/**
 * Known: a fork's view lacks what the harness said while the fork opened,
 * which the stream holds. The host drops it (`LiveLaunches` and
 * `live-events.ts`, which step 4's views replace); the replay draws it before
 * the fork's first prompt.
 */
function forkOpening(session: z.infer<typeof SessionSchema>, replayed: readonly string[], line: string): boolean {
  if (!session.fork || !line.startsWith("note: ")) return false
  const prompt = replayed.findIndex((drawn) => drawn.startsWith("user: "))
  return replayed.slice(0, prompt < 0 ? undefined : prompt).includes(line)
}

/**
 * Mako's view as the harness left it: a call Mako itself closed when the
 * person stopped the turn, or when Mako quit or lost the process
 * (`closeCutOffCalls`), is as the stream last had it. Mako's own acts are its
 * log's, not the harness's stream.
 */
function harnessDrawn(blocks: LiveBlock[]) {
  let closed = 0
  const reopened = blocks.map((block) => {
    if (block.type !== "tool" || !block.unfinished || !block.output || !MAKO_CLOSED.test(block.output)) return block
    closed++
    const { output: _output, unfinished: _unfinished, ...rest } = block
    return { ...rest, status: "pending" }
  })
  return { blocks: reopened, closed }
}
/**
 * Known: a call Mako closed keeps none of what the harness had streamed of
 * it, as `closeCutOffCalls` writes its note over the output, which the stream
 * holds. Step 3 moves the note to Mako's log. Both sides of each such pair:
 * the stream's pending call with output, and the view's without.
 */
function stoppedOutput(different: readonly { side: string; line: string }[]): Set<string> {
  const shown = new Set(different.filter(({ side }) => side === "+").map(({ line }) => line))
  const pairs = different.flatMap(({ side, line }) => {
    const call = / pending -> /u.exec(line)
    const bare = call ? line.slice(0, call.index + " pending".length) : undefined
    return side === "-" && bare && shown.has(bare) ? [line, bare] : []
  })
  return new Set(pairs)
}
const MAKO_CLOSED = new RegExp(`^(?:${STOPPED_CALL_NOTE.replace(/[.]/g, "\\.")}|.*so it never returned a result\\b.*)$`, "u")

/** The session's file or row as the catalog's reader finds it, and the id it reads there. */
async function located(harness: string, nativeId: string, hint: string | null, since: number): Promise<{ path: string; nativeId: string } | null> {
  const reader = storeReader(harness, home)
  const files = await reader.discover()
  const named = files.filter((file) => file.path === hint || file.path.includes(nativeId))
  for (const file of named.length ? named : files.filter((file) => file.mtimeMs >= since)) {
    const ref = await reader.peek(file)
    if (ref?.nativeId === nativeId) return { path: file.path, nativeId: ref.nativeId }
  }
  return null
}

try {
  for (const session of sessions.values()) {
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
      const view = harnessDrawn(z.array(LiveBlockSchema).parse(JSON.parse(await readFile(join(root, "views", `${session.conversation}.json`), "utf8"))))
      closedByMako += view.closed
      const shown = drawing(foldTools(acpBlocksToMessages(view.blocks, false, session.harness).messages))
      const saved = drawing((await storeMessages(session.harness, session.harness, home, found.path)).messages)
      // A call with no output yet draws ` -> ` and nothing; Mako's view of a call it closed has none.
      const bare = (lines: readonly string[]) => lines.map((line) => line.replace(/ -> $/u, ""))
      const different = differences(bare(replayed), bare(shown))
      const overwritten = view.closed ? stoppedOutput(different) : new Set<string>()
      const unshown = different.filter(({ side, line }) => {
        if (overwritten.has(line)) {
          if (side === "-") notes.push(`known, Mako's note replaced the partial output of a call it closed: ${line.slice(0, 160)}`)
          return false
        }
        if (side !== "-" || !forkOpening(session, replayed, line)) return true
        notes.push(`known, a fork's view drops what the harness said while it opened: ${line.slice(0, 160)}`)
        return false
      })
      const whole = drawing(messagesOf(session.harness, liveUpdates(session.harness, await readRecording(await joined(files)))))
      const unsaved = differences(whole, saved)
      drawn = `${replayed.length} lines replayed, ${unshown.length ? `${unshown.length} unlike` : "as"} Mako showed them; ${unsaved.length ? `${unsaved.length} unlike` : "as"} the store draws them`
      for (const { side, line } of unshown.slice(0, 12)) problems.push(`${side === "-" ? "only the stream" : "only Mako's view"}: ${line}`)
      for (const { side, line } of unsaved) notes.push(`${side === "-" ? "only the stream" : "only the store"}: ${line.slice(0, 160)}`)
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
  console.log(failed ? `FAIL: ${failed} of ${sessions.size} sessions` : `PASS: ${sessions.size} sessions' streams bound to the catalog's ids, held whole, restorable, and replaying what Mako showed`)
} finally {
  await store.close()
  await rm(work, { recursive: true, force: true })
}
process.exitCode = failed ? 1 : 0
