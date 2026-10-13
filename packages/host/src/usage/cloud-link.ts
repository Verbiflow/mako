import { CLOSE_CODES, PING } from "@mako/protocol"

/**
 * One live connection from this Mac to the Mako cloud, kept open for as long as it's wanted: opened with the
 * current connection token, kept alive, and opened again by itself after anything that closes it. What's on it
 * (renewing its token, serving the host as a runtime) is the protocol's, through `attach`; the link only keeps it
 * there, and says how it's doing in the one way a person sees it.
 *
 * - A dropped connection comes back with backoff and jitter, so a cloud restart isn't met by every Mac at once; a
 *   connection that stayed up a while starts the backoff over.
 * - An expired token is fetched fresh and the link reconnects at once; a removed device stops it.
 * - A connection that goes quiet for a minute, as after a laptop sleeps, is taken as gone; `wake` reconnects now.
 * - It reports "offline" only once it has been down for `offlineAfterMs`. A reconnect that's over in seconds, after
 *   a deploy or a network change, is never shown.
 */

export type CloudLinkState = "connecting" | "connected" | "offline"

/** How the protocol on the link says the cloud ended it: the token ran out, the device was removed, or neither. */
export type CloudLinkEnding = "expired" | "removed" | "lost"

/** What runs on an open connection, stopped when the connection ends. */
export type CloudLinkAttachment = { close(): void }

export type CloudLinkOptions = {
  /** For the logs: which link this is. */
  name: string
  url: URL
  /** The token to open with; rejects, and the link stops, once this device is no longer signed in. */
  token(): Promise<string>
  /** The cloud refused this token: the next one is fetched fresh. */
  refused(token: string): void
  /** The connection is open. What runs on it, and how to stop it when the connection ends. */
  attach(socket: WebSocket, end: (ending: CloudLinkEnding) => void): CloudLinkAttachment
  /** This device was removed from its account. */
  removed(): void
  onState(state: CloudLinkState): void
  /** Whether this device is still signed in: once it isn't, a token that can't be had isn't worth retrying. */
  signedIn(): boolean
  log?: (message: string, fields?: Record<string, string | number | boolean>) => void
  /** A connection down this long is reported offline; anything shorter isn't shown. */
  offlineAfterMs?: number
}

/** The WebSocket subprotocol every connection to the cloud offers, and the one that carries its token. */
export const CONNECT_PROTOCOL = "mako.v1"
export const TOKEN_PROTOCOL_PREFIX = "mako.token."
/** Each connection pings this often, so a dead one is found; the cloud's edge answers without waking anything. */
export const PING_MS = 25_000
/** Nothing heard for this long and the connection is presumed dead, as after a laptop sleeps. */
const SILENT_MS = 60_000
/** Up this long, a connection counts as healthy: the next drop starts the backoff over. */
const STABLE_MS = 30_000
const BACKOFF_MS = [500, 1_000, 2_000, 5_000, 10_000, 30_000] as const
const OFFLINE_AFTER_MS = 15_000

type Open = { socket: WebSocket; token: string; opened: boolean; openedAt: number; lastHeard: number; detach: CloudLinkAttachment | undefined }

export class CloudLink {
  readonly #options: CloudLinkOptions
  #running = false
  #open: Open | undefined
  #attempt = 0
  /** At once only the first time in a row: a cloud that keeps refusing fresh tokens gets the backoff. */
  #expiredInARow = 0
  #state: CloudLinkState = "connecting"
  #everConnected = false
  #timers = new Set<NodeJS.Timeout>()
  #offlineTimer: NodeJS.Timeout | undefined
  #reconnectTimer: NodeJS.Timeout | undefined

  constructor(options: CloudLinkOptions) {
    this.#options = options
  }

  get state(): CloudLinkState {
    return this.#state
  }

