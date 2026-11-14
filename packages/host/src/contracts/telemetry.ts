/**
 * What this install tells Mako about how it is used, and what the person
 * allows. Both kinds are on until they turn them off in Settings → Privacy.
 *
 * `usage`: which harnesses, models, modes and features are used, and how turns
 * end, as counts, durations and code identifiers. `errors`: crash reports and
 * the kinds of native records no decoder understood, with paths, emails and
 * secrets scrubbed out. Neither ever carries a prompt, a reply, a file, a
 * path, a title, a repository or branch name, or a session ID.
 *
 * Who sent it: a random install ID, a salted hash naming the computer, and
 * the Mako account while signed in.
 */
export interface TelemetryChoice {
  usage: boolean
  errors: boolean
}

/**
 * Why nothing is sent whatever the choice: `DO_NOT_TRACK` or
 * `MAKO_TELEMETRY=off` in the environment, a fixture desk, or a build that
 * names no Mako cloud to send to.
 */
export type TelemetryOff = "environment" | "fixture" | "no-cloud"

export interface TelemetryState extends TelemetryChoice {
  off?: TelemetryOff
}

/** Mako's access tiers, as `contracts/access.ts` names them. */
type Access = "plan" | "chat" | "ask" | "edits" | "auto" | "full" | "deny"

export interface TurnTuning {
  harness: string
  model?: string
  /** The value of the harness's reasoning option, such as `high`. */
  effort?: string
  /** The harness's own mode ID, such as `plan` or `acceptEdits`. */
  mode?: string
  access?: Access
}

export interface TelemetryTokens {
  input: number
  cacheRead: number
  cacheWrite: number
  output: number
  reasoning?: number
}

/**
 * The events and their properties. The gateway accepts these names and
 * fields and drops anything else; a change here needs the same change there.
 */
export interface ProductEvents {
  "app.started": { startupMs?: number; firstRun: boolean; signedIn: boolean }
  /** Once a day while a window is open: what this install has, for adoption and harness share. */
  "app.heartbeat": { harnesses: Array<{ harness: string; version?: string }>; threads: number; signedIn: boolean }
  "thread.created": { harness: string; origin: "new" | "resume"; worktree: boolean; purpose?: string }
  "turn.started": TurnTuning & { attachments: number; actor?: "person" | "agent" | "service"; continuation: boolean }
  "turn.completed": TurnTuning & {
    status: "completed" | "failed" | "interrupted" | "uncertain"
    failure?: string
    interruption?: string
    durationMs?: number
    tokens?: TelemetryTokens
    costUsd?: number
    usage: "complete" | "partial" | "none"
    subagents: number
  }
  "feature.used": { feature: TelemetryFeature; harness?: string }
  /**
   * Once per computer and account, while signed in: the cloud merges this
   * computer's anonymous history into the account's, so one person is one
   * person whether or not they were signed in.
   */
  "account.linked": Record<string, never>
}

export type TelemetryFeature =
  | "thread.forked"
  | "harness.switched"
  | "turn.rewound"
  | "automation.ran"
  | "cloud.signed-in"

/** The Mako cloud's routes this Mac calls, by name, never by path: a path can hold an ID. */
export type CloudRoute = "source-project.control" | "devices.enroll" | "devices.code" | "devices.code-token" | "devices.token" | "devices.list" | "devices.remove" | "devices.quiet" | "devices.owner" | "browsers.list" | "browsers.end" | "sign-ins.list" | "sign-ins.save" | "sign-ins.remove" | "sign-ins.share" | "sign-ins.pull" | "sign-ins.refresh" | "sign-ins.disconnect" | "threads.create" | "threads.prepare" | "threads.standby" | "sessions.list" | "messages.wait" | "messages.edit" | "messages.unwait" | "messages.taken" | "bases.ask" | "bases.standing" | "moves.checkpoint" | "moves.refuse" | "moves.answer" | "moves.hand-over" | "moves.checkpoint-read" | "continues.state" | "continues.carry-on" | "continues.offer" | "continues.press" | "continues.follow" | "returns.begin" | "returns.release" | "returns.cancel" | "returns.give-back" | "returns.done" | "returns.archive" | "returns.state" | "carried-files.list" | "carried-files.put" | "carried-files.remove" | "github-token.read" | "github-token.save" | "github-token.remove" | "github-authorship.read" | "github-authorship.save" | "cloud.harnesses" | "attention.put" | "access.read" | "access.choose" | "borrow.read" | "borrow.answer" | "borrow.revoke" | "borrow.cancel" | "borrow.artifact"

