import { constants } from "node:fs"
import { appendFile, mkdir, open, rename } from "node:fs/promises"
import { basename, dirname } from "node:path"
import type { RecordRef } from "@mako/sessions/entries"
import { claimStreamWriter, STREAMS_ROOT, streamPath } from "@mako/sessions/record-streams"
import type { ExecutionContext } from "../contracts/execution-context.js"
import type { JsonObject } from "../contracts/json.js"
import type { PromptAttachment } from "../contracts/providers-acp.js"
import { hostLog } from "../base/host-log.js"
import { SyncScope } from "../base/sync-scope.js"
import { nativeStreamJson } from "../base/native-diagnostic-json.js"

/**
 * Every frame a driver receives from its harness, whole and before any
 * decoding, so what a session showed can be decoded again
 * (`npm run decode -- <harness> <stream>`), diffed against the harness's
 * records, and kept as a fixture. The record store captures each file as a
 * unit of its session (`@mako/sessions/record-streams` says where).
 *
 * One file per launch: a header line with what the driver knew when the
 * first frame arrived and the process writing it (`claimStreamWriter`), then `{ "at", "message" }` lines,
 * `{ "at", "prompted": true, "text", "shown"?, "shownAt"?, "run"?, "attachments"? }` where Mako sent a
 * prompt, with what it sent and what it showed when that differs, when it showed it where that was earlier
 * (a message that arrived between is drawn after the prompt), the harness's id for the turn when Mako
 * names it and each attachment's name and type, or `{ "at", "prompted": true, "turn"? }` where the harness opened a
 * turn the wire does not mark, with the cause the host drew for it when the decoder can't draw it, so a replay knows where each turn began, and `{ "at", "steered": true, "text" }` where the harness
 * took a message Mako steered into the running turn (with `"shown"` where Mako showed other words), and `{ "at", "drawn" }` where the host drew a
 * marker no decoder draws (an ACP observer's mid-turn cause). A launch that resumes
 * the session writes `{ "at", "opening": true }` before it loads and
 * `{ "at", "opened": true }` once it has, so a replay knows which messages
 * were history the harness sent back while it opened, and `{ "at", "closed": true }`
 * once Mako closes it, so a replay draws nothing of what the harness says
 * as it shuts down, as the view drew nothing, and `{ "at", "ended": true }`
 * once the launch's transport is gone (its process exited, or its SDK
 * stream ended): the file is then finished, and the record store's pruning
 * may remove it once it holds it whole. `{ "at", "lost" }`
 * counts lines a failed write dropped before it, and
 * `{ "at", "unrecordable" }` stands for a message JSON can't hold.
 *
 * It holds conversation content, as the harness's own records do, and stays
 * on this machine. Fields that name credentials are redacted
 * (`nativeStreamJson`); nothing else is changed or cut.
 *
 * `Frame` is what the driver's decoder source reads back: the harness's
 * messages as its SDK or the driver's wire parser types them, and what the
 * driver itself read beside them.
 */
export interface NativeStream<Frame> {
  /** The file the next line goes to; null before the first. */
  readonly path: string | null
  /**
   * A frame as `JSON.stringify` writes it, at the moment it's recorded, and
   * where its line goes and when it was stamped, for what it decodes into (`withFrame`).
   */
  record(message: Frame): RecordedLine | undefined
  /** A turn opened: the turn the messages after it belong to. */
  prompted(prompt?: StreamedPrompt): RecordedLine | undefined
  /** The harness took `text`, which Mako steered into the running turn and showed as `shown` where that differs. */
  steered(text: string, shown?: string): RecordedLine | undefined
  /**
   * What the host drew from what it read across several messages or by its
   * own clock, which no decoder draws, so a replay draws it where it was.
   */
  drawn(update: JsonObject): RecordedLine | undefined
  /**
   * The harness reported its version in its handshake: a `{ "at", "runtime",
   * "via" }` line, once per version a launch reports. The record store reads
   * it back as the version observed running the session, where the
   * harness's own records state none (`@mako/sessions/record-writers`).
   */
  runtime(version: string, via: string): void
  /** This launch resumes the session: what follows until `opened` is history the harness replays. */
  opening(): void
  opened(): void
  /** Mako closed the session: what the harness sends after this, as it shuts down, reaches no view. */
  closed(): void
  /**
   * The launch's transport is gone: its process exited, or its SDK stream
   * ended. Called once from where the driver learns that, after anything it
   * draws of the end. A line recorded after it is appended only to a file
   * still there, never to one made again: a finished file may have been
   * pruned (`record-stream-prune.ts`).
   */
  ended(): void
  /** Resolves once every recorded line is on disk. */
  flush(): Promise<void>
}

