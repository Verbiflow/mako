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

/** The only files the link reads: a signed URL's path, `mako-file://asset/…` as the gateway sends it. */
const SIGNED_FILE_PREFIX = "/file/asset/"

/**
 * Requests to the apps this host's Threads run, and for the files it signed, from the account's other devices through
 * the host's own link (`ports.ts` in `@mako/protocol`): how a phone opens the website a Thread serves on a Mac or a
 * cloud machine, and the screenshots and recordings its transcript shows, with no tunnel and nothing listening on the
 * Mac's network. Only a port one of its Threads' apps serves on is reached, on the loopback, and only a file whose
 * signed URL this host issued; nothing else on the computer is. The answer goes back as its head, then its body in
 * pieces, paced by what the gateway has passed on, and stops when the phone goes away. Whatever goes wrong, the stream
 * ends: with a problem when nothing was answered.
 */
export class PortRelay implements PortHandler {
  readonly #allowed: () => Promise<ReadonlySet<number>>
  readonly #signedFiles: ((request: Request) => Promise<Response>) | undefined
  readonly #serving = new Map<MediaStreamId, Serving>()

  /**
   * `allowed`: the ports this host's Threads' apps serve on now. `signedFiles`: `readSignedFile`, which serves only a
   * URL its host signed for one file (`mako-file://asset/…`), never the window's reader, which also opens any path in
   * a workspace. The relay itself passes on nothing but `/file/asset/…` too.
   */
  constructor(options: { allowed: () => Promise<ReadonlySet<number>>; signedFiles: ((request: Request) => Promise<Response>) | undefined }) {
    this.#allowed = options.allowed
    this.#signedFiles = options.signedFiles
  }

  open(stream: MediaStreamId, request: PortRequest, sender: MediaSender): void {
    this.closed(stream)
    const serving: Serving = { abort: new AbortController(), sent: 0, acked: 0, wake: undefined }
    this.#serving.set(stream, serving)
    void this.#answer(request, sender, serving).finally(() => {
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

  /**
   * Answers one request, and always ends its stream: a request or an answer the link can't carry (a header no fetch
   * takes, a head past the protocol's limits), or an app that failed mid-answer, ends it with a problem rather than
   * leaving the phone waiting and the rejection loose in the host.
   */
  async #answer(request: PortRequest, sender: MediaSender, serving: Serving): Promise<void> {
    const correlationId = crypto.randomUUID()
    const what = request.to.kind === "files" ? "its files" : `port ${request.to.port}`
    try {
      await this.#serve(request, sender, serving, correlationId, what)
    } catch (error) {
      if (serving.abort.signal.aborted) return
      const detail = error instanceof Error ? error.message : String(error)
      hostWarn("gateway", "a port request failed", { to: what, correlationId, error: detail })
      sender.end(problem("unavailable", `The answer from ${what} couldn't be passed on`, correlationId, "unknown", { status: 502, detail }))
    }
  }

  async #serve(request: PortRequest, sender: MediaSender, serving: Serving, correlationId: string, what: string): Promise<void> {
    const started = performance.now()
    const headers = new Headers()
    for (const [name, value] of request.headers) if (!HOP_BY_HOP.has(name.toLowerCase())) headers.append(name, value)
    let response: Response
    try {
      if (request.to.kind === "files") {
        if (!this.#signedFiles || request.method !== "GET" || !request.path.startsWith(SIGNED_FILE_PREFIX))
          return sender.end(problem("not-found", "No such file here", correlationId, "not-applied", { status: 404 }))
        response = await this.#signedFiles(new Request(`mako-file://${request.path.slice("/file/".length)}`, { headers, signal: serving.abort.signal }))
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
    let head: Uint8Array
    try {
      head = encodePortHead({ status: response.status, headers: answered })
    } catch (error) {
      void response.body?.cancel().catch(() => undefined)
      throw error
    }
    if (!sender.send(head)) return
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
    sender.end()
    const ms = Math.round(performance.now() - started)
    // Every answer that failed or was slow is logged; a page's thirty quick assets aren't.
    if (response.status >= 400 || ms >= 1_000) hostLog("gateway", "a port request answered", { to: what, status: response.status, bytes: serving.sent, ms })
  }
}