export interface DiagnosticEvents {
  "error.reported": { kind: string; name?: string; message: string; stack?: string; breadcrumbs?: string[] }
  /** Live records no decoder read since the last report, by the version the launch reported; never the record. */
  "native.unknown": { harness: string; version?: string; kind: string; reason: "unknown" | "unreadable"; count: number }
  /**
   * Saved records the readers couldn't read, by the harness version that
   * wrote them (`@mako/sessions/unread-index`): the day's totals, sent with
   * the heartbeat; never the record or its session.
   */
  "records.unread": { harness: string; version?: string; source?: "record" | "observed" | "log" | "install"; kind: string; reason: "unknown" | "unreadable"; count: number; sessions: number }
  /** Where a harness's live stream and its record disagreed beyond what its vocabulary declares, by version; never the entries. */
  "stream.mismatch": { harness: string; version?: string; kind: "stream-only" | "record-only" | "changed" | "order"; type: string; count: number }
  /**
   * One call to the Mako cloud and how it went: `refused` is a 4xx, `failed` a 5xx, `unreachable` no answer.
   * `correlationId` is a random ID sent with the call, which names the same call in the cloud's logs and traces.
   */
  "cloud.request": { route: CloudRoute; outcome: "ok" | "refused" | "failed" | "unreachable"; status?: number; ms: number; correlationId: string }
}

/** What the web app is doing when a reading is taken: a finger on it, a scroll gliding, a Thread opening, or none. */
export type WebActivity = "touch" | "scroll" | "opening" | "idle"

/**
 * How the web app runs on the device, measured there: durations, counts and code identifiers, never a word of a
 * Thread, a name, or an address. Errors' words and frames are scrubbed as the desktop's are.
 */
export interface WebDiagnosticEvents {
  "error.reported": DiagnosticEvents["error.reported"]
  /** Once a page, and again when the screen turns or the window resizes: what every reading after it ran on. */
  "web.page": {
    width: number
    height: number
    /** Device pixels per CSS pixel. */
    scale: number
    /** Opened from the home screen, without the browser's bars. */
    standalone: boolean
    touch: boolean
    browser: "safari" | "chrome" | "firefox" | "edge" | "other"
    browserVersion?: string
  }
  /** The page's main thread was busy this long in one go: by the browser's own measure, or a timer that fired late. */
  "web.long-task": { ms: number; during: WebActivity; source: "longtask" | "timer" }
  /** The browser's layout-shift score above the threshold, where it measures one. */
  "web.layout-shift": { score: number; during: WebActivity }
  /**
   * The app's frame out of step with what the screen shows, by `px`: the page scrolled under a fixed app, wider than
   * the screen (it pans sideways), or its height not the visible viewport's after the keyboard or a turn.
   */
  "web.layout": { kind: "page-scrolled" | "wider-than-screen" | "height-off"; px: number; keyboard: boolean }
  /**
   * One scroll gesture, glide included: its frames, those over budget (25 ms, one and a half at 60 Hz), the longest,
   * and the app's own writes to a scroller while a finger was on it, which put the content back under the finger.
   */
  "web.scroll": { ms: number; frames: number; slow: number; worstMs: number; writes: number; touch: boolean }
  /**
   * A Thread opened: when its newest turn was painted, from what the device kept or from the network, and when it had
   * caught up with the Thread as it stands; `turns` is how many it shows.
   */
  "web.thread-open": { newestMs: number; from: "kept" | "network"; caughtUpMs?: number; turns: number }
  /** The live connection came back `ms` after it dropped for `reason`, and had caught up `caughtUpMs` after that. */
  "web.reconnect": { ms: number; caughtUpMs?: number; reason: "closed" | "offline" | "resumed" | "renewal" }
  /** One step of dictation (`DictationStep`), timed on the device. */
  "web.dictation": {
    step: "started" | "levels" | "stop-pressed" | "stopped" | "failed" | "stop-overdue"
    ms?: number
    restarts?: number
    error?: string
    peak?: number
    meter?: "analyser" | "words"
  }
}

