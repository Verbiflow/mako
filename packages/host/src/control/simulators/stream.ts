import { encodeControlVideo, type ControlVideoPacket } from "@mako/control-runtime/contracts"
import { hostLog, hostWarn } from "../../base/host-log.js"
import type { SimulatorFrameSink, SimulatorFrameSource } from "./host.js"

/** What a viewer is sent and hasn't read, at most: past it the viewer skips to the next key frame. */
export const VIEWER_QUEUE_BYTES = 4 * 1024 * 1024
/** The most one read hands a viewer: within a host call's answer once it's base64. */
export const READ_BATCH_BYTES = 384 * 1024
/** A viewer that hasn't read for this long has gone. */
export const VIEWER_IDLE_MS = 10_000
/** How long a screen keeps streaming once its last viewer has gone, for one that comes straight back. */
export const SCREEN_LINGER_MS = 5_000
/** The most viewers one screen streams to: the panel and the phone, with room for every device. */
export const VIEWERS_PER_SCREEN = 8
/** The most of a group of pictures kept for a late joiner; a longer one waits for the next key frame. */
const GOP_BYTES = 8 * 1024 * 1024

type Box = { width: number; height: number }

/** Whose a viewer is: the Thread that watches, by each of its names an ending may know, or the person. */
export interface ViewerOwner {
  thread: string
  session?: string
  conversation?: string
}

interface Viewer {
  queue: Uint8Array[]
  bytes: number
  /** It paints nothing it can decode until a key frame: deltas before one are useless to it, posters aren't. */
  needsKey: boolean
  box: Box | undefined
  readAt: number
  wake: (() => void) | undefined
  owner: ViewerOwner | undefined
  /** Runs out `VIEWER_IDLE_MS` after its last read answered, unless it reads again: a viewer nobody reads has gone. */
  idle: ReturnType<typeof setTimeout> | undefined
}

interface Screen {
  source: Promise<SimulatorFrameSource | undefined>
  /** The last poster, for a viewer that joins before a key frame. */
  poster: Uint8Array | undefined
  /** The last key frame and every delta after it: a late joiner decodes from here at once. */
  gop: Uint8Array[]
  gopBytes: number
  viewers: Map<string, Viewer>
  live: boolean
  linger: ReturnType<typeof setTimeout> | undefined
  /** The largest box last told to the source. */
  box: Box | undefined
}

/** A screen's name: its host and its simulator. */
type ScreenKey = string

/**
 * Every simulator screen watched from here, each streamed once from its host and shared among its viewers. A viewer
 * that joins is sent the poster and the current group of pictures (the last key frame and the deltas since), so it
 * paints the screen as it is now with nothing to wait for. A viewer that falls behind loses what it hadn't read and
 * starts again at the next key frame, which the host is asked for, so one slow phone never slows the panel. A
 * viewer is read by its own reads (`read`), which is how it's paced over any number of hops.
 */
export class SimulatorStreams {
  readonly #screens = new Map<ScreenKey, Screen>()
  readonly #now: () => number
  readonly #lingerMs: number
  readonly #queueBytes: number
  readonly #idleMs: number

  constructor(options: { now?: () => number; lingerMs?: number; queueBytes?: number; idleMs?: number } = {}) {
    this.#now = options.now ?? Date.now
    this.#lingerMs = options.lingerMs ?? SCREEN_LINGER_MS
    this.#queueBytes = options.queueBytes ?? VIEWER_QUEUE_BYTES
    this.#idleMs = options.idleMs ?? VIEWER_IDLE_MS
  }