/** A prompt Mako sent, as a stream keeps it; a turn the harness opened itself has none of it. */
export interface StreamedPrompt {
  /**
   * A turn the harness opened itself, with the cause the host drew for it,
   * where the host, not the decoder, read that cause (an ACP harness's
   * observer, which times the work by the host's clock; Claude's word from
   * the SDK when its transcript line can't be read), so a replay draws the
   * same opener.
   */
  turn?: JsonObject
  /** What the harness was sent. */
  text?: string
  /** What Mako showed for the prompt, where it differs from what was sent (a review's or goal's words, a question's reply). */
  shown?: string
  /** When Mako drew the prompt (`PromptDispatch.shownAt`), where that was before it was sent. */
  shownAt?: number
  /** The harness's id for the turn, where Mako names it before sending. */
  run?: string
  attachments?: readonly PromptAttachment[]
  /**
   * Mako asked the harness to compact (a turn of no words of Mako's): the
   * compaction it then reports is the person's, which a harness that words
   * every compaction as its own (Grok's `auto_compact_completed`) doesn't say.
   */
  compaction?: true
}

/**
 * A line of a stream file, as an entry names it (`Entry.stream`): the file
 * by its key in the record store, `mako-streams:<harness>/<name>`, and the
 * line's bytes. A launch's file is renamed once the harness names its
 * session, so a line written before then names `<launch>.jsonl`, which
 * `<session>@<launch>.jsonl` holds (`readStreamOriginal`).
 */
export type StreamFrame = RecordRef

/**
 * A line as the decode reading it takes it (`withFrame`): its frame, and
 * when it was stamped (its `"at"`) where the recorder stamped a message's
 * line or a replay read one. The time travels with the line: a table keyed
 * by every recorded frame cost the recorder a tenth of its time in
 * collection.
 */
export interface RecordedLine {
  frame?: StreamFrame
  at?: number
}

/** The line being decoded, while its decode runs: work the decode starts that runs later wasn't decoded from it. */
const decoding = new SyncScope<RecordedLine>()

/**
 * Runs `decode` with `line` as the line what it emits came from: the engine
 * names its frame on each update and marker (`frameOf`), and reads the time
 * it was stamped with as the time it arrived (`frameTime`). Decoding is
 * synchronous, so the line is current only while its decode runs.
 */
export function withFrame<T>(line: RecordedLine | undefined, decode: () => T): T {
  return line ? decoding.run(line, decode) : decode()
}

/** The frame being decoded; none outside `withFrame`. */
export function frameOf(): StreamFrame | undefined {
  return decoding.get()?.frame
}

/** The line being decoded, for a decode to run under again later (a notice held until the session opens); none outside `withFrame`. */
export function lineOf(): RecordedLine | undefined {
  return decoding.get()
}

/**
 * When the frame being decoded arrived, as its line says (`"at"`): what the
 * host measures between frames (how long a compaction took) is then what a
 * replay of the stream measures. None outside `withFrame`.
 */
export function frameTime(): number | undefined {
  return decoding.get()?.at
}

