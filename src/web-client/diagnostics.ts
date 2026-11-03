import { MAX_BATCH_EVENTS, scrub, type TelemetryApp, type WebActivity, type WebDiagnosticEvents } from "@mako/host/contracts/telemetry"
import { SCROLL_WRITE_EVENT } from "@/components/transcript/transcript-end"
import { createHook, createStore } from "@/state/store"

type Name = keyof WebDiagnosticEvents
/** One reading this page took: when, of what, and its measures. */
export type Reading = { [Key in Name]: { id: string; at: number; name: Key; props: WebDiagnosticEvents[Key] } }[Name]

/** The readings this page took lately, newest last: Settings → Diagnostics shows them, and Copy takes them. */
export const readingsStore = createStore<{ readings: readonly Reading[] }>({ readings: [] })
export const useReadings = createHook(readingsStore)
const KEPT = 40
/** At most this many readings of a kind a minute are kept and sent, so a page caught in a loop floods neither. */
const PER_MINUTE: Partial<Record<Name, number>> = { "web.dictation": 30, "web.page": 4, "web.scroll": 12 }
const DEFAULT_PER_MINUTE = 10
/** Readings waiting to be sent past this are dropped, oldest first: the gateway may be out of reach for a while. */
const PENDING_MAX = 200
const SEND_EVERY_MS = 30_000
const INSTALL_KEY = "mako.diagnostics.install"
/** A frame this long is over budget: one and a half at 60 Hz. */
export const SLOW_FRAME_MS = 25
/** A scroll gesture is over once nothing has scrolled for this long and no finger is down. */
const SCROLL_IDLE_MS = 200
/** A timer this late, with the page in view, means the main thread was busy that long. */
const LATE_TIMER_MS = 200
const TIMER_MS = 500
/** A layout-shift score under this is the ordinary settling of a page, not a jump. */
const SHIFT_SCORE = 0.05
/** One kind of layout trouble is said at most this often. */
const LAYOUT_EVERY_MS = 10_000

const recentByName = new Map<Name, number[]>()
let pending: Reading[] = []

/** Keeps a reading, if its kind hasn't had its minute's share: shown in Diagnostics, and sent with the next batch. */
export function note<Key extends Name>(name: Key, props: WebDiagnosticEvents[Key], at = Date.now()): void {
  const minute = (recentByName.get(name) ?? []).filter((then) => at - then < 60_000)
  if (minute.length >= (PER_MINUTE[name] ?? DEFAULT_PER_MINUTE)) return
  recentByName.set(name, [...minute, at])
  // SAFETY: `name` and `props` are paired by `note`'s signature.
  const reading = { id: crypto.randomUUID(), at, name, props } as Reading
  readingsStore.set({ readings: [...readingsStore.get().readings, reading].slice(-KEPT) })
  pending = [...pending, reading].slice(-PENDING_MAX)
}

/** What dictation says of each step (`DictationStep`). */
export function noteDictation(step: WebDiagnosticEvents["web.dictation"]): void {
  note("web.dictation", step)
}

/** The page's activity now, for a reading of something that went wrong during it. */
let touching = 0
let scrolling = false
let opening = 0
function activity(): WebActivity {
  if (touching > 0) return "touch"
  if (scrolling) return "scroll"
  return opening > 0 ? "opening" : "idle"
}

/**
 * A Thread opening: `painted` once its newest turn is on screen, from what this page held or the network, and
 * `caughtUp` once it has read the Thread as it stands. Said once, when both are known or the Thread closes.
 */
export function openingThread(): { painted(from: "kept" | "network", turns: number): void; caughtUp(): void; close(): void } {
  const began = performance.now()
  opening += 1
  let open = true
  let newest: { ms: number; from: "kept" | "network"; turns: number } | undefined
  let caught: number | undefined
  const settle = () => {
    if (!open) return
    open = false
    opening -= 1
    if (newest) note("web.thread-open", { newestMs: newest.ms, from: newest.from, turns: newest.turns, ...(caught !== undefined && { caughtUpMs: caught }) })
  }
  return {
    painted(from, turns) {
      if (newest || !open) return
      newest = { ms: Math.round(performance.now() - began), from, turns }
      if (caught !== undefined) settle()
    },
    caughtUp() {
      if (caught !== undefined || !open) return
      caught = Math.round(performance.now() - began)
      if (newest) settle()
    },
    close: settle,
  }
}

