import type { IncomingMessage, ServerResponse } from "node:http"
import { LineAssembler } from "@mako/sessions"
import type { WindowCapturer } from "./appshots.js"
import {
  DESKTOP_CALLS,
  DESKTOP_LINE_LIMIT,
  DesktopFrameSchema,
  readDesktopLine,
  type DesktopAsk,
  type DesktopFrame,
  type DesktopMethod,
  type DesktopParams,
  type DesktopResult,
} from "./contracts/desktop-channel.js"
import type { DeskPage } from "./desk-browser.js"
import { hostLog, hostWarn } from "./host-log.js"

type JsonObject = DesktopResult<"desk-page-send">

/** How long each ask waits; a permission request waits for the person. */
const ASK_TIMEOUT_MS = {
  "computer-permissions": 5_000,
  "computer-permissions-request": 120_000,
  "window-thumbnails": 15_000,
  "window-source": 10_000,
  "desk-page-create": 60_000,
  "desk-page-send": 60_000,
  "desk-page-destroy": 5_000,
} satisfies Record<DesktopMethod, number>

interface Desktop {
  attachment: number
  detached?: boolean
  pid: number
  methods: ReadonlySet<string>
  response: ServerResponse
}

interface Pending {
  method: DesktopMethod
  attachment: number
  settle(frame: Extract<DesktopFrame, { kind: "reply" }>): void
  fail(error: Error): void
}

/**
 * The host's end of `POST /desktop` (`contracts/desktop-channel.ts`): asks
 * the attached desktop app for what only Electron's main process can do, and
 * relays the hidden desk windows it makes as pages the desk browser drives.
 * One desktop at a time: another is refused until the attached one leaves,
 * so two never take it from each other in turn. When it goes, its asks fail
 * and its windows end.
 */
export class DesktopChannel {
  private desktop: Desktop | undefined
  private attachments = 0
  private asks = 0
  private closed = false
  private readonly pending = new Map<number, Pending>()
  private readonly pages = new Map<string, RelayedPage>()

  /** The attached desktop answers `method`. */
  answers(method: DesktopMethod): boolean {
    return this.desktop?.methods.has(method) ?? false
  }

  /** The desktop app's process, while one is attached. */
  attachedPid(): number | undefined {
    return this.desktop?.pid
  }

  /** Serve one desktop's request: its frames arrive in the body, asks go out in the response. */
  attach(request: IncomingMessage, response: ServerResponse): void {
    if (this.closed) {
      response.writeHead(503, { connection: "close" }).end()
      return
    }
    if (this.desktop) {
      response.writeHead(409, { connection: "close" }).end("Another Mako desktop app answers this host.")
      return
    }
    const attachment = ++this.attachments
    response.writeHead(200, { "content-type": "application/x-ndjson", connection: "close" })
    response.flushHeaders()
    const lines = new LineAssembler(DESKTOP_LINE_LIMIT)
    let desktop: Desktop | undefined
    const refuse = (reason: string) => {
      hostWarn("desktop", "frame refused", { reason })
      request.destroy()
      response.destroy()
    }
    request.on("data", (chunk: Buffer) => {
      const complete = lines.push(chunk)
      if (!complete) return refuse("line too long")
      for (const line of complete) {
        if (!line.trim()) continue
        const frame = readDesktopLine(DesktopFrameSchema, line)
        if (!frame) return refuse("not a desktop frame")
        if (frame.kind === "hello") {
          if (desktop) continue
          // Two desktops can race to their hello; the first keeps the channel.
          if (this.desktop) return refuse("another desktop attached first")
          desktop = { attachment, pid: frame.pid, methods: new Set(frame.methods), response }
          this.desktop = desktop
          hostLog("desktop", "attached", { pid: desktop.pid, methods: frame.methods.join(",") })
        } else if (desktop) this.receive(desktop, frame)
      }
    })
    const ended = () => {
      if (desktop) this.detach(desktop, "The Mako desktop app closed.")
      if (!response.writableEnded) response.end()
    }
    request.once("end", ended)
    request.once("error", ended)
    response.once("close", ended)
  }