  start(): void {
    if (this.#running) return
    this.#running = true
    this.#connect()
  }

  stop(): void {
    this.#running = false
    this.#clearTimers()
    this.#drop(1000)
  }

  /** After sleep or a network change: reconnect now, rather than at the next backoff step. */
  wake(): void {
    if (!this.#running) return
    const open = this.#open
    if (open?.opened && Date.now() - open.lastHeard < SILENT_MS) return
    this.#attempt = 0
    this.#reconnect(0)
  }

  #connect(): void {
    if (!this.#running || this.#open) return
    this.#options.token().then(
      (token) => {
        if (!this.#running || this.#open) return
        const url = new URL(this.#options.url)
        url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
        const socket = new WebSocket(url, [CONNECT_PROTOCOL, `${TOKEN_PROTOCOL_PREFIX}${token}`])
        const open: Open = { socket, token, opened: false, openedAt: 0, lastHeard: Date.now(), detach: undefined }
        this.#open = open
        socket.addEventListener("open", () => this.#opened(open))
        socket.addEventListener("message", () => void (open.lastHeard = Date.now()))
        socket.addEventListener("close", (event) => this.#closed(open, event.code))
      },
      (error) => {
        if (!this.#options.signedIn()) return
        this.#options.log?.(`cloud ${this.#options.name}: no token to connect with`, { error: error instanceof Error ? error.message : "unknown" })
        this.#down()
        this.#reconnect()
      }
    )
  }

  #opened(open: Open): void {
    if (open !== this.#open) return
    open.opened = true
    open.openedAt = Date.now()
    open.lastHeard = Date.now()
    this.#up()
    this.#keepAlive(open)
    open.detach = this.#options.attach(open.socket, (ending) => this.#ended(open, ending))
  }

  /** What the protocol on the link learned before the close arrived, which a proxy can hold back. */
  #ended(open: Open, ending: CloudLinkEnding): void {
    if (open !== this.#open) return
    this.#closed(open, ending === "removed" ? CLOSE_CODES.credentialRevoked : ending === "expired" ? CLOSE_CODES.credentialExpired : 1006)
  }

  #closed(open: Open, code: number): void {
    if (open !== this.#open) return
    this.#open = undefined
    open.detach?.close()
    if (open.socket.readyState === WebSocket.OPEN || open.socket.readyState === WebSocket.CONNECTING) open.socket.close(1000)
    if (!this.#running) return
    if (open.opened && Date.now() - open.openedAt >= STABLE_MS) this.#attempt = 0
    if (code === CLOSE_CODES.credentialRevoked) {
      this.#options.log?.(`cloud ${this.#options.name}: this device was removed`)
      this.#running = false
      this.#clearTimers()
      this.#options.removed()
      return
    }
    // Refused before it opened, the token is the likeliest reason (the cloud answers 401 at the upgrade): the next
    // try fetches a fresh one, and a removed device finds out from that refresh.
    if (code === CLOSE_CODES.credentialExpired || !open.opened) this.#options.refused(open.token)
    if (code === CLOSE_CODES.credentialExpired && this.#expiredInARow++ === 0) {
      this.#reconnect(0)
      return
    }
    if (code !== CLOSE_CODES.credentialExpired) this.#expiredInARow = 0
    this.#options.log?.(`cloud ${this.#options.name}: connection closed`, { code, opened: open.opened, attempt: this.#attempt })
    this.#down()
    this.#reconnect()
  }

  #reconnect(delay: number = BACKOFF_MS[Math.min(this.#attempt, BACKOFF_MS.length - 1)] ?? 30_000): void {
    this.#attempt += 1
    if (this.#open) this.#drop(1000)
    clearTimeout(this.#reconnectTimer)
    // Jitter, so a cloud restart isn't met by every Mac at once.
    this.#reconnectTimer = this.#after(delay === 0 ? 0 : delay * (0.8 + Math.random() * 0.4), () => this.#connect())
  }

  #keepAlive(open: Open): void {
    const tick = () => {
      if (open !== this.#open) return
      if (Date.now() - open.lastHeard > SILENT_MS) {
        this.#options.log?.(`cloud ${this.#options.name}: nothing heard for a minute; reconnecting`)
        this.#closed(open, 1006)
        return
      }
      if (open.socket.readyState === WebSocket.OPEN) open.socket.send(PING)
      this.#after(PING_MS, tick)
    }
    this.#after(PING_MS, tick)
  }

  /** Up: shown at once, and whatever was about to say offline doesn't. */
  #up(): void {
    clearTimeout(this.#offlineTimer)
    this.#offlineTimer = undefined
    this.#everConnected = true
    this.#set("connected")
  }

  /** Down: shown only if it stays down. Before the first connection it's still connecting. */
  #down(): void {
    if (this.#offlineTimer || this.#state === "offline") return
    this.#offlineTimer = this.#after(this.#options.offlineAfterMs ?? OFFLINE_AFTER_MS, () => {
      this.#offlineTimer = undefined
      if (!this.#open?.opened) this.#set("offline")
    })
    if (!this.#everConnected) this.#set("connecting")
  }

  #set(state: CloudLinkState): void {
    if (this.#state === state) return
    this.#state = state
    this.#options.onState(state)
  }

  #drop(code: number): void {
    const open = this.#open
    this.#open = undefined
    open?.detach?.close()
    if (open && (open.socket.readyState === WebSocket.OPEN || open.socket.readyState === WebSocket.CONNECTING)) open.socket.close(code)
  }

  #after(ms: number, run: () => void): NodeJS.Timeout {
    const timer = setTimeout(() => {
      this.#timers.delete(timer)
      run()
    }, ms)
    timer.unref?.()
    this.#timers.add(timer)
    return timer
  }

  #clearTimers(): void {
    for (const timer of this.#timers) clearTimeout(timer)
    this.#timers.clear()
    this.#offlineTimer = undefined
    this.#reconnectTimer = undefined
  }
}