/** A socket dropped longer ago than this was let go, not lost: its next one is a new connection. */
const DROP_FORGOTTEN_MS = 10 * 60_000
const drops = new Map<string, { at: number; reason: WebDiagnosticEvents["web.reconnect"]["reason"] }>()
let shownAt = 0

/**
 * Times a live connection's socket: one that closed and opened again for the same place says how long it was down,
 * counted from when the page was last in view, and how long after opening its first word came.
 */
export function watchSocket(place: string, socket: WebSocket): void {
  const dropped = drops.get(place)
  drops.delete(place)
  if (dropped && performance.now() - dropped.at < DROP_FORGOTTEN_MS)
    socket.addEventListener("open", () => {
      const opened = performance.now()
      const ms = Math.round(opened - Math.max(dropped.at, shownAt))
      socket.addEventListener("message", () => note("web.reconnect", { ms, caughtUpMs: Math.round(performance.now() - opened), reason: dropped.reason }), { once: true })
    }, { once: true })
  socket.addEventListener("close", (event) => {
    const reason = !navigator.onLine ? "offline" : document.visibilityState === "hidden" ? "resumed" : event.code === 4001 ? "renewal" : "closed"
    drops.set(place, { at: performance.now(), reason })
  }, { once: true })
}

/** Which device and browser this is, from what the browser says of itself: only names and versions. */
export function deviceOf(userAgent: string, touchPoints: number): { os: TelemetryApp["os"]; osVersion?: string; browser: WebDiagnosticEvents["web.page"]["browser"]; browserVersion?: string } {
  // An iPad asks for the desktop's pages, and says it's a Mac with a touch screen.
  const ios = /iPhone|iPad|iPod/.test(userAgent) || (/Macintosh/.test(userAgent) && touchPoints > 1)
  const os: TelemetryApp["os"] = ios ? "iOS" : /Android/.test(userAgent) ? "Android" : /Macintosh/.test(userAgent) ? "macOS" : /Windows/.test(userAgent) ? "Windows" : /Linux/.test(userAgent) ? "Linux" : "other"
  const osVersion = (ios ? /OS (\d+)_(\d+)/.exec(userAgent)?.slice(1, 3).join(".") : /Android (\d+(?:\.\d+)?)/.exec(userAgent)?.[1]) ?? undefined
  const browsers: Array<[WebDiagnosticEvents["web.page"]["browser"], RegExp]> = [
    ["edge", /Edg(?:iOS|A)?\/(\d+)/],
    ["firefox", /(?:Firefox|FxiOS)\/(\d+)/],
    ["chrome", /(?:Chrome|CriOS)\/(\d+)/],
    ["safari", /Version\/(\d+(?:\.\d+)?).*Safari/],
  ]
  const [browser, version] = browsers.map(([name, pattern]) => [name, pattern.exec(userAgent)?.[1]] as const).find(([, found]) => found) ?? ["other", undefined]
  return { os, browser, ...(osVersion && { osVersion }), ...(version && { browserVersion: version }) }
}

/** An error's words and frames as they may leave the device: the app's own files named from its origin's root, then scrubbed. */
export function errorReading(kind: string, error: unknown, origin: string): WebDiagnosticEvents["error.reported"] {
  const name = error instanceof Error && /^[A-Za-z0-9][\w.:-]*$/.test(error.name) ? error.name.slice(0, 80) : undefined
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "A value that isn't an error was thrown"
  const stack = error instanceof Error && error.stack ? scrub(error.stack.replaceAll(origin, "")).slice(0, 4_000) : undefined
  return { kind, ...(name && { name }), message: scrub(message).slice(0, 500), ...(stack && { stack }) }
}

