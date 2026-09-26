import { randomBytes, randomUUID } from "node:crypto"
import { WebSocketServer, type WebSocket } from "ws"
import { z } from "zod"
import type { LocalBrowser } from "@mako/control-runtime/desktop"
import type { JsonObject } from "./codex-app-json.js"

/**
 * One hidden window of Mako's own interface, driven through Chrome's protocol.
 * The Electron adapter wraps a BrowserWindow; tests supply an in-memory page.
 */
export interface DeskPage {
  readonly id: string
  url(): string
  title(): string
  send(method: string, params: JsonObject): Promise<JsonObject>
  onMessage(listener: (method: string, params: JsonObject) => void): () => void
  onDestroyed(listener: () => void): () => void
  destroy(): void
}
export interface DeskBrowserOptions {
  /** Create a hidden desk window for the given preview id. */
  createPage: (previewId: string) => Promise<DeskPage>
  /** Whether a navigation target stays inside Mako's own interface. */
  allowsUrl: (url: string) => boolean
  maxPages?: number
  /** Close a window nobody has driven for this long. Default 30 minutes. */
  idleMs?: number
  name?: string
  /** The host refuses every call outside the fixture allowlist. */
  fixture?: boolean
}

const commandSchema = z.object({
  id: z.number().int(),
  method: z.string().max(200),
  params: z.record(z.string(), z.json()).default({}),
  sessionId: z.string().optional(),
})
const targetIdParam = z.object({ targetId: z.string() })
const sessionIdParam = z.object({ sessionId: z.string() })
const createParams = z.object({ url: z.string().optional() })
const navigateParams = z.object({ url: z.string() })
const DEFAULT_MAX_PAGES = 4
const DEFAULT_IDLE_MS = 30 * 60_000
const REAP_INTERVAL_MS = 60_000

interface Session {
  targetId: string
  socket: WebSocket
}

/**
 * Mako as a browser target. Agents open hidden windows of the desk itself and
 * observe, screenshot and drive them through the same browser tools they use
 * for Chrome, without touching the window the user is working in and without
 * the native driver's limits on Electron windows. The bridge speaks the
 * Target domain itself and forwards everything else to the window's debugger.
 */
export class DeskBrowser {
  readonly id = "mako"
  readonly definition: LocalBrowser
  private readonly options: DeskBrowserOptions
  private readonly pages = new Map<string, DeskPage>()
  private readonly lastActivity = new Map<string, number>()
  private reaper: NodeJS.Timeout | undefined
  private readonly sessions = new Map<string, Session>()
  private readonly sockets = new Set<WebSocket>()
  private readonly token = randomBytes(24).toString("base64url")
  private server: WebSocketServer | undefined
  private endpoint: string | undefined
  private starting: Promise<string> | undefined
  private generation = 0

  constructor(options: DeskBrowserOptions) {
    this.options = options
    const definition: LocalBrowser = {
      id: this.id,
      name: options.name ?? "Mako (this app)",
      kind: "desk",
      requiresApproval: false,
      endpoint: async () => {
        if (!this.endpoint) await this.start()
        if (!this.endpoint)
          throw new Error("Mako's desk browser is not running")
        return this.endpoint
      },
    }
    if (options.fixture) definition.fixture = true
    this.definition = definition
  }

  async start(): Promise<string> {
    if (this.endpoint) return this.endpoint
    if (this.starting) return this.starting
    const operation = this.open(this.generation)
    this.starting = operation
    try {
      return await operation
    } finally {
      if (this.starting === operation) this.starting = undefined
    }
  }

