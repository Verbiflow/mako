import { encodePortHead, problem, type MediaSender, type MediaStreamId, type PortHandler, type PortRequest } from "@mako/protocol"
import { hostLog, hostWarn } from "../base/host-log.js"

/** At most this much of an answer is in flight unacknowledged: a slow phone slows the Mac's reading of it. */
const WINDOW_BYTES = 2 * 1024 * 1024
/** A body crosses in messages this big at most, well inside a media message's limit. */
const CHUNK_BYTES = 256 * 1024
/**
 * Headers that belong to one hop, not the request: never passed on. The body arrives decoded (Node's fetch takes the
 * app's compression off), so its encoding and length go too, and the gateway's answer gets its own.
 */
const HOP_BY_HOP = new Set(["connection", "keep-alive", "proxy-connection", "transfer-encoding", "upgrade", "te", "trailer", "host", "content-length", "content-encoding"])

type Serving = { abort: AbortController; sent: number; acked: number; wake: (() => void) | undefined }

/**
 * Requests to the apps this host's Threads run, and for the files it signed, from the account's other devices through
 * the host's own link (`ports.ts` in `@mako/protocol`): how a phone opens the website a Thread serves on a Mac or a
 * cloud machine, and the screenshots and recordings its transcript shows, with no tunnel and nothing listening on the
 * Mac's network. Only a port one of its Threads' apps serves on is reached, on the loopback, and only a file whose
 * signed URL this host issued; nothing else on the computer is. The answer goes back as its head, then its body in pieces, paced by what the gateway has
 * passed on, and stops when the phone goes away.
 */
export class PortRelay implements PortHandler {
  readonly #allowed: () => Promise<ReadonlySet<number>>
  readonly #files: ((request: Request) => Promise<Response>) | undefined
  readonly #serving = new Map<MediaStreamId, Serving>()

  /**
   * `allowed`: the ports this host's Threads' apps serve on now. `files`: the host's own signed files, as its window
   * reads them (`mako-file://asset/…`); each URL is a capability its host issued for one file, so nothing else is read.
   */
  constructor(options: { allowed: () => Promise<ReadonlySet<number>>; files: ((request: Request) => Promise<Response>) | undefined }) {
    this.#allowed = options.allowed
    this.#files = options.files
  }

  open(stream: MediaStreamId, request: PortRequest, sender: MediaSender): void {
    this.closed(stream)
    const serving: Serving = { abort: new AbortController(), sent: 0, acked: 0, wake: undefined }
    this.#serving.set(stream, serving)
    void this.#serve(request, sender, serving).finally(() => {
      if (this.#serving.get(stream) === serving) this.#serving.delete(stream)
    })
  }

  acked(stream: MediaStreamId, received: number): void {
    const serving = this.#serving.get(stream)
    if (!serving) return
    serving.acked = Math.max(serving.acked, received)
    serving.wake?.()
  }

  closed(stream: MediaStreamId): void {
    const serving = this.#serving.get(stream)
    if (!serving) return
    this.#serving.delete(stream)
    serving.abort.abort()
    serving.wake?.()
  }

  async #serve(request: PortRequest, sender: MediaSender, serving: Serving): Promise<void> {
    const correlationId = crypto.randomUUID()
    const headers = new Headers()
    for (const [name, value] of request.headers) if (!HOP_BY_HOP.has(name.toLowerCase())) headers.append(name, value)
    const what = request.to.kind === "files" ? "its files" : `port ${request.to.port}`
    const started = performance.now()
    let response: Response
    try {
      if (request.to.kind === "files") {
        if (!this.#files || !request.path.startsWith("/file/") || request.method !== "GET")
          return sender.end(problem("not-found", "No such file here", correlationId, "not-applied", { status: 404 }))
        response = await this.#files(new Request(`mako-file://${request.path.slice("/file/".length)}`, { headers, signal: serving.abort.signal }))
      } else {
        if (!(await this.#allowed().catch(() => new Set<number>())).has(request.to.port))
          return sender.end(problem("not-found", "No Thread's app serves that port here", correlationId, "not-applied", { status: 404 }))
        const init: RequestInit = { method: request.method, headers, redirect: "manual", signal: serving.abort.signal }
        if (request.body !== undefined) init.body = Buffer.from(request.body, "base64")
        response = await fetch(`http://127.0.0.1:${request.to.port}${request.path}`, init)
      }
    } catch (error) {
      if (serving.abort.signal.aborted) return
      hostWarn("gateway", "a port request wasn't answered", { to: what, correlationId, error: error instanceof Error ? error.message : String(error) })
      return sender.end(problem("unavailable", `The app on ${what} didn't answer`, correlationId, "not-applied", { status: 502 }))
    }
    const answered = [...response.headers].filter(([name]) => !HOP_BY_HOP.has(name.toLowerCase()))
    if (!sender.send(encodePortHead({ status: response.status, headers: answered }))) return
    try {
      if (response.body)
        for await (const chunk of response.body) {
          for (let at = 0; at < chunk.byteLength; at += CHUNK_BYTES) {
            const piece = chunk.subarray(at, at + CHUNK_BYTES)
            while (serving.sent - serving.acked > WINDOW_BYTES && !serving.abort.signal.aborted) await new Promise<void>((resolve) => (serving.wake = resolve))
            serving.wake = undefined
            if (serving.abort.signal.aborted || !sender.send(piece)) return
            serving.sent += piece.byteLength
          }
        }
    } catch (error) {
      if (serving.abort.signal.aborted) return
      return sender.end(problem("unavailable", `The answer from ${what} stopped mid-way`, correlationId, "unknown", { status: 502, detail: error instanceof Error ? error.message : String(error) }))
    }
    sender.end()
    const ms = Math.round(performance.now() - started)
    // Every answer that failed or was slow is logged; a page's thirty quick assets aren't.
    if (response.status >= 400 || ms >= 1_000) hostLog("gateway", "a port request answered", { to: what, status: response.status, bytes: serving.sent, ms })
  }
}
