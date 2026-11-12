import type { HostCallReplay } from "./host-call-policy.js"

/**
 * Simulators: iPhones and iPads (Android emulators later) that agents drive and people watch. Not "devices": on the
 * wire a device is a runtime the person enrolled (`DeviceIdSchema`, `place: "device:<name>"`), and one word for both
 * would leave a model guessing which it was given.
 *
 * Each operation is defined once here: a host call `mako:simulators-<verb>`, its input and result, its replay class
 * and its MCP projection. The in-Thread `mako` server and the desk are projections of this table, as orchestration's
 * doors are of `AGENT_TOOLS`.
 */

export type SimulatorPlatform = "ios" | "android"
export type SimulatorForm = "phone" | "tablet"

/**
 * Where a host's simulators run: this Mac, another Mac of the person's (over its runtime link), a remote Mac, or a
 * stand-in: a desktop engine at a phone's size, which is not iOS and says so.
 */
export type SimulatorHostKind = "local" | "mac" | "remote" | "stand-in"

/** Why a host can't run a platform. */
export type SimulatorBlocker =
  /** Simulators run on macOS alone. */
  | "not-macos"
  /** No Xcode: the Command Line Tools have no `simctl` and no Simulator. */
  | "no-xcode"
  /** Xcode without a simulator runtime for the platform. */
  | "no-runtime"
  /** The tools Mako streams and drives a simulator with aren't installed yet. */
  | "no-tools"
  /** The host is there, but Mako's driving of it isn't built yet: it lists, and it refuses to act. */
  | "not-built"
  /** Another Mac of the person's that isn't connected now, or didn't answer in time. */
  | "unreachable"
  /** Another Mac of the person's that lends this caller no simulator: its Thread holds no lease of one there. */
  | "not-offered"

export type SimulatorAvailability = { ready: true } | { ready: false; blocker: SimulatorBlocker; why: string; fix?: string }

/** This Mac's own simulators, as it names them. */
export const LOCAL_HOST = "local"
const MAC_HOST = "mac:"

/**
 * Another Mac of the person's, by its device in the account: `mac:<device>`. A simulator's ID (its UDID) is unique
 * only on its own Mac, so every simulator is named by its host and its ID together, and the host that owns it keeps
 * its claim: two Macs never both think they drive one.
 */
export function macHostId(device: string): string {
  return `${MAC_HOST}${device}`
}

/** The device a `mac:<device>` host names, or undefined for this Mac's own and anything else. */
export function macHostDevice(host: string): string | undefined {
  return host.startsWith(MAC_HOST) && host.length > MAC_HOST.length ? host.slice(MAC_HOST.length) : undefined
}

export interface SimulatorHostSummary {
  /**
   * `local`, `stand-in`, or `mac:<device>` for another of the person's Macs. A simulator's ID is its host's own
   * (a UDID), unique only on that host, so every call names both.
   */
  id: string
  /** What the panel and an agent call it: "This Mac", "WebKit stand-in". */
  label: string
  kind: SimulatorHostKind
  platforms: Record<SimulatorPlatform, SimulatorAvailability>
  /** What it found, for Diagnostics: the developer folder, and Xcode's version when there is one. */
  detail?: string
  /** A simulator here costs money while it runs (a leased or per-minute Mac), so opening one starts a bill and releasing it ends it. */
  billed?: true
}

export type SimulatorState = "shutdown" | "booting" | "booted" | "shutting-down"

export interface SimulatorSummary {
  hostId: string
  /** The host's own ID for it: a simulator's UDID. */
  id: string
  /** "iPhone 17 Pro". */
  name: string
  platform: SimulatorPlatform
  /** "iOS 26.1". */
  runtime: string
  form: SimulatorForm
  state: SimulatorState
  /** The screen in points, when the host knows it. */
  screen?: { width: number; height: number; scale: number }
  /** How it's turned now, when it's running and the host knows: the screen's picture is drawn upright for it. */
  orientation?: SimulatorOrientation
  /** A stand-in: a desktop engine at this size, not the platform. */
  standIn?: true
}

/**
 * The one Thread that drives a simulator now. `generation` grows with each new holder, so a late action from a
 * Thread that has lost the simulator is refused as stale rather than landing on someone else's screen.
 */
export interface SimulatorClaim {
  thread: string
  /** The Session that opened it, for an agent's claim. */
  session?: string
  conversation?: string
  /** The Thread's title, for whoever watches. */
  title?: string
  since: number
  /** When its holder last acted: a claim idle for `CLAIM_IDLE_MS` lets go. */
  lastAt: number
  generation: number
  /** The lease another place's agent holds it under: only that lease drives it, and its end lets it go. */
  lease?: string
}

