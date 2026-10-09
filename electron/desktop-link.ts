import { request, type ClientRequest } from "node:http"
import { setTimeout as delay } from "node:timers/promises"
import { LineAssembler } from "@mako/sessions"
import {
  DESKTOP_CALLS,
  DESKTOP_LINE_LIMIT,
  DESKTOP_PATH,
  DesktopAskSchema,
  readDesktopLine,
  type DesktopAsk,
  type DesktopFrame,
  type DesktopMethod,
  type DesktopParams,
  type DesktopResult,
} from "./contracts/desktop-channel.js"
import { hostLog } from "./host-log.js"

export type DesktopHandlers = { [Method in DesktopMethod]?: (params: DesktopParams<Method>) => Promise<DesktopResult<Method>> }

const RETRY_FIRST_MS = 500
const RETRY_LAST_MS = 5_000

/**
 * The desktop's end of `POST /desktop` (`contracts/desktop-channel.ts`) for as
 * long as it runs: answers the host on `socket` with `handlers`, and carries
 * frames its desk windows send on their own. A host that restarts or comes
 * up later is attached again; the link never starts one. `detached` runs each
 * time a connection ends, since the host forgets what it asked for.
 */
export class DesktopLink {
  private readonly stop = new AbortController()
  private current: ClientRequest | undefined
  private running = false
  private readonly socket: () => string
  private readonly handlers: DesktopHandlers
  private readonly detached: () => void

  constructor(socket: () => string, handlers: DesktopHandlers, detached: () => void = () => {}) {
    this.socket = socket
    this.handlers = handlers
    this.detached = detached
  }

  start(): void {
    if (this.running) return
    this.running = true
    void this.run()
  }

  /** A frame for the host, dropped while none is attached. */
  frame(frame: DesktopFrame): void {
    this.current?.write(JSON.stringify(frame) + "\n")
  }

  dispose(): void {
    this.stop.abort()
    this.current?.destroy()
  }

  private async run(): Promise<void> {
    let retry = RETRY_FIRST_MS
    while (!this.stop.signal.aborted) {
      const outcome = await this.connect()
      if (outcome === "attached") retry = RETRY_FIRST_MS
      // A host older than the channel answers 404 and does this work itself; one
      // another desktop answers says 409 until that desktop leaves.
      const wait = outcome === "absent" ? RETRY_LAST_MS : retry
      await delay(wait, undefined, { signal: this.stop.signal }).catch(() => undefined)
      if (outcome !== "attached") retry = Math.min(retry * 2, RETRY_LAST_MS)
    }
  }

  private connect(): Promise<"attached" | "absent" | "failed"> {
    return new Promise((resolve) => {
      let attached = false
      const req = request({
        socketPath: this.socket(),
        path: DESKTOP_PATH,
        method: "POST",
        headers: { "content-type": "application/x-ndjson" },
        signal: this.stop.signal,
      })
      const finish = () => {
        if (this.current === req) {
          this.current = undefined
          this.detached()
        }
        resolve(attached ? "attached" : "failed")
      }
      req.on("response", (response) => {
        if (response.statusCode !== 200) {
          response.resume()
          req.destroy()
          resolve(response.statusCode === 404 || response.statusCode === 409 ? "absent" : "failed")
          return
        }
        attached = true
        this.current = req
        hostLog("desktop", "answering the host", { socket: this.socket() })
        const lines = new LineAssembler(DESKTOP_LINE_LIMIT)
        response.on("data", (chunk: Buffer) => {
          const complete = lines.push(chunk)
          if (!complete) {
            req.destroy()
            return
          }
          for (const line of complete) {
            if (!line.trim()) continue
            const ask = readDesktopLine(DesktopAskSchema, line)
            if (ask) void this.answer(req, ask)
          }
        })
        response.once("close", finish)
      })
      req.once("error", finish)
      req.write(JSON.stringify({ kind: "hello", pid: process.pid, methods: Object.keys(this.handlers) } satisfies DesktopFrame) + "\n")
    })
  }

  private async answer(req: ClientRequest, ask: DesktopAsk): Promise<void> {
    let reply: string
    try {
      // SAFETY: each handler takes its own method's parameters, which DESKTOP_CALLS[ask.method].params parses just below; TypeScript can't pair the two through the union of methods.
      const handler = this.handlers[ask.method] as ((params: DesktopParams<DesktopMethod>) => Promise<DesktopResult<DesktopMethod>>) | undefined
      if (!handler) throw new Error(`This desktop app doesn't answer ${ask.method}.`)
      const value = await handler(DESKTOP_CALLS[ask.method].params.parse(ask.params))
      // The host validates the answer against the same contract.
      reply = JSON.stringify({ kind: "reply", id: ask.id, ok: true, value })
    } catch (error) {
      reply = JSON.stringify({ kind: "reply", id: ask.id, ok: false, error: (error instanceof Error ? error.message : String(error)).slice(0, 4000) } satisfies DesktopFrame)
    }
    if (this.current === req) req.write(reply + "\n")
  }
}
