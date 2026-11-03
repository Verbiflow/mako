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
  /** The host is there, but Mako's driving of it isn't built yet: it lists, and it refuses to act. */
  | "not-built"
  | "unreachable"

export type SimulatorAvailability = { ready: true } | { ready: false; blocker: SimulatorBlocker; why: string; fix?: string }

export interface SimulatorHostSummary {
  /** `local`, `stand-in`, and later `mac:<device>` for another of the person's Macs. */
  id: string
  /** What the panel and an agent call it: "This Mac", "WebKit stand-in". */
  label: string
  kind: SimulatorHostKind
  platforms: Record<SimulatorPlatform, SimulatorAvailability>
  /** What it found, for Diagnostics: the developer folder, and Xcode's version when there is one. */
  detail?: string
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
  /** A stand-in: a desktop engine at this size, not the platform. */
  standIn?: true
}

/**
 * The one Thread that drives a simulator now. `generation` grows with each new holder, so a late action from a
 * Thread that has lost the simulator is refused as stale rather than landing on someone else's screen.
 */
export interface SimulatorClaim {
  thread: string
  conversation?: string
  /** The Thread's title, for whoever watches. */
  title?: string
  since: number
  /** When its holder last acted: a claim idle for `CLAIM_IDLE_MS` lets go. */
  lastAt: number
  generation: number
}

export interface ListedSimulator extends SimulatorSummary {
  claim?: SimulatorClaim
}

/** Whether the person lets agents in the caller's project use simulators: until they do, no agent there is offered the tools. */
export type SimulatorConsent = "unasked" | "allowed" | "refused"

/** A held simulator lets go after this long with no action from its holder. */
export const CLAIM_IDLE_MS = 30 * 60_000

/**
 * Who calls: an agent, as its door stamps it (the Thread its Session belongs to and the project folder it works in,
 * which consent is per), or the person from the panel. The person may take any simulator over; an agent may act only
 * on one its Thread holds.
 */
export type SimulatorCaller = { kind: "agent"; thread: string; conversation: string; folder: string; title?: string } | { kind: "person" }

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
  /** This host can't do that operation. */
  | "unsupported"

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
export type SimulatorsListResult = SimulatorsListed

export interface SimulatorsOpenInput {
  /** Its ID from `simulator_list`. */
  simulator: string
  /** Its host; `local` when absent. */
  host?: string
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
  host?: string
  action: SimulatorAction
}
export interface SimulatorsActed {
  /** How long the host took to do it. */
  ms: number
}
export type SimulatorsActResult = SimulatorsActed | SimulatorRefused

export interface SimulatorsReadInput {
  simulator: string
  host?: string
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
  host?: string
}
export interface SimulatorsShot {
  /** A PNG the host wrote, for `show`. */
  path: string
  width: number
  height: number
}
export type SimulatorsShotResult = SimulatorsShot | SimulatorRefused

export interface SimulatorsRecordInput {
  simulator: string
  host?: string
  recording: "start" | "stop"
}
export interface SimulatorsRecorded {
  /** The recording's file, once stopped. */
  path?: string
}
export type SimulatorsRecordResult = SimulatorsRecorded | SimulatorRefused

export interface SimulatorsReleaseInput {
  simulator: string
  host?: string
}
export type SimulatorsReleaseResult = { released: boolean } | SimulatorRefused

export type SimulatorVerb = "list" | "open" | "act" | "read" | "shot" | "record" | "release"

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
const HOST = "Its host's ID; this Mac (local) when absent."

export const SIMULATOR_TOOLS: readonly SimulatorToolDefinition[] = [
  {
    verb: "list",
    channel: "mako:simulators-list",
    replay: "read",
    mcp: {
      name: "simulator_list",
      description: "The iPhone and iPad simulators this Mac can run, each with its state and the Thread that drives it, and each host with what it can't run and why.",
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
      description: "Boot a simulator if it isn't running and take it for this Thread, opening a page in Safari if you give one. One Thread drives a simulator at a time: refused while another holds it, with who. Release it when you're done.",
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
      description: "Let a simulator go so another Thread can drive it. It keeps running.",
      fields: { simulator: SIMULATOR, host: HOST },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
  },
]

/** What `simulator_open` tells its caller to do next. */
export const AFTER_OPEN = "Drive it with simulator_act, look with simulator_shot or simulator_read, and simulator_release it when you're done."