export interface ListedSimulator extends SimulatorSummary {
  claim?: SimulatorClaim
}

/** Whether the person lets agents in the caller's project use simulators: until they do, no agent there is offered the tools. */
export type SimulatorConsent = "unasked" | "allowed" | "refused"

/** A held simulator lets go after this long with no action from its holder. */
export const CLAIM_IDLE_MS = 30 * 60_000

/**
 * Where a call came from when it reached this host through the gateway: the account's device or machine whose link
 * sent it (`desktop:<device>`, `web:<device>`, `runtime:<runtime>`). The host that receives the call stamps it from
 * its own record of the connection; what a caller sends as `via` is dropped, so no caller can say it's local.
 */
export interface SimulatorVia {
  from: string
}

/**
 * Who calls, as orchestration's doors stamp it: an agent by its Session, or the person from the panel. The host finds
 * the Session's Thread, conversation, title and project folder (which consent is per) itself, so a caller can't name
 * another Thread or another project. The person may take any simulator over; an agent may act only on one its
 * Thread holds.
 *
 * A call from another place (one of the person's devices, or a cloud Thread's machine) carries `via` (stamped here)
 * and, for an agent, the Thread the calling place already resolved (`agent`): that Session isn't on this Mac. This Mac
 * answers an agent's call only under a live session lease it serves for that Thread, borrowed from that same place
 * (`via`), checked on every call: the person's grant is the consent, and the lease is the offer.
 */
export type SimulatorCaller =
  | { kind: "agent"; session: string; via?: SimulatorVia; agent?: SimulatorAgent }
  | { kind: "person"; via?: SimulatorVia }

/** What the host knows of an agent caller's Session: the Thread a claim belongs to, and the folder consent is read for. */
export interface SimulatorAgent {
  thread: string
  session: string
  conversation?: string
  /** Where it works. */
  folder: string
  /** The project its worktree belongs to, when `folder` is a worktree: asked when `folder` itself has no answer. */
  project?: string
  title?: string
}

/** A point on the screen in points, from its top left, as the simulator draws it now (rotation included). */
export interface SimulatorPoint {
  x: number
  y: number
}

/** The keys an agent presses by name; anything typed goes through `type`. */
export type SimulatorKey = "return" | "backspace" | "tab" | "escape" | "space" | "up" | "down" | "left" | "right"

export type SimulatorOrientation = "portrait" | "landscape-left" | "landscape-right" | "portrait-upside-down"

/** One thing done to a simulator, with a real touch where it's a touch. */
export type SimulatorAction =
  | { kind: "open-url"; url: string }
  | { kind: "tap"; at: SimulatorPoint }
  /**
   * One finger's touch as it goes, as the panel sends a drag: down, its moves as they happen, and up. iOS reads the
   * speed of the last moves, so a drag flings as it would on a phone. A gesture an agent makes is a tap or a swipe.
   */
  | { kind: "touch"; phase: "begin" | "move" | "end"; at: SimulatorPoint }
  | { kind: "swipe"; from: SimulatorPoint; to: SimulatorPoint; ms?: number }
  | { kind: "pinch"; at: SimulatorPoint; scale: number; ms?: number }
  | { kind: "type"; text: string }
  | { kind: "key"; key: SimulatorKey }
  | { kind: "rotate"; to: SimulatorOrientation }
  /** The software keyboard shown or hidden. */
  | { kind: "keyboard"; shown: boolean }
  | { kind: "home" }
  /** Safari's Share › Add to Home Screen for the page it shows, then opening it from there. */
  | { kind: "add-to-home-screen" }

/** What `read` reads: the page Safari shows (through WebKit's inspector), its console since a cursor, or the screen's accessibility tree. */
export type SimulatorReadKind = "page" | "console" | "accessibility"

export type SimulatorRefusalReason =
  /** No host here can do it: its blocker says why. */
  | "unavailable"
  /** Another Thread holds the simulator. */
  | "held"
  /** This Thread held it once and has since lost it. */
  | "stale"
  /** Nobody holds it: `simulator_open` takes it first. */
  | "not-open"
  | "not-found"
  /** The person hasn't let agents use simulators in this project. */
  | "not-allowed"
  /** The caller's Session belongs to no Thread on this host. */
  | "no-thread"
  /** This host can't do that operation. */
  | "unsupported"
  /** The simulator's Mac isn't connected now, or didn't answer in time. */
  | "unreachable"
  /** The simulator's Mac lends this caller no simulator: its Thread holds no session lease there. */
  | "not-offered"