  /**
   * What `viewer` was sent since its last read, waiting up to `waitMs` for something: its first read joins it, and
   * starts the screen's stream (`start`) if nobody watched it. `live` false: the stream ended, and the viewer with it.
   */
  async read(
    key: ScreenKey,
    viewer: string,
    start: (sink: SimulatorFrameSink) => Promise<SimulatorFrameSource>,
    options: { box?: Box; waitMs: number; decoded?: number; owner?: ViewerOwner }
  ): Promise<{ live: boolean; packets: Uint8Array[] }> {
    this.#sweep(key)
    const screen = this.#screens.get(key) ?? this.#open(key, start)
    const decoded = options.decoded
    if (decoded !== undefined) void screen.source.then((source) => source?.decoded?.(decoded))
    let watching = screen.viewers.get(viewer)
    if (!watching) {
      if (screen.viewers.size >= VIEWERS_PER_SCREEN) return { live: false, packets: [] }
      watching = this.#join(key, screen, viewer, options.box, options.owner)
    } else if (options.box && !sameBox(watching.box, options.box)) {
      watching.box = options.box
      void this.#resize(screen)
    }
    if (screen.linger) {
      clearTimeout(screen.linger)
      screen.linger = undefined
    }
    watching.readAt = this.#now()
    clearTimeout(watching.idle)
    watching.idle = undefined
    if (!watching.queue.length && screen.live) {
      const current = watching
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          current.wake = undefined
          resolve()
        }, options.waitMs)
        current.wake = () => {
          clearTimeout(timer)
          current.wake = undefined
          resolve()
        }
      })
      watching.readAt = this.#now()
    }
    const packets: Uint8Array[] = []
    let bytes = 0
    while (watching.queue.length && (packets.length === 0 || bytes + watching.queue[0]!.byteLength <= READ_BATCH_BYTES)) {
      const packet = watching.queue.shift()!
      bytes += packet.byteLength
      packets.push(packet)
    }
    watching.bytes -= bytes
    const live = screen.live || watching.queue.length > 0
    if (!live) this.#leave(key, screen, viewer)
    else if (screen.viewers.get(viewer) === watching) {
      const current = watching
      // Reads may overlap: the newest one to answer owns the deadline, and an earlier one's is let go.
      clearTimeout(current.idle)
      const idle = setTimeout(() => {
        if (current.idle !== idle) return
        current.idle = undefined
        if (screen.viewers.get(viewer) === current && !current.wake) this.#leave(key, screen, viewer)
      }, this.#idleMs)
      idle.unref?.()
      current.idle = idle
    }
    return { live, packets }
  }

  /** A viewer that went away on purpose: the screen stops once nobody watches. */
  leave(key: ScreenKey, viewer: string): void {
    const screen = this.#screens.get(key)
    if (screen) this.#leave(key, screen, viewer)
  }

  /** Every viewer an ended Thread had, on every screen: theirs stop, everyone else's watch on. */
  leaveOwned(owned: (owner: ViewerOwner) => boolean): void {
    for (const [key, screen] of this.#screens)
      for (const [name, viewer] of screen.viewers) if (viewer.owner && owned(viewer.owner)) this.#leave(key, screen, name)
  }

  /** Who watches a screen now, for the panel's "watching" line and for tests. */
  viewers(key: ScreenKey): string[] {
    return [...(this.#screens.get(key)?.viewers.keys() ?? [])]
  }

  /** Every screen's stream stopped, as the host closes. */
  async close(): Promise<void> {
    const screens = [...this.#screens.keys()]
    await Promise.all(screens.map((key) => this.#stop(key, "the host closed")))
  }

  #open(key: ScreenKey, start: (sink: SimulatorFrameSink) => Promise<SimulatorFrameSource>): Screen {
    const screen: Screen = {
      source: Promise.resolve(undefined),
      poster: undefined,
      gop: [],
      gopBytes: 0,
      viewers: new Map(),
      live: true,
      linger: undefined,
      box: undefined,
    }
    this.#screens.set(key, screen)
    const sink: SimulatorFrameSink = {
      packet: (packet) => {
        if (this.#screens.get(key) === screen && screen.live) this.#packet(screen, packet)
      },
      ended: (reason) => {
        if (this.#screens.get(key) !== screen) return
        hostLog("simulators", "stream ended", { simulator: key, reason })
        this.#end(key, screen)
      },
    }
    screen.source = start(sink).then(
      (source) => {
        hostLog("simulators", "stream started", { simulator: key })
        return source
      },
      (error) => {
        hostWarn("simulators", "stream couldn't start", { simulator: key, error: error instanceof Error ? error.message : String(error) })
        if (this.#screens.get(key) === screen) this.#end(key, screen)
        return undefined
      }
    )
    return screen
  }

  #join(key: ScreenKey, screen: Screen, name: string, box: Box | undefined, owner: ViewerOwner | undefined): Viewer {
    const viewer: Viewer = { queue: [], bytes: 0, needsKey: true, box, readAt: this.#now(), wake: undefined, owner, idle: undefined }
    screen.viewers.set(name, viewer)
    if (screen.poster) this.#push(viewer, screen.poster)
    if (screen.gop.length) {
      viewer.needsKey = false
      for (const packet of screen.gop) this.#push(viewer, packet)
    } else void screen.source.then((source) => source?.keyFrame())
    void this.#resize(screen)
    hostLog("simulators", "watching", { simulator: key, viewer: name, viewers: screen.viewers.size })
    return viewer
  }

  #packet(screen: Screen, packet: ControlVideoPacket): void {
    const bytes = encodeControlVideo(packet)
    if (packet.kind === "poster") {
      screen.poster = bytes
      // A poster starts the source's stream again, or its JPEGs instead: the H.264 before it is done with, so every viewer
      // waits for a new key and paints posters meanwhile. A screen that sends only JPEGs still moves; the newest replaces
      // one a viewer hasn't read, so a slow viewer holds one.
      screen.gop = []
      screen.gopBytes = 0
      for (const viewer of screen.viewers.values()) {
        viewer.needsKey = true
        viewer.queue = []
        viewer.bytes = 0
        this.#push(viewer, bytes)
      }
      return
    }
    if (packet.kind === "key") {
      screen.gop = [bytes]
      screen.gopBytes = bytes.byteLength
    } else if (screen.gop.length) {
      if (screen.gopBytes + bytes.byteLength > GOP_BYTES) {
        screen.gop = []
        screen.gopBytes = 0
      } else {
        screen.gop.push(bytes)
        screen.gopBytes += bytes.byteLength
      }
    }
    let behind = false
    for (const viewer of screen.viewers.values()) {
      if (packet.kind === "delta" && viewer.needsKey) continue
      if (packet.kind === "key") viewer.needsKey = false
      if (viewer.bytes + bytes.byteLength > this.#queueBytes) {
        viewer.queue = []
        viewer.bytes = 0
        viewer.needsKey = true
        behind = true
        continue
      }
      this.#push(viewer, bytes)
    }
    if (behind) void screen.source.then((source) => source?.keyFrame())
  }

  #push(viewer: Viewer, bytes: Uint8Array): void {
    viewer.queue.push(bytes)
    viewer.bytes += bytes.byteLength
    viewer.wake?.()
  }

  async #resize(screen: Screen): Promise<void> {
    const boxes = [...screen.viewers.values()].flatMap((viewer) => (viewer.box ? [viewer.box] : []))
    if (!boxes.length) return
    const box = { width: Math.max(...boxes.map((each) => each.width)), height: Math.max(...boxes.map((each) => each.height)) }
    if (sameBox(screen.box, box)) return
    screen.box = box
    ;(await screen.source)?.resize(box)
  }

  /** Viewers that stopped reading are gone; a screen nobody watches stops after its linger. */
  #sweep(key: ScreenKey): void {
    const screen = this.#screens.get(key)
    if (!screen) return
    const now = this.#now()
    for (const [name, viewer] of screen.viewers) if (now - viewer.readAt > VIEWER_IDLE_MS && !viewer.wake) this.#leave(key, screen, name)
  }

  #leave(key: ScreenKey, screen: Screen, name: string): void {
    const viewer = screen.viewers.get(name)
    if (!viewer) return
    screen.viewers.delete(name)
    clearTimeout(viewer.idle)
    viewer.wake?.()
    hostLog("simulators", "stopped watching", { simulator: key, viewer: name, viewers: screen.viewers.size })
    if (screen.viewers.size || !screen.live || screen.linger) return
    screen.linger = setTimeout(() => {
      screen.linger = undefined
      if (!screen.viewers.size && this.#screens.get(key) === screen) void this.#stop(key, "nobody watches")
    }, this.#lingerMs)
    screen.linger.unref?.()
  }

  #end(key: ScreenKey, screen: Screen): void {
    screen.live = false
    if (screen.linger) clearTimeout(screen.linger)
    if (this.#screens.get(key) === screen) this.#screens.delete(key)
    for (const viewer of screen.viewers.values()) {
      clearTimeout(viewer.idle)
      viewer.wake?.()
    }
  }

  async #stop(key: ScreenKey, reason: string): Promise<void> {
    const screen = this.#screens.get(key)
    if (!screen) return
    this.#end(key, screen)
    hostLog("simulators", "stream stopped", { simulator: key, reason })
    await (await screen.source)?.stop()
  }
}

function sameBox(a: Box | undefined, b: Box | undefined): boolean {
  return a?.width === b?.width && a?.height === b?.height
}