export interface DiagnosticsOptions {
  origin: string
  build?: string
  /** The connection token this page holds now, if any: the batch is the account's with it. Never asked for. */
  token: () => string | undefined
}

let started = false

/**
 * Starts reading how the app runs here and sending what it reads to the gateway's telemetry, as diagnostics only.
 * Nothing is sent under Global Privacy Control or Do Not Track; the readings are still shown in Diagnostics.
 */
export function startDiagnostics(options: DiagnosticsOptions): void {
  if (started || typeof window === "undefined") return
  started = true
  const device = deviceOf(navigator.userAgent, navigator.maxTouchPoints ?? 0)
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") shownAt = performance.now()
  })
  watchErrors(options.origin)
  watchPage(device)
  watchBusy()
  watchScroll()
  watchLayout()
  const optedOut = (navigator as Navigator & { globalPrivacyControl?: boolean }).globalPrivacyControl === true || navigator.doNotTrack === "1"
  if (optedOut) return
  const version = options.build && /^[\w.+-]{1,40}$/.test(options.build) ? options.build : "web"
  const app: TelemetryApp = { version, ...(version !== "web" && { build: version }), distribution: "web", os: device.os, ...(device.osVersion && { osVersion: device.osVersion }), arch: "other" }
  const sender = new Sender(new URL("/v1/telemetry", options.origin), app, installId(), options.token)
  setInterval(() => void sender.send(), SEND_EVERY_MS)
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") void sender.send()
  })
}

function installId(): string {
  try {
    const held = localStorage.getItem(INSTALL_KEY)
    if (held && /^[0-9a-f-]{36}$/.test(held)) return held
    const made = crypto.randomUUID()
    localStorage.setItem(INSTALL_KEY, made)
    return made
  } catch {
    return crypto.randomUUID()
  }
}

/** Sends what's pending in batches, and waits when the gateway says to. */
class Sender {
  readonly #url: URL
  readonly #app: TelemetryApp
  readonly #install: string
  readonly #token: () => string | undefined
  #pausedUntil = 0
  #sending = false

  constructor(url: URL, app: TelemetryApp, install: string, token: () => string | undefined) {
    this.#url = url
    this.#app = app
    this.#install = install
    this.#token = token
  }