export interface SimulatorRefused {
  refused: SimulatorRefusalReason
  why: string
  /** Who holds it, for `held`. */
  holder?: SimulatorClaim
}

export type SimulatorsListInput = Record<string, never>
export interface SimulatorsListed {
  hosts: SimulatorHostSummary[]
  simulators: ListedSimulator[]
  consent: SimulatorConsent
}
export type SimulatorsListResult = SimulatorsListed | SimulatorRefused

export interface SimulatorsOpenInput {
  /** Its ID from `simulator_list`. */
  simulator: string
  /** Its host, from `simulator_list`: a simulator ID means nothing without it. */
  host: string
  /** A page to open in Safari once it's up. */
  url?: string
}
export interface SimulatorsOpened {
  simulator: ListedSimulator
  claim: SimulatorClaim
  next: string
}
export type SimulatorsOpenResult = SimulatorsOpened | SimulatorRefused

export interface SimulatorsActInput {
  simulator: string
  host: string
  action: SimulatorAction
}
export interface SimulatorsActed {
  /** How long the host took to do it. */
  ms: number
}
export type SimulatorsActResult = SimulatorsActed | SimulatorRefused

export interface SimulatorsReadInput {
  simulator: string
  host: string
  what: SimulatorReadKind
  /** For `console`: the cursor an earlier read returned. */
  after?: number
}
export interface SimulatorsRead {
  what: SimulatorReadKind
  /** What the host read, as JSON. */
  state: unknown
  cursor?: number
}
export type SimulatorsReadResult = SimulatorsRead | SimulatorRefused

export interface SimulatorsShotInput {
  simulator: string
  host: string
  /** The picture's bytes in the answer as well: what another Mac asks for, since this Mac's path means nothing there. */
  inline?: boolean
}
export interface SimulatorsShot {
  /** A PNG or JPEG the host wrote, for `show`, on the caller's own Mac. */
  path: string
  width: number
  height: number
  /** The picture, base64, when `inline` was asked and it's within `SHOT_INLINE_LIMIT`. */
  inline?: { type: "image/png" | "image/jpeg"; data: string }
  /** A picture too large to go inline, given to the caller's session lease as an artifact, for a caller under one. */
  artifact?: SimulatorArtifact
}

/** A file a lent simulator session made, as its lease lists it: by name, the SHA-256 of its bytes, and size. */
export interface SimulatorArtifact {
  name: string
  hash: string
  size: number
}
export type SimulatorsShotResult = SimulatorsShot | SimulatorRefused

/** The most of a picture an answer carries inline, well inside every hop's limit once it's base64. */
export const SHOT_INLINE_LIMIT = 512 * 1024

export interface SimulatorsRecordInput {
  simulator: string
  host: string
  recording: "start" | "stop"
}
export interface SimulatorsRecorded {
  /** The recording's file, once stopped. */
  path?: string
  /** For a caller under a session lease, the stopped recording given to its lease (the file stays on its Mac). */
  artifact?: SimulatorArtifact
}
export type SimulatorsRecordResult = SimulatorsRecorded | SimulatorRefused

export interface SimulatorsReleaseInput {
  simulator: string
  host: string
}
export type SimulatorsReleaseResult = { released: boolean } | SimulatorRefused

/**
 * A viewer reading a simulator's screen: what it was sent since its last read, as one `ControlVideoBatch` (base64),
 * the same poster, key and delta packets as a browser preview's, so every client decodes one format. A read waits up
 * to `waitMs` for something to send. Anyone may watch; watching drives nothing.
 */
export interface SimulatorsWatchInput {
  simulator: string
  host: string
  /** The viewer's own name for its stream, unique on the simulator: a random UUID will do. */
  viewer: string
  /** The box it draws in, in pixels, so the host never sends more than it shows. */
  box?: { width: number; height: number }
  waitMs?: number
  /**
   * The sequence of the newest picture this viewer's decoder drew, when it drew one since its last read: how the host
   * learns its H.264 really decodes, and which capture it was that did.
   */
  decoded?: number
  /** This viewer is done: it stops watching at once, and a screen nobody else watches stops streaming. */
  leave?: boolean
}
export interface SimulatorsWatched {
  /** False once the screen stopped streaming: nothing more comes until a viewer watches again. */
  live: boolean
  /** An encoded `ControlVideoBatch`, base64. */
  batch: string
}
export type SimulatorsWatchResult = SimulatorsWatched | SimulatorRefused

