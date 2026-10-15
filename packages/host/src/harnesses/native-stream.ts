import { appendFile, mkdir, rename } from "node:fs/promises"
import { dirname } from "node:path"
import { streamPath } from "@mako/sessions/record-streams"
import type { JsonObject } from "../contracts/json.js"
import type { PromptAttachment } from "../contracts/providers-acp.js"
import { hostLog } from "../base/host-log.js"
import { nativeStreamJson } from "../base/native-diagnostic-json.js"

/**
 * Every frame a driver receives from its harness, whole and before any
 * decoding, so what a session showed can be decoded again
 * (`npm run decode -- <harness> <stream>`), diffed against the harness's
 * records, and kept as a fixture. The record store captures each file as a
 * unit of its session (`@mako/sessions/record-streams` says where).
 *
 * One file per launch: a header line with what the driver knew when the
 * first frame arrived, then `{ "at", "message" }` lines,
 * `{ "at", "prompted": true, "text", "run"?, "attachments"? }` where Mako sent a
 * prompt, with what it drew for it, the harness's id for the turn when Mako
 * names it and each attachment's name and type, or `{ "at", "prompted": true, "turn"? }` where the harness opened a
 * turn the wire does not mark, with the cause the host drew for it when the decoder can't draw it, so a replay knows where each turn began, and `{ "at", "steered": true, "text" }` where the harness
 * took a message Mako steered into the running turn, and `{ "at", "drawn" }` where the host drew a
 * marker no decoder draws (an ACP observer's mid-turn cause). A launch that resumes
 * the session writes `{ "at", "opening": true }` before it loads and
 * `{ "at", "opened": true }` once it has, so a replay knows which messages
 * were history the harness sent back while it opened, and `{ "at", "closed": true }`
 * once Mako closes it, so a replay draws nothing of what the harness says
 * as it shuts down, as the view drew nothing. `{ "at", "lost" }`
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
  /** A frame as `JSON.stringify` writes it, at the moment it's recorded. */
  record(message: Frame): void
  /** A turn opened: the turn the messages after it belong to. */
  prompted(prompt?: StreamedPrompt): void
  /** The harness took `text`, which Mako steered into the running turn. */
  steered(text: string): void
  /**
   * What the host drew from what it read across several messages or by its
   * own clock, which no decoder draws, so a replay draws it where it was.
   */
  drawn(update: JsonObject): void
  /** This launch resumes the session: what follows until `opened` is history the harness replays. */
  opening(): void
  opened(): void
  /** Mako closed the session: what the harness sends after this, as it shuts down, reaches no view. */
  closed(): void
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
  /** What Mako drew for the prompt. */
  text?: string
  /** The harness's id for the turn, where Mako names it before sending. */
  run?: string
  attachments?: readonly PromptAttachment[]
}

const missing = (cause: unknown) => cause instanceof Error && "code" in cause && cause.code === "ENOENT"

/** Lines bound for one file, or for the file a launch wrote before it knew its session, moved first. */
interface Batch {
  path: string
  lines: string[]
  movedFrom?: string
}

/**
 * The stream of one launch, or null when the driver was given nowhere to
 * keep it. `session` is read once, when the first frame arrives; `nativeId`
 * at every line, so the file takes the session's id once the harness names
 * it, and a launch that changes session starts a new file.
 *
 * Lines are written in order, every line recorded in one turn of the event
 * loop by one append.
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

  const batch = (): Batch => {
    const id = nativeId() || undefined
    if (path === null || (id !== undefined && id !== bound)) {
      const next = streamPath(root, harness, launch, id)
      const moved = path !== null && bound === undefined ? path : undefined
      const started: Batch = moved ? { path: next, lines: [], movedFrom: moved } : { path: next, lines: [] }
      if (!moved) {
        started.lines.push(`${nativeStreamJson({ capture: 1, harness, conversation, session: session() })}\n`)
        hostLog("live", "native stream started", { harness, path: next })
      }
      path = next
      bound = id
      queue.push(started)
      return started
    }
    const last = queue.at(-1)
    if (last?.path === path) return last
    const fresh: Batch = { path, lines: [] }
    queue.push(fresh)
    return fresh
  }

  const put = async ({ path, lines, movedFrom }: Batch, again: boolean): Promise<void> => {
    try {
      if (!made) {
        await mkdir(dirname(path), { recursive: true })
        made = true
      }
      if (movedFrom) await rename(movedFrom, path).catch((cause: unknown) => {
        if (!missing(cause)) throw cause
      })
      if (!lines.length) return
      const marker = lost ? `${nativeStreamJson({ at: new Date().toISOString(), lost })}\n` : ""
      await appendFile(path, marker + lines.join(""), "utf8")
      lost = 0
    } catch (error) {
      // Someone removed the folder while the launch ran.
      if (!again || !missing(error)) throw error
      made = false
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

  const append = (line: string) => {
    batch().lines.push(line)
    schedule()
  }

  const line = (body: JsonObject) => append(`${nativeStreamJson({ at: new Date().toISOString(), ...body })}\n`)

  return {
    get path() {
      return path
    },
    record: (message) => {
      let json: string | undefined
      try {
        json = nativeStreamJson(message)
      } catch (error) {
        line({ unrecordable: error instanceof Error ? error.message : String(error) })
        return
      }
      if (json === undefined) line({ unrecordable: "undefined" })
      else append(`{"at":"${new Date().toISOString()}","message":${json}}\n`)
    },
    prompted: (prompt = {}) => {
      const body: JsonObject = { prompted: true }
      if (prompt.text !== undefined) body.text = prompt.text
      if (prompt.run !== undefined) body.run = prompt.run
      // The bytes stay with Mako's attachment store; a replay draws the name and type.
      if (prompt.attachments?.length) body.attachments = prompt.attachments.map(({ name, mimeType }) => ({ name, mimeType }))
      if (prompt.turn) body.turn = prompt.turn
      line(body)
    },
    steered: (text) => line({ steered: true, text }),
    drawn: (update) => line({ drawn: update }),
    opening: () => line({ opening: true }),
    opened: () => line({ opened: true }),
    closed: () => line({ closed: true }),
    flush: async () => {
      while (writing || queue.length) await drain()
    },
  }
}
