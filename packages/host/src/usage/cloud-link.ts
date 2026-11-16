import { CLOSE_CODES, PING, subprotocols } from "@mako/protocol"

/**
 * One live connection from this Mac to the Mako cloud, kept open for as long as it's wanted: opened with the
 * current connection token, kept alive, and opened again by itself after anything that closes it. What's on it
 * (renewing its token, serving the host as a runtime) is the protocol's, through `attach`; the link only keeps it
 * there, and says how it's doing in the one way a person sees it.
 *
 * - A dropped connection comes back with backoff and jitter, so a cloud restart isn't met by every Mac at once; a
 *   connection that answered and stayed up a while starts the backoff over.
 * - An expired token is fetched fresh and the link reconnects at once; a removed device stops it.
 * - Idle links retain their silence bound. An account with ownership work waiting is probed at once, with a short deadline.
 * - Going away on purpose (`quiet`, as the Mac goes to sleep or shuts down), it closes at once and waits for `wake`.
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
  /** Current account ownership work, not an idle subscription. `checkWaiting` notices changes at once. */
  waiting?: () => boolean
}

/** Each connection pings this often, so a dead one is found; the cloud's edge answers without waking anything. */
export const PING_MS = 25_000
const SILENT_MS = 60_000
/** A link answered at least once a ping, quieter than this when woken, missed its heartbeat while asleep. */
const WOKEN_QUIET_MS = PING_MS + 5_000
/**
 * After the machine this runs on was paused, how long its connection has to answer a ping before it's replaced. The
 * cloud's edge answers a ping in tens of milliseconds; a connection that survived the pause answers well within this.
 */
const RESUME_PROBE_MS = 1_500
/**
 * Up this long and actually heard from, a connection counts as healthy: the next drop starts the backoff over, so a link that worked and then
 * dropped (a network change) is back in a quarter second, while one the cloud keeps closing as it opens backs off.
 */
const STABLE_MS = 5_000
const WAITING_PING_MS = 5_000
const WAITING_ANSWER_MS = 3_000
/**
 * After a drop, connect again this soon, then back off while it keeps failing. The first is a quarter second: what the
 * other devices watch of this Mac's conversations is back within a second of a network change, and a cloud restart is
 * still met by Macs spread over a tenth of a second by the jitter.
 */
const BACKOFF_MS = [250, 1_000, 2_000, 5_000, 10_000, 30_000] as const
/** A link closed for a sleep (`quiet`) opens again after this should the Mac not go after all; a wake opens it at once. */
const QUIET_HOLD_MS = 30_000
const OFFLINE_AFTER_MS = 15_000