  ask<Method extends DesktopMethod>(method: Method, params: DesktopParams<Method>): Promise<DesktopResult<Method>> {
    const desktop = this.desktop
    if (!desktop?.methods.has(method))
      return Promise.reject(new Error("Open Mako's desktop app on this Mac to do that."))
    const id = ++this.asks
    return new Promise<DesktopResult<Method>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error("Mako's desktop app didn't answer in time."))
      }, ASK_TIMEOUT_MS[method])
      timer.unref()
      this.pending.set(id, {
        method,
        attachment: desktop.attachment,
        settle: (reply) => {
          clearTimeout(timer)
          if (!reply.ok) return reject(new Error(reply.error))
          const value = DESKTOP_CALLS[method].result.safeParse(reply.value)
          if (!value.success) return reject(new Error(`Mako's desktop app answered ${method} with something else.`))
          // SAFETY: DESKTOP_CALLS[method].result is the schema DesktopResult<Method> is inferred from; TypeScript loses that correlation when indexing by a generic key.
          resolve(value.data as DesktopResult<Method>)
        },
        fail: (error) => {
          clearTimeout(timer)
          reject(error)
        },
      })
      const ask: DesktopAsk = { kind: "ask", id, method, params }
      desktop.response.write(JSON.stringify(ask) + "\n")
    })
  }

  /** The desktop's capturer, for app shots. */
  capturer(): WindowCapturer {
    return {
      windows: () => this.ask("window-thumbnails", {}),
      source: (windowId) => this.ask("window-source", { windowId }),
    }
  }

  /** A hidden desk window the desktop makes, driven from here. */
  async deskPage(previewId: string): Promise<DeskPage> {
    const attachment = this.desktop?.attachment
    const made = await this.ask("desk-page-create", { previewId })
    const page = new RelayedPage(made.page, made.url, made.title, attachment ?? 0, this)
    if (attachment === undefined || attachment !== this.desktop?.attachment) {
      page.ended()
      throw new Error("Mako's desktop app closed while it opened the window.")
    }
    this.pages.set(made.page, page)
    page.onDestroyed(() => this.pages.delete(made.page))
    return page
  }

  close(): void {
    this.closed = true
    if (this.desktop) this.detach(this.desktop, "The host is closing.")
  }

  private receive(desktop: Desktop, frame: Exclude<DesktopFrame, { kind: "hello" }>): void {
    if (this.desktop !== desktop) return
    if (frame.kind === "reply") {
      const pending = this.pending.get(frame.id)
      if (!pending || pending.attachment !== desktop.attachment) return
      this.pending.delete(frame.id)
      pending.settle(frame)
      return
    }
    const page = this.pages.get(frame.page)
    if (!page || page.attachment !== desktop.attachment) return
    if ("message" in frame) page.message(frame.message.method, frame.message.params)
    else if ("state" in frame) page.moved(frame.state.url, frame.state.title)
    else page.ended()
  }

  private detach(desktop: Desktop, reason: string): void {
    if (desktop.detached) return
    desktop.detached = true
    if (this.desktop === desktop) this.desktop = undefined
    for (const [id, pending] of this.pending) {
      if (pending.attachment !== desktop.attachment) continue
      this.pending.delete(id)
      pending.fail(new Error(reason))
    }
    for (const page of this.pages.values()) if (page.attachment === desktop.attachment) page.ended()
    if (!desktop.response.writableEnded) desktop.response.end()
    hostLog("desktop", "detached", { pid: desktop.pid, reason })
  }
}

/** A desk window in the desktop app, as the desk browser sees one of its own. */
class RelayedPage implements DeskPage {
  private readonly messages = new Set<(method: string, params: JsonObject) => void>()
  private readonly destroyed = new Set<() => void>()
  private gone = false
  readonly id: string
  readonly attachment: number
  private currentUrl: string
  private currentTitle: string
  private readonly channel: DesktopChannel

  constructor(id: string, url: string, title: string, attachment: number, channel: DesktopChannel) {
    this.id = id
    this.currentUrl = url
    this.currentTitle = title
    this.attachment = attachment
    this.channel = channel
  }

  url(): string {
    return this.currentUrl
  }

  title(): string {
    return this.currentTitle
  }

  send(method: string, params: JsonObject): Promise<JsonObject> {
    if (this.gone) return Promise.reject(new Error("The window closed."))
    return this.channel.ask("desk-page-send", { page: this.id, method, params })
  }

  onMessage(listener: (method: string, params: JsonObject) => void): () => void {
    this.messages.add(listener)
    return () => this.messages.delete(listener)
  }

  onDestroyed(listener: () => void): () => void {
    this.destroyed.add(listener)
    return () => this.destroyed.delete(listener)
  }

  destroy(): void {
    if (this.gone) return
    void this.channel.ask("desk-page-destroy", { page: this.id }).catch(() => {})
    this.ended()
  }

  message(method: string, params: JsonObject): void {
    for (const listener of this.messages) listener(method, params)
  }

  moved(url: string, title: string): void {
    this.currentUrl = url
    this.currentTitle = title
  }

  ended(): void {
    if (this.gone) return
    this.gone = true
    this.messages.clear()
    for (const listener of this.destroyed) listener()
    this.destroyed.clear()
  }
}