const missing = (cause: unknown) => cause instanceof Error && "code" in cause && cause.code === "ENOENT"

/** Lines bound for one file, or for the file a launch wrote before it knew its session, moved first. */
interface Batch {
  path: string
  lines: string[]
  movedFrom?: string
  /** Queued after the launch ended: appended to the file only if it's still there. */
  existing?: true
}

/**
 * The stream of one launch, or null when the driver was given nowhere to
 * keep it. `session` is read once, when the first frame arrives; `nativeId`
 * at every line, so the file takes the session's id once the harness names
 * it, and a launch that changes session starts a new file.
 *
 * Lines are written in order, every line recorded in one turn of the event
 * loop by one append. Each line's place is known when it is recorded, from
 * the bytes queued before it; once a write fails, lines that follow have no
 * place they can be found at, and are handed out with none.
 */
export function nativeStream<Frame>(
  harness: string,
  conversation: string,
  session: () => JsonObject,
  root: string | undefined,
  nativeId: () => string | null | undefined
): NativeStream<Frame> | null {
  if (!root) return null
  const launch = `${new Date().toISOString().replace(/[:.]/g, "-")}-${conversation.replace(/[^\w.-]+/g, "_")}.jsonl`
  let made = false
  let path: string | null = null
  let bound: string | undefined
  let queue: Batch[] = []
  let writing: Promise<void> | null = null
  let scheduled: NodeJS.Immediate | null = null
  let lost = 0
  let failed = false
  let finished = false
  /** The bytes each file holds once what is queued for it is written. */
  const sizes = new Map<string, number>()
  let placed = true

  const batch = (): Batch => {
    const id = nativeId() || undefined
    if (path === null || (id !== undefined && id !== bound)) {
      const next = streamPath(root, harness, launch, id)
      const moved = path !== null && bound === undefined ? path : undefined
      const started: Batch = moved ? { path: next, lines: [], movedFrom: moved } : { path: next, lines: [] }
      if (!moved) {
        // The process writing it, so the stream is known finished, and its loose file prunable once held, when that process is gone.
        const writer = claimStreamWriter(root)
        const header = `${nativeStreamJson({ capture: 1, harness, conversation, session: session(), ...writer && { writer } })}\n`
        started.lines.push(header)
        sizes.set(next, Buffer.byteLength(header))
        hostLog("live", "native stream started", { harness, path: next })
      } else {
        sizes.set(next, sizes.get(moved) ?? 0)
        sizes.delete(moved)
      }
      path = next
      bound = id
      queue.push(started)
      return started
    }
    const last = queue.at(-1)
    if (last?.path === path) return last
    const fresh: Batch = finished ? { path, lines: [], existing: true } : { path, lines: [] }
    queue.push(fresh)
    return fresh
  }

  const put = async ({ path, lines, movedFrom, existing }: Batch, again: boolean): Promise<void> => {
    if (existing) {
      if (!lines.length) return
      // No O_CREAT: the finished file may be gone, held whole by the record store, and a new one here would hold only this.
      const handle = await open(path, constants.O_WRONLY | constants.O_APPEND).catch((cause: unknown) => {
        if (missing(cause)) return null
        throw cause
      })
      if (!handle) {
        lost += lines.length
        placed = false
        hostLog("live", "native stream lines after the launch ended found its file pruned", { harness, path, lines: lines.length })
        return
      }
      try {
        await handle.appendFile(lines.join(""), "utf8")
      } finally {
        await handle.close()
      }
      return
    }
    try {
      if (!made) {
        await mkdir(dirname(path), { recursive: true })
        made = true
      }
      if (movedFrom) await rename(movedFrom, path).catch((cause: unknown) => {
        if (!missing(cause)) throw cause
        placed = false
      })
      if (!lines.length) return
      const marker = lost ? `${nativeStreamJson({ at: new Date().toISOString(), lost })}\n` : ""
      await appendFile(path, marker + lines.join(""), "utf8")
      lost = 0
    } catch (error) {
      // Someone removed the folder while the launch ran.
      if (!again || !missing(error)) throw error
      made = false
      placed = false
      await put({ path, lines }, false)
    }
  }

  const write = async (batches: Batch[]) => {
    for (const batch of batches) {
      const { path, lines } = batch
      try {
        await put(batch, true)
      } catch (error) {
        lost += lines.length
        placed = false
        if (!failed) hostLog("live", "native stream write failed", { harness, path, error: String(error) })
        failed = true
      }
    }
  }

  const drain = (): Promise<void> => {
    if (scheduled) clearImmediate(scheduled)
    scheduled = null
    if (writing) return writing
    if (!queue.length) return Promise.resolve()
    const batches = queue
    queue = []
    writing = write(batches).finally(() => {
      writing = null
      if (queue.length) schedule()
    })
    return writing
  }

  const schedule = () => {
    if (!scheduled && !writing) scheduled = setImmediate(() => void drain())
  }

  const append = (line: string): StreamFrame | undefined => {
    const target = batch()
    target.lines.push(line)
    schedule()
    const from = sizes.get(target.path) ?? 0
    const to = from + Buffer.byteLength(line)
    sizes.set(target.path, to)
    return placed ? { file: `${STREAMS_ROOT}:${harness}/${basename(target.path)}`, ranges: [[from, to]] } : undefined
  }

  const line = (body: JsonObject): RecordedLine | undefined => {
    const frame = append(`${nativeStreamJson({ at: new Date().toISOString(), ...body })}\n`)
    return frame && { frame }
  }
  let reported: string | undefined

  return {
    get path() {
      return path
    },
    record: (message) => {
      let json: string | undefined
      try {
        json = nativeStreamJson(message)
      } catch (error) {
        return line({ unrecordable: error instanceof Error ? error.message : String(error) })
      }
      if (json === undefined) return line({ unrecordable: "undefined" })
      const at = Date.now()
      const frame = append(`{"at":"${new Date(at).toISOString()}","message":${json}}\n`)
      return frame && { frame, at }
    },
    prompted: (prompt = {}) => {
      const body: JsonObject = { prompted: true }
      if (prompt.text !== undefined) body.text = prompt.text
      if (prompt.shown !== undefined && prompt.shown !== prompt.text) body.shown = prompt.shown
      if (prompt.run !== undefined) body.run = prompt.run
      // The bytes stay with Mako's attachment store; a replay draws the name and type.
      if (prompt.attachments?.length) body.attachments = prompt.attachments.map(({ name, mimeType }) => ({ name, mimeType }))
      if (prompt.turn) body.turn = prompt.turn
      if (prompt.compaction) body.compaction = true
      if (prompt.shownAt !== undefined && prompt.shownAt < Date.now()) body.shownAt = new Date(prompt.shownAt).toISOString()
      return line(body)
    },
    steered: (text, shown) => line(shown === undefined || shown === text ? { steered: true, text } : { steered: true, text, shown }),
    drawn: (update) => line({ drawn: update }),
    runtime: (version, via) => {
      if (version === reported) return
      reported = version
      line({ runtime: version, via })
    },
    opening: () => line({ opening: true }),
    opened: () => line({ opened: true }),
    closed: () => line({ closed: true }),
    ended: () => {
      // A launch that wrote nothing has no file to finish.
      if (finished || path === null) return
      line({ ended: true })
      finished = true
    },
    flush: async () => {
      while (writing || queue.length) await drain()
    },
  }
}

/** Keeps a launch's reported runtime version in its stream (`NativeStream.runtime`); nothing for a version the harness didn't report. */
export function streamRuntime(stream: Pick<NativeStream<unknown>, "runtime"> | null | undefined, runtime: ExecutionContext["runtime"]): void {
  if (runtime.kind === "reported") stream?.runtime(runtime.version, runtime.via)
}