type Open = { socket: WebSocket; token: string; opened: boolean; openedAt: number; lastHeard: number; detach: CloudLinkAttachment | undefined; answered: boolean; probe?: NodeJS.Timeout }

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
  /** The connection a silence probe is waiting on an answer from, if any. */
  #probing: Open | undefined
  /** The connection a silence probe waits to ask, once it has been silent long enough, if any. */
  #asking: Open | undefined
  #offlineTimer: NodeJS.Timeout | undefined
  #reconnectTimer: NodeJS.Timeout | undefined
  #waitingTimer: NodeJS.Timeout | undefined
  /** Those waiting on `reach`: told whether the next connection opened. */
  readonly #reaching: Array<(opened: boolean) => void> = []

  constructor(options: CloudLinkOptions) {
    this.#options = options
  }

  get state(): CloudLinkState {
    return this.#state
  }

  /** Whether the connection is open and was heard from within a ping: what the cloud sends on it arrives now. */
  get heard(): boolean {
    const open = this.#open
    return open?.opened === true && Date.now() - open.lastHeard < WOKEN_QUIET_MS
  }

  /**
   * Something waits on the cloud hearing this Mac now: a link that isn't heard (down, between backoff steps, or gone
   * quiet) connects now, or the try under way is waited on, and this answers whether it opened. One heard answers at
   * once; a stopped link, or one whose try failed, answers false.
   */
  reach(): Promise<boolean> {
    if (!this.#running) return Promise.resolve(false)
    if (this.heard) return Promise.resolve(true)
    const reached = new Promise<boolean>((resolve) => this.#reaching.push(resolve))
    if (!this.#open || this.#open.opened) {
      this.#attempt = 0
      this.#reconnect(0)
    }
    return reached
  }

  /** Ownership work started or ended: only while it waits, probe now and keep checking at the short cadence. */
  checkWaiting(): void {
    this.#clearWaiting()
    const open = this.#open
    if (!this.#running || !this.#options.waiting?.()) {
      if (open) this.#clearProbe(open)
      return
    }
    // Connecting uses the existing backoff; opening this successor calls us again.
    if (!open?.opened) return
    if (open.socket.readyState !== WebSocket.OPEN) return this.#closed(open, 1006, "unanswered")
    if (!open.probe) {
      const asked = Date.now()
      open.probe = this.#after(WAITING_ANSWER_MS, () => {
        open.probe = undefined
        if (open !== this.#open || !this.#options.waiting?.()) return
        // Any frame proves liveness, including a backlog replay. An open handshake alone is not an answer.
        if (!open.answered || open.lastHeard < asked) {
          this.#options.log?.(`cloud ${this.#options.name}: unanswered while ownership waits; reconnecting`, { answerMs: WAITING_ANSWER_MS })
          this.#closed(open, 1006, "unanswered")
        }
      })
      try { open.socket.send(PING) } catch { this.#closed(open, 1006, "unanswered"); return }
    }
    this.#waitingTimer = this.#after(WAITING_PING_MS, () => this.checkWaiting())
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
    this.#reached(false)
  }

  /** After sleep or a network change: reconnect now, rather than at the next backoff step. */
  wake(): void {
    if (!this.#running) return
    const open = this.#open
    if (open?.opened && Date.now() - open.lastHeard < WOKEN_QUIET_MS) return
    this.#attempt = 0
    this.#reconnect(0)
  }

  /**
   * The machine this runs on was paused: its connection may have survived (the cloud holds a quiet one open through
   * a short pause) or be gone with a network the resume didn't keep, however recently it was heard. It's asked with a
   * ping: answered within `RESUME_PROBE_MS`, it's kept, and whatever the cloud is sending on it arrives. Replacing a
   * connection that survived lost the operation the cloud had just sent on it (2026-10-19: a send after a 30 s pause
   * failed on three harnesses of six); one that doesn't answer is replaced as before.
   */
  reconnect(): void {
    if (!this.#running) return
    const open = this.#open
    if (!open?.opened || open.socket.readyState !== WebSocket.OPEN) {
      this.#attempt = 0
      this.#reconnect(0)
      return
    }
    const asked = Date.now()
    this.#clearProbe(open)
    open.socket.send(PING)
    this.#after(RESUME_PROBE_MS, () => {
      if (open !== this.#open) return
      if (open.lastHeard >= asked) {
        this.#options.log?.(`cloud ${this.#options.name}: its connection survived the pause; kept`, { answeredMs: open.lastHeard - asked })
        return
      }
      this.#options.log?.(`cloud ${this.#options.name}: its connection didn't survive the pause; replacing it`, { probeMs: RESUME_PROBE_MS })
      this.#attempt = 0
      this.#reconnect(0)
    })
  }

  /**
   * Something someone waits for is going out on the link (a watched conversation's updates): a connection nothing has
   * come from for `silentMs` is pinged, and replaced unless it answers within `answerMs`, so a stalled link is found in
   * seconds rather than at the next missed heartbeat. One probe at a time. A connection heard from more recently is
   * asked once it has been silent that long, unless it's heard from first: what went out last, as a turn ends, may
   * have gone into a link that stalled after its last heartbeat, with nothing going out after it to ask.
   */
  probeIfSilent(silentMs: number, answerMs: number): void {
    const open = this.#open
    if (!this.#running || !open?.opened || this.#probing === open || open.socket.readyState !== WebSocket.OPEN) return
    const silent = Date.now() - open.lastHeard
    if (silent < silentMs) {
      if (this.#asking === open) return
      this.#asking = open
      const heard = open.lastHeard
      this.#after(silentMs - silent, () => {
        if (this.#asking === open) this.#asking = undefined
        if (open === this.#open && open.lastHeard === heard) this.probeIfSilent(silentMs, answerMs)
      })
      return
    }
    this.#probing = open
    const asked = Date.now()
    open.socket.send(PING)
    this.#after(answerMs, () => {
      if (this.#probing === open) this.#probing = undefined
      if (open !== this.#open || open.lastHeard >= asked) return
      this.#options.log?.(`cloud ${this.#options.name}: silent while sending what's watched, and unanswered; replacing it`, { silentMs, answerMs })
      this.#attempt = 0
      this.#reconnect(0)
    })
  }

  /**
   * This Mac is going away on purpose, to sleep or shutting down: the connection closes now, cleanly, so the cloud
   * takes it as gone at once rather than after missed heartbeats, and it isn't opened again until `wake`. The Mac's
   * timers stop while it sleeps, so the hold's own timer only opens it again for a sleep that never came. Nothing is
   * shown: the person isn't looking, and a wake reconnects before anything would be.
   */
  quiet(): void {
    if (!this.#running || !this.#open) return
    this.#options.log?.(`cloud ${this.#options.name}: closed while this Mac goes away`)
    this.#drop(1000)
    this.#attempt = 0
    clearTimeout(this.#reconnectTimer)
    this.#reconnectTimer = this.#after(QUIET_HOLD_MS, () => this.#connect())
  }

  #connect(): void {
    if (!this.#running || this.#open) return
    this.#options.token().then(
      (token) => {
        if (!this.#running || this.#open) return
        const url = new URL(this.#options.url)
        url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
        const socket = new WebSocket(url, subprotocols(token))
        const open: Open = { socket, token, opened: false, openedAt: 0, lastHeard: Date.now(), detach: undefined, answered: false }
        this.#open = open
        socket.addEventListener("open", () => this.#opened(open))
        socket.addEventListener("message", () => {
          if (open !== this.#open) return
          open.lastHeard = Date.now()
          open.answered = true
        })
        socket.addEventListener("close", (event) => this.#closed(open, event.code))
      },
      (error) => {
        if (!this.#options.signedIn()) return
        this.#options.log?.(`cloud ${this.#options.name}: no token to connect with`, { error: error instanceof Error ? error.message : "unknown" })
        this.#down()
        this.#reached(false)
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
    this.#reached(true)
    this.checkWaiting()
  }

  /** What the protocol on the link learned before the close arrived, which a proxy can hold back. */
  #ended(open: Open, ending: CloudLinkEnding): void {
    if (open !== this.#open) return
    this.#closed(open, ending === "removed" ? CLOSE_CODES.credentialRevoked : ending === "expired" ? CLOSE_CODES.credentialExpired : 1006)
  }

  #closed(open: Open, code: number, why?: "unanswered"): void {
    if (open !== this.#open) return
    this.#clearProbe(open)
    this.#clearWaiting()
    this.#open = undefined
    open.detach?.close()
    if (open.socket.readyState === WebSocket.OPEN || open.socket.readyState === WebSocket.CONNECTING) open.socket.close(1000)
    if (!open.opened) this.#reached(false)
    if (!this.#running) return
    if (why !== "unanswered" && open.answered && open.opened && Date.now() - open.openedAt >= STABLE_MS) this.#attempt = 0
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
      // Recover a missed wait notification; an existing fast probe keeps its own cadence and deadline.
      if (this.#options.waiting?.()) {
        if (!this.#waitingTimer) this.checkWaiting()
      } else {
        if (Date.now() - open.lastHeard > SILENT_MS) {
          this.#options.log?.(`cloud ${this.#options.name}: nothing heard for a minute; reconnecting`)
          this.#closed(open, 1006, "unanswered")
          return
        }
        if (open.socket.readyState === WebSocket.OPEN) open.socket.send(PING)
      }
      this.#after(PING_MS, tick)
    }
    this.#after(PING_MS, tick)
  }

  #clearWaiting(): void {
    if (this.#waitingTimer) {
      clearTimeout(this.#waitingTimer)
      this.#timers.delete(this.#waitingTimer)
      this.#waitingTimer = undefined
    }
  }

  #clearProbe(open: Open): void {
    if (open.probe) {
      clearTimeout(open.probe)
      this.#timers.delete(open.probe)
      open.probe = undefined
    }
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

  #reached(opened: boolean): void {
    for (const tell of this.#reaching.splice(0)) tell(opened)
  }

  #set(state: CloudLinkState): void {
    if (this.#state === state) return
    this.#state = state
    this.#options.onState(state)
  }

  #drop(code: number): void {
    const open = this.#open
    this.#clearWaiting()
    this.#open = undefined
    if (open) this.#clearProbe(open)
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
    this.#waitingTimer = undefined
  }
}