  async send(): Promise<void> {
    if (this.#sending || !pending.length || Date.now() < this.#pausedUntil) return
    this.#sending = true
    const batch = pending.slice(0, MAX_BATCH_EVENTS)
    try {
      const token = this.#token()
      const response = await fetch(this.#url, {
        method: "POST",
        // Sent as the page goes away too: the browser finishes it after.
        keepalive: true,
        headers: { "content-type": "application/json", ...(token && { authorization: `Bearer ${token}` }) },
        body: JSON.stringify({ install: this.#install, sentAt: Date.now(), app: this.#app, consent: { product: false, diagnostics: true }, events: batch.map(({ id, at, name, props }) => ({ id, at, name, props })) }),
      })
      if (response.status === 429) this.#pausedUntil = Date.now() + 60_000
      else if (response.ok || response.status === 400 || response.status === 413) {
        // Taken, or never takeable: either way not sent again.
        const sent = new Set(batch.map((reading) => reading.id))
        pending = pending.filter((reading) => !sent.has(reading.id))
        const answer = (await response.json().catch(() => undefined)) as { pauseSeconds?: unknown } | undefined
        if (typeof answer?.pauseSeconds === "number") this.#pausedUntil = Date.now() + answer.pauseSeconds * 1000
      }
    } catch {
      // Out of reach: kept for the next try.
    } finally {
      this.#sending = false
    }
  }
}

function watchErrors(origin: string): void {
  addEventListener("error", (event) => {
    // A resize observer that couldn't deliver every notification in one frame: the browser's note, not a fault.
    if (/ResizeObserver loop/.test(event.message)) return
    note("error.reported", errorReading("web-uncaught", event.error ?? event.message, origin))
  })
  addEventListener("unhandledrejection", (event) => note("error.reported", errorReading("web-rejection", event.reason, origin)))
}

function watchPage(device: ReturnType<typeof deviceOf>): void {
  let said = ""
  const say = () => {
    const props: WebDiagnosticEvents["web.page"] = {
      width: innerWidth,
      height: innerHeight,
      scale: Math.round(devicePixelRatio * 100) / 100,
      standalone: matchMedia("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true,
      touch: navigator.maxTouchPoints > 0,
      browser: device.browser,
      ...(device.browserVersion && { browserVersion: device.browserVersion }),
    }
    // The keyboard changes the height alone, every time it opens: only the width, a turn of the screen, is said again.
    const key = `${props.width}:${props.standalone}`
    if (key === said) return
    said = key
    note("web.page", props)
  }
  say()
  addEventListener("resize", say)
}

function watchBusy(): void {
  if (PerformanceObserver.supportedEntryTypes?.includes("longtask")) {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) if (entry.duration >= 100) note("web.long-task", { ms: Math.round(entry.duration), during: activity(), source: "longtask" })
    }).observe({ type: "longtask", buffered: true })
    return
  }
  // Safari measures no long tasks: a timer that fires late, while the page is in view, was held up by one.
  let expected = performance.now() + TIMER_MS
  let visible = document.visibilityState === "visible"
  document.addEventListener("visibilitychange", () => {
    visible = document.visibilityState === "visible"
    expected = performance.now() + TIMER_MS
  })
  setInterval(() => {
    const now = performance.now()
    const late = now - expected
    expected = now + TIMER_MS
    if (visible && late >= LATE_TIMER_MS && late < 10_000) note("web.long-task", { ms: Math.round(late), during: activity(), source: "timer" })
  }, TIMER_MS)
  if (PerformanceObserver.supportedEntryTypes?.includes("layout-shift"))
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries() as Array<PerformanceEntry & { value?: number; hadRecentInput?: boolean }>)
        if (!entry.hadRecentInput && (entry.value ?? 0) >= SHIFT_SCORE) note("web.layout-shift", { score: Math.round((entry.value ?? 0) * 1000) / 1000, during: activity() })
    }).observe({ type: "layout-shift", buffered: true })
}

/**
 * Each scroll gesture, from its first scroll or touch to a moment after its glide: every frame drawn meanwhile is timed.
 * Nothing runs between gestures.
 */
function watchScroll(): void {
  let gesture: { began: number; last: number; frames: number; slow: number; worst: number; writes: number; touch: boolean } | undefined
  let idle: ReturnType<typeof setTimeout> | undefined
  const frame = (previous: number) =>
    requestAnimationFrame((now) => {
      if (!gesture) return
      const gap = now - previous
      gesture.frames += 1
      if (gap > SLOW_FRAME_MS) gesture.slow += 1
      gesture.worst = Math.max(gesture.worst, gap)
      frame(now)
    })
  const begin = (touch: boolean) => {
    if (!gesture) {
      gesture = { began: performance.now(), last: performance.now(), frames: 0, slow: 0, worst: 0, writes: 0, touch }
      scrolling = true
      requestAnimationFrame((now) => frame(now))
    }
    gesture.touch ||= touch
    gesture.last = performance.now()
    clearTimeout(idle)
    idle = setTimeout(end, SCROLL_IDLE_MS)
  }
  const end = () => {
    if (!gesture) return
    if (touching > 0) {
      idle = setTimeout(end, SCROLL_IDLE_MS)
      return
    }
    const done = gesture
    gesture = undefined
    scrolling = false
    if (done.frames >= 10) note("web.scroll", { ms: Math.round(done.last - done.began), frames: done.frames, slow: done.slow, worstMs: Math.round(done.worst), writes: done.writes, touch: done.touch })
  }
  addEventListener("scroll", () => begin(false), { capture: true, passive: true })
  addEventListener("touchstart", (event) => {
    touching = event.touches.length
    begin(true)
  }, { capture: true, passive: true })
  const lifted = (event: TouchEvent) => {
    touching = event.touches.length
  }
  addEventListener("touchend", lifted, { capture: true, passive: true })
  addEventListener("touchcancel", lifted, { capture: true, passive: true })
  addEventListener(SCROLL_WRITE_EVENT, () => {
    if (gesture) gesture.writes += 1
  }, { capture: true })
}