/** One reading the web client's probe took: when, of what, and its measures. */
export type WebReading = { [Key in keyof WebDiagnosticEvents]: { id: string; at: number; name: Key; props: WebDiagnosticEvents[Key] } }[keyof WebDiagnosticEvents]

/**
 * The probe says each reading on the page's `window` as it's taken, a `CustomEvent` of this type whose `detail` is the
 * `WebReading`: every one, before the per-minute limit on what's kept and sent. A test runner collects them by
 * listening from the page's start.
 */
export const WEB_READING_EVENT = "mako:reading"

export interface TelemetryApp {
  version: string
  build?: string
  /** `web`: the web app in a browser, with `os` the device's. */
  distribution: "signed" | "unsigned" | "local" | "development" | "web"
  os: "macOS" | "Windows" | "Linux" | "iOS" | "Android" | "other"
  osVersion?: string
  arch: "arm64" | "x64" | "other"
}

export type TelemetryName = keyof ProductEvents | keyof DiagnosticEvents
export type TelemetryProps = ProductEvents[keyof ProductEvents] | DiagnosticEvents[keyof DiagnosticEvents]

export interface TelemetryEvent {
  id: string
  at: number
  name: TelemetryName
  props: TelemetryProps
}

/** `POST /v1/telemetry`. */
export interface TelemetryBatch {
  install: string
  /** This computer, shared by every install on it (`machine-id.ts`); absent when the system won't say. */
  machine?: string
  sentAt: number
  app: TelemetryApp
  consent: { product: boolean; diagnostics: boolean }
  events: TelemetryEvent[]
}

export const MAX_BATCH_EVENTS = 100

/**
 * The app's own code, whose frames say where an error is: the desktop's archive, or the web app's built files, which
 * its stacks name from the root of its own origin. Every other path is someone's files.
 */
const keepPath = (path: string) => (path.includes("app.asar") || /^\/assets\/[\w.-]+$/.test(path) ? path : "<path>")

/** The gateway scrubs with the same rules again; a change here belongs there too. */
const SCRUBS: Array<(text: string) => string> = [
  (text) => text.replace(/\b(Bearer|Basic)\s+[\w.~+/=-]+/gi, "$1 <secret>"),
  (text) => text.replace(/\b(?:sk|pk|rk|phc|phx|xaat|xapt|ghp|gho|ghu|ghs|github_pat|mako_dc|e2b)[-_][\w-]{8,}/g, "<secret>"),
  (text) => text.replace(/\b(?:token|key|secret|password|code)=[^\s&"']+/gi, "<secret>"),
  (text) => text.replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, "<email>"),
  (text) => text.replace(/(https?:\/\/[^\s/?#]+)[/?#][^\s"')]*/g, "$1/<path>"),
  (text) => text.replace(/(?<![\w.:/])~?\/(?:[\w.@+-]+\/)+[\w.@+-]*/g, keepPath),
  (text) => text.replace(/\b[A-Za-z]:\\(?:[^\\\s"'():]+\\)*[^\\\s"'():]*/g, keepPath),
  (text) => text.replace(/(["'`])[^"'`\n]{40,}\1/g, "$1<text>$1"),
]

/** Secrets, emails, URLs' paths, file paths and long quoted text out of an error's words. */
export function scrub(text: string): string {
  return SCRUBS.reduce((value, rule) => rule(value), text)
}
