import { appendFile, mkdir, rename, stat } from "node:fs/promises"
import { dirname, join } from "node:path"
import type { Entry, RecordRef } from "@mako/sessions/entries"
import { readOriginal, readStreamOriginal, type OriginalPart } from "@mako/sessions/record-original"
import type { StreamMismatch, StreamMismatchKind } from "@mako/sessions/stream-merge"
import { errorMessage } from "./error-message.js"
import { hostLog } from "./host-log.js"
import { nativeDiagnosticJson } from "./native-diagnostic-json.js"
import { topic } from "./topic.js"

/**
 * Where a harness's live transport and its record disagreed beyond what its
 * vocabulary declares (`stream-merge.ts`), by harness and version: the
 * comparison the decode pairs run on fixtures, run on every turn Mako's
 * conversations record. The host's `StreamMismatches` writes the first of
 * each harness, version, kind and entry type per host life whole to
 * `stream-mismatches.jsonl` beside the host log: both sides' entries, and
 * the bytes each was decoded from, its record's and its stream's, read when
 * it was found, so the line still holds them once either file has moved on.
 * `npm run harness:doctor` reads it back. Later ones are counted. It holds
 * conversation content, as the harness's own records do, and stays on this
 * machine; credential fields, bearer tokens and `token=` values are scrubbed.
 */
export const STREAM_MISMATCH_FILE = "stream-mismatches.jsonl"
const MAX_BYTES = 2 * 1024 * 1024
const MAX_KINDS = 1024

export interface StreamMismatchKindCount {
  harness: string
  version: string
  kind: StreamMismatchKind
  type: Entry["type"]
  count: number
  firstSeen: number
}

export interface MismatchReport {
  harness: string
  version: string | undefined
  conversation: string
  /** The session file the record's refs name their files from. */
  path: string
  mismatches: readonly StreamMismatch[]
}

const reports = topic<MismatchReport>("mako:stream-mismatch")

/** Report what a merge found that its harness doesn't declare; kept by whatever host follows them. */
export function retainMismatches(report: MismatchReport): void {
  if (report.mismatches.length) reports.publish(report)
}

/** What one host's merges found, and the file it keeps the first of each kind in. */
export class StreamMismatches {
  readonly path: string
  readonly #streams: string | undefined
  readonly #kinds = new Map<string, StreamMismatchKindCount>()
  #queue: Promise<void> = Promise.resolve()

  /** `logs` is the directory the host log is in; `streams`, the record store's folder of streams. */
  constructor(logs: string, streams?: string) {
    this.path = join(logs, STREAM_MISMATCH_FILE)
    this.#streams = streams
  }

  follow(): () => void {
    return reports.subscribe((report) => this.#retain(report))
  }

  /** Most frequent first. */
  kinds(): StreamMismatchKindCount[] {
    return [...this.#kinds.values()].sort((a, b) => b.count - a.count)
  }

  flush(): Promise<void> {
    return this.#queue
  }

  #retain({ harness, version: reported, conversation, path, mismatches }: MismatchReport): void {
    const version = reported ?? "unknown"
    const counted = new Map<string, number>()
    for (const mismatch of mismatches) {
      const key = `${harness}\0${version}\0${mismatch.kind}\0${mismatch.type}`
      counted.set(key, (counted.get(key) ?? 0) + 1)
      const known = this.#kinds.get(key)
      if (known) {
        known.count++
        continue
      }
      if (this.#kinds.size >= MAX_KINDS) this.#kinds.delete(this.#kinds.keys().next().value!)
      const now = Date.now()
      this.#kinds.set(key, { harness, version, kind: mismatch.kind, type: mismatch.type, count: 1, firstSeen: now })
      const file = this.path
      const streams = this.#streams
      this.#queue = this.#queue.then(async () => {
        const [stream, record] = await Promise.all([side(mismatch.stream, path, streams), side(mismatch.record, path, streams)])
        const line = `${nativeDiagnosticJson({ at: new Date(now).toISOString(), harness, version, conversation, kind: mismatch.kind, type: mismatch.type, stream, record })}\n`
        await append(file, line)
      }).catch(() => undefined)
    }
    hostLog("live", "stream and record disagree", {
      conversation, harness, version,
      found: [...counted].map(([key, count]) => `${key.split("\0").slice(2).join(" ")}${count > 1 ? ` x${count}` : ""}`).join(", "),
      kept: STREAM_MISMATCH_FILE,
    })
  }
}

interface Side {
  /** Each entry without its refs, which `record` and `stream` list. */
  entries: Partial<Entry>[]
  record: RecordRef[]
  stream: RecordRef[]
  /** The bytes each ref names, in its order: the record's, then the stream's lines. */
  originals: { record: OriginalPart[]; stream: OriginalPart[] }
}

/** One side as the file keeps it: each entry whole, the bytes it names, and those bytes. */
async function side(entries: readonly Entry[], path: string, streams: string | undefined): Promise<Side> {
  const record = entries.flatMap((entry) => entry.record ? [entry.record] : [])
  const stream = entries.flatMap((entry) => entry.stream ? [entry.stream] : [])
  const read = (file: string, parts: Promise<OriginalPart[]>) =>
    parts.catch((error): OriginalPart[] => [{ kind: "missing", file, reason: errorMessage({ error }) }])
  const [recordParts, streamParts] = await Promise.all([
    Promise.all(record.map((ref) => read(ref.file ?? path, readOriginal(path, ref).then((original) => original.parts)))),
    Promise.all(stream.map((ref) => streams === undefined
      ? Promise.resolve<OriginalPart[]>([{ kind: "missing", file: ref.file ?? "", reason: "This host keeps no streams." }])
      : read(ref.file ?? "", readStreamOriginal(streams, ref)))),
  ])
  return {
    entries: entries.map((entry) => {
      const bare: Partial<Entry> = { ...entry }
      delete bare.record
      delete bare.stream
      return bare
    }),
    record,
    stream,
    originals: { record: recordParts.flat(), stream: streamParts.flat() },
  }
}

async function append(path: string, line: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const size = await stat(path).then((entry) => entry.size, () => 0)
  if (size > 0 && size + line.length > MAX_BYTES) await rename(path, `${path}.1`)
  await appendFile(path, line, "utf8")
}