/**
 * The app is a fixed frame the size of the visible viewport (`keyboard.ts`). Where what the screen shows and that frame
 * disagree, the layout is broken: said by how far, at most once in a while for each way.
 */
function watchLayout(): void {
  const said = new Map<WebDiagnosticEvents["web.layout"]["kind"], number>()
  let queued = false
  const check = () => {
    queued = false
    const viewport = window.visualViewport
    const app = document.querySelector(".web-app")
    if (!viewport || !app) return
    const keyboard = innerHeight - viewport.height > 120
    const troubles: Array<[WebDiagnosticEvents["web.layout"]["kind"], number]> = [
      ["page-scrolled", keyboard ? 0 : Math.max(scrollY, document.scrollingElement?.scrollTop ?? 0)],
      ["wider-than-screen", document.documentElement.scrollWidth - innerWidth],
      ["height-off", Math.abs(app.getBoundingClientRect().height - viewport.height)],
    ]
    for (const [kind, px] of troubles) {
      if (px <= 2) continue
      const now = Date.now()
      if (now - (said.get(kind) ?? 0) < LAYOUT_EVERY_MS) continue
      said.set(kind, now)
      note("web.layout", { kind, px: Math.round(px), keyboard })
    }
  }
  // Read after the app has answered the change itself (`keyboard.ts` sets the frame's height on the same events).
  const soon = () => {
    if (queued) return
    queued = true
    setTimeout(check, 600)
  }
  window.visualViewport?.addEventListener("resize", soon)
  window.visualViewport?.addEventListener("scroll", soon)
  addEventListener("resize", soon)
  addEventListener("scroll", soon, { passive: true })
}

/** A reading in a line of Diagnostics: what happened, by how much. */
export function readingWords(reading: Reading): string {
  const seconds = (ms: number) => (ms >= 1_000 ? `${(ms / 1_000).toFixed(1)} s` : `${ms} ms`)
  switch (reading.name) {
    case "error.reported":
      return `${reading.props.name ?? "Error"}: ${reading.props.message}`
    case "web.page": {
      const { width, height, scale, standalone, browser, browserVersion } = reading.props
      return `${width}×${height} @${scale}x, ${browser}${browserVersion ? ` ${browserVersion}` : ""}${standalone ? ", home screen" : ""}`
    }
    case "web.long-task":
      return `Busy ${seconds(reading.props.ms)} (${reading.props.during})`
    case "web.layout-shift":
      return `Layout shifted ${reading.props.score} (${reading.props.during})`
    case "web.layout": {
      const { kind, px, keyboard } = reading.props
      const what = kind === "page-scrolled" ? "Page scrolled" : kind === "wider-than-screen" ? "Wider than the screen by" : "Height off by"
      return `${what} ${px} px${keyboard ? " (keyboard up)" : ""}`
    }
    case "web.scroll": {
      const { ms, frames, slow, worstMs, writes } = reading.props
      return `Scroll ${seconds(ms)}: ${slow} of ${frames} frames slow, worst ${worstMs} ms${writes ? `, ${writes} writes under the finger` : ""}`
    }
    case "web.thread-open": {
      const { newestMs, from, caughtUpMs, turns } = reading.props
      return `Opened: newest in ${seconds(newestMs)} (${from}), ${caughtUpMs === undefined ? "not caught up" : `caught up in ${seconds(caughtUpMs)}`}, ${turns} turns`
    }
    case "web.reconnect": {
      const { ms, caughtUpMs, reason } = reading.props
      return `Reconnected after ${seconds(ms)} (${reason})${caughtUpMs === undefined ? "" : `, first word ${seconds(caughtUpMs)} after`}`
    }
    case "web.dictation": {
      const { step, ms, error, peak, meter } = reading.props
      return `Dictation ${step}${ms === undefined ? "" : ` ${seconds(ms)}`}${error ? `: ${error}` : ""}${peak === undefined ? "" : `, peak ${peak} (${meter})`}`
    }
  }
}