/** The longest one watch read waits for a packet: under every hop's idle limit, and short enough to notice a viewer gone. */
export const WATCH_WAIT_MS = 2_000

export type SimulatorVerb = "list" | "open" | "act" | "read" | "shot" | "record" | "release" | "watch"

export interface SimulatorToolDefinition {
  verb: SimulatorVerb
  channel: `mako:simulators-${SimulatorVerb}`
  replay: HostCallReplay
  mcp: {
    name: `simulator_${SimulatorVerb}`
    description: string
    /** One line per input, for the model; the shape itself is the host call's. */
    fields: Readonly<Record<string, string>>
    annotations: { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean }
  }
}

const SIMULATOR = "Its ID from simulator_list."
const HOST = "Its host's ID from simulator_list; simulator IDs are unique only on their host."

export const SIMULATOR_TOOLS: readonly SimulatorToolDefinition[] = [
  {
    verb: "list",
    channel: "mako:simulators-list",
    replay: "read",
    mcp: {
      name: "simulator_list",
      description: "The iPhone and iPad simulators this Mac and the person's other Macs can run, each with its state and the Thread that drives it, and each host with what it can't run and why. A simulator on another Mac is named by its host (mac:<device>) and its ID together.",
      fields: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
  },
  {
    verb: "open",
    channel: "mako:simulators-open",
    replay: "replay",
    mcp: {
      name: "simulator_open",
      description: "Boot a simulator if it isn't running and take it for this Thread, opening a page in Safari if you give one. One Thread drives a simulator at a time: refused while another holds it, with who. Release it when you're done. On another of the person's Macs, pass its host as mac:<device>.",
      fields: { simulator: SIMULATOR, host: HOST, url: "A page to open in Safari once it's up." },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
  },
  {
    verb: "act",
    channel: "mako:simulators-act",
    replay: "never",
    mcp: {
      name: "simulator_act",
      description: "Do one thing on a simulator this Thread holds, with a real touch where it's a touch: open-url, tap, swipe, pinch, type, key, rotate, keyboard, home, add-to-home-screen. Points are in the screen's points from its top left. Read or take a shot after, to see what it did; an action whose answer was lost isn't repeated for you.",
      fields: { simulator: SIMULATOR, host: HOST, action: "The action, by its kind and what it takes." },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
  },
  {
    verb: "read",
    channel: "mako:simulators-read",
    replay: "read",
    mcp: {
      name: "simulator_read",
      description: "Read a simulator this Thread holds: page (the page Safari shows, through WebKit's inspector: its URL, viewport and keyboard, scroll positions, layout, and Mako's web client's own probe), console (messages and errors since a cursor), or accessibility (the screen's elements).",
      fields: { simulator: SIMULATOR, host: HOST, what: "page, console or accessibility.", after: "For console: the cursor an earlier read returned." },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
  },
  {
    verb: "shot",
    channel: "mako:simulators-shot",
    replay: "read",
    mcp: {
      name: "simulator_shot",
      description: "A screenshot of a simulator, as a PNG file you can show.",
      fields: { simulator: SIMULATOR, host: HOST },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
  },
  {
    verb: "record",
    channel: "mako:simulators-record",
    replay: "replay",
    mcp: {
      name: "simulator_record",
      description: "Start or stop recording a simulator this Thread holds; stopping gives the recording's file.",
      fields: { simulator: SIMULATOR, host: HOST, recording: "start or stop." },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
  },
  {
    verb: "release",
    channel: "mako:simulators-release",
    replay: "replay",
    mcp: {
      name: "simulator_release",
      description: "Let a simulator go so another Thread can drive it. It keeps running, unless its host is billed, which stops it.",
      fields: { simulator: SIMULATOR, host: HOST },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
  },
  {
    verb: "watch",
    channel: "mako:simulators-watch",
    replay: "read",
    mcp: {
      name: "simulator_watch",
      description: "The next packets of a simulator's screen, as one ControlVideoBatch: a poster then key and delta frames, the same format as a browser preview. Anyone may watch. Call again with the same viewer for more; live false means the stream ended.",
      fields: {
        simulator: SIMULATOR,
        host: HOST,
        viewer: "This viewer's own name for its stream, unique on the simulator.",
        box: "The box it draws in, in pixels.",
        waitMs: "How long to wait for a packet, up to two seconds.",
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
  },
]

/** What `simulator_open` tells its caller to do next. */
export const AFTER_OPEN = "Drive it with simulator_act, look with simulator_shot or simulator_read, and simulator_release it when you're done."