  private async open(generation: number): Promise<string> {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 })
    await new Promise<void>((resolve, reject) => {
      server.once("listening", resolve)
      server.once("error", reject)
    })
    if (generation !== this.generation) {
      server.close()
      throw new Error("Mako's desk browser closed while it was starting")
    }
    const address = z.object({ port: z.number() }).parse(server.address())
    this.server = server
    this.endpoint = `ws://127.0.0.1:${address.port}/devtools/browser/${this.token}`
    // A task that dies mid-run leaves its window behind; reap it once idle so
    // hidden windows never accumulate for the life of the host.
    this.reaper = setInterval(() => this.reapIdle(), REAP_INTERVAL_MS)
    this.reaper.unref()
    server.on("connection", (socket, request) => {
      if (request.url !== `/devtools/browser/${this.token}`) {
        socket.terminate()
        return
      }
      this.sockets.add(socket)
      socket.on("message", (raw) => {
        void this.handle(socket, raw.toString())
      })
      socket.once("close", () => {
        this.sockets.delete(socket)
        for (const [sessionId, session] of this.sessions)
          if (session.socket === socket) this.sessions.delete(sessionId)
      })
    })
    return this.endpoint
  }

  /** Hidden desk windows currently open for agents. */
  get openPages(): number {
    return this.pages.size
  }

  reapIdle(now = Date.now()): void {
    const idleMs = this.options.idleMs ?? DEFAULT_IDLE_MS
    for (const [id, page] of this.pages)
      if (now - (this.lastActivity.get(id) ?? now) >= idleMs) page.destroy()
  }

  private reply(socket: WebSocket, id: number, result: JsonObject): void {
    if (socket.readyState === socket.OPEN)
      socket.send(JSON.stringify({ id, result }))
  }
  private fail(socket: WebSocket, id: number, message: string): void {
    if (socket.readyState === socket.OPEN)
      socket.send(JSON.stringify({ id, error: { code: -32000, message } }))
  }
  private emit(method: string, params: JsonObject, sessionId?: string): void {
    const frame = JSON.stringify({ method, params, sessionId })
    for (const socket of this.sockets)
      if (socket.readyState === socket.OPEN) socket.send(frame)
  }

  private targetInfo(page: DeskPage): JsonObject {
    return {
      targetId: page.id,
      type: "page",
      title: page.title(),
      url: page.url(),
      attached: [...this.sessions.values()].some(
        (session) => session.targetId === page.id
      ),
    }
  }

  private async handle(socket: WebSocket, raw: string): Promise<void> {
    let command: z.infer<typeof commandSchema>
    try {
      command = commandSchema.parse(JSON.parse(raw))
    } catch {
      return
    }
    const { id, method, params } = command
    try {
      if (command.sessionId !== undefined) {
        const session = this.sessions.get(command.sessionId)
        const page = session ? this.pages.get(session.targetId) : undefined
        if (!session || !page) {
          this.fail(socket, id, "Session with given id not found")
          return
        }
        this.lastActivity.set(page.id, Date.now())
        if (method === "Page.navigate") {
          const url = navigateParams.parse(params).url
          if (!this.options.allowsUrl(url)) {
            this.fail(
              socket,
              id,
              "This browser hosts Mako's own interface; it does not navigate to other sites. Open a Chrome tab for external pages."
            )
            return
          }
        }
        this.reply(socket, id, await page.send(method, params))
        return
      }
      switch (method) {
        case "Target.setDiscoverTargets":
          this.reply(socket, id, {})
          return
        case "Target.getTargets":
          this.reply(socket, id, {
            targetInfos: [...this.pages.values()].map((page) =>
              this.targetInfo(page)
            ),
          })
          return
        case "Target.getTargetInfo": {
          const page = this.pages.get(targetIdParam.parse(params).targetId)
          if (!page) this.fail(socket, id, "No target with given id")
          else this.reply(socket, id, { targetInfo: this.targetInfo(page) })
          return
        }
        case "Target.createTarget": {
          const url = createParams.parse(params).url
          if (url && url !== "about:blank" && !this.options.allowsUrl(url)) {
            this.fail(
              socket,
              id,
              "This browser opens Mako's own interface only. Pass about:blank (or omit url) to open a hidden desk window."
            )
            return
          }
          if (this.pages.size >= (this.options.maxPages ?? DEFAULT_MAX_PAGES)) {
            this.fail(
              socket,
              id,
              `Mako already has ${this.pages.size} hidden desk windows open for agents. Close one before opening another.`
            )
            return
          }
          const page = await this.options.createPage(randomUUID())
          this.pages.set(page.id, page)
          this.lastActivity.set(page.id, Date.now())
          page.onMessage((eventMethod, eventParams) => {
            for (const [sessionId, session] of this.sessions)
              if (session.targetId === page.id)
                this.send(session.socket, {
                  method: eventMethod,
                  params: eventParams,
                  sessionId,
                })
          })
          page.onDestroyed(() => {
            this.lastActivity.delete(page.id)
            if (this.pages.delete(page.id))
              this.emit("Target.targetDestroyed", { targetId: page.id })
            for (const [sessionId, session] of this.sessions)
              if (session.targetId === page.id) this.sessions.delete(sessionId)
          })
          this.emit("Target.targetCreated", {
            targetInfo: this.targetInfo(page),
          })
          this.reply(socket, id, { targetId: page.id })
          return
        }
        case "Target.attachToTarget": {
          const targetId = targetIdParam.parse(params).targetId
          if (!this.pages.has(targetId)) {
            this.fail(socket, id, "No target with given id")
            return
          }
          const sessionId = randomUUID()
          this.sessions.set(sessionId, { targetId, socket })
          this.reply(socket, id, { sessionId })
          return
        }
        case "Target.detachFromTarget":
          this.sessions.delete(sessionIdParam.parse(params).sessionId)
          this.reply(socket, id, {})
          return
        case "Target.closeTarget": {
          const targetId = targetIdParam.parse(params).targetId
          const page = this.pages.get(targetId)
          if (!page) {
            this.fail(socket, id, "No target with given id")
            return
          }
          page.destroy()
          this.reply(socket, id, { success: true })
          return
        }
        case "Target.activateTarget":
          this.reply(socket, id, {})
          return
        default:
          this.fail(
            socket,
            id,
            `${method} is not available at the browser level of Mako's desk browser; send page commands through a tab session.`
          )
      }
    } catch (error) {
      this.fail(
        socket,
        id,
        error instanceof Error ? error.message : "Desk browser command failed"
      )
    }
  }

  private send(socket: WebSocket, frame: JsonObject): void {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(frame))
  }

  close(): void {
    this.generation += 1
    if (this.reaper) clearInterval(this.reaper)
    this.reaper = undefined
    for (const page of this.pages.values()) page.destroy()
    this.pages.clear()
    this.lastActivity.clear()
    this.sessions.clear()
    for (const socket of this.sockets) socket.terminate()
    this.server?.close()
    this.server = undefined
    this.endpoint = undefined
  }
}
