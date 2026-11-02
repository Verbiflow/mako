import type { AccessTier } from "./access.js"
import { ROLE_WORD, type AgentCaller, type AgentRefused, type Artifact, type Brief, type ChildOrigin, type ChildRole, type ChildState, type ReportStatus, type StartMode, type WakeOn } from "./agents.js"
import type { HostCallReplay } from "./host-call-policy.js"

/**
 * The orchestration operations, each defined once: a host call
 * `mako:agents-<verb>` (so the socket, the gateway and a cloud machine's host
 * all serve it with no code of their own), its input and result, its replay
 * class, and its MCP projection. Every door is a projection of this table: the
 * in-Thread `mako` server, `mako agents <verb>` and `mako mcp`. The MCP tool's
 * input schema is the host call's generated schema (`host-call-inputs.ts`)
 * without the inputs its door fills in, so a door can't drift from the call.
 */

/** Filled by a door, never by the model: the folder a child starts in when none is named. */
interface DoorFilled {
  cwd?: string
}

export interface AgentsStartInput extends DoorFilled {
  brief: Brief
  /** Unique among the caller's children; made from the brief when absent. */
  name?: string
  /** Absent: the caller's own harness. */
  harness?: string
  model?: string
  reasoning?: string
  /** At most the caller's tier; absent means the caller's. */
  access?: AccessTier
  /** `here`, `device:<name>` or `cloud`, from what the person said; absent means where the caller runs. */
  place?: string
  /** Its own Git worktree of the caller's repository: on `branch` if it exists, else a new branch from `base` (default: the newest). Absent: the caller's folder. */
  workspace?: { branch?: string; base?: string }
  title?: string
  role?: ChildRole
  /** `background` (absent): the answer comes at once. `wait`: the answer holds its result if it comes within the door's window, and else its result starts the caller's next turn. */
  mode?: StartMode
  /** Which of its reports wake the caller (`reportRoute`); absent: `decisions`. */
  wake?: WakeOn
  /** A `wait`'s window, at most `WAIT_LIMIT_MS`. */
  timeoutMs?: number
  /** The caller's own key for this spawn: a repeat with the same key answers the same child. */
  clientKey: string
}

/** A report as a `wait` answer carries it: in full, as `agents_read` gives it. */
export interface WaitedReport {
  status: ReportStatus
  summary: string
  artifacts?: Artifact[]
  question?: string
}

/**
 * How a `wait` start's window ended: with the child's result, with a question
 * it asks (`answers` says whose it is), or with neither, when its result
 * starts the caller's next turn (`settled-only`, never steered into a turn).
 */
export type StartWaited =
  | { outcome: "result"; report: WaitedReport }
  | { outcome: "question"; question: string; answers: "you" | "the person"; report?: WaitedReport }
  | { outcome: "pending" }

export interface AgentsStarted {
  /** Its Thread; absent while it's queued, when its name addresses it. */
  child?: string
  name: string
  /** The child's conversation on this host, which `mako watch` and the window open. */
  conversation?: string
  /** How it stands as this answer is given: a repeat of a spawn whose child has since ended says so. */
  state: ChildState["kind"]
  /** What it waits for, when queued. */
  why?: string
  tree: { running: number; started: number; of: { running: number; started: number } }
  /** A repeat of an earlier spawn: this is that spawn's child. */
  deduped?: true
  /** A `wait` start's outcome; a repeat of one answers its result again. */
  waited?: StartWaited
  next: string
}
export type AgentsStartResult = AgentsStarted | AgentRefused

export interface AgentsLinkInput {
  /** Its harness's ID for its Session, as its transcript names it. */
  session: string
  harness: string
  /** Its process while it runs; leave it out for one that has ended. */
  pid?: number
  name?: string
  role?: ChildRole
}
export type AgentsLinkResult = { child: string; name: string; origin: ChildOrigin; deduped?: true } | AgentRefused

export interface AgentsListInput {
  /** `tree` adds every descendant, each under its parent. */
  scope?: "children" | "tree"
}
export interface AgentStrip {
  child: string
  name: string
  /** Its parent's child name, for a descendant listed with `scope: tree`. */
  under?: string
  harness: string
  model?: string
  origin: ChildOrigin
  state: ChildState
  title?: string
  toolUses?: number
  /** Its last report, as one line. */
  report?: { status: ReportStatus; line: string; at: number }
  startedAt: number
}
export type AgentsListResult = { children: AgentStrip[]; tree: AgentsStarted["tree"] } | AgentRefused

export interface AgentsReadInput {
  /** The child's name or Thread ID. */
  child: string
  view?: "report" | "transcript"
  maxChars?: number
}
export type AgentsReadResult = { child: string; name: string; state: ChildState; text: string; truncated?: true } | AgentRefused

export interface AgentsReportInput {
  status: ReportStatus
  /** Its first sentence is the line your parent's digest shows. */
  summary: string
  artifacts?: Artifact[]
  question?: string
  /** A repeat with the same key is the same report. */
  clientKey: string
}
export type AgentsReportResult = { id: string; deduped?: true; delivered: "notice" | "none" } | AgentRefused

export interface AgentsSendInput {
  /** The child's name or Thread ID. */
  to: string
  /** Pass on the person's message this turn answers, word for word, as theirs: the host fills it in, so the call stays short. */
  forward?: boolean
  /** The sender's own words: with `forward`, what it adds beneath the person's; without, the whole message. */
  text?: string
  /** A repeat with the same key is the same message. */
  clientKey: string
}
export interface AgentsSent {
  child: string
  name: string
  /** The request the message is in the child's conversation: a redirect names it. */
  request: string
  /** It started the child's next turn (an idle or finished child: the same Thread, a new task), joined its running turn at the next step, or waits for that turn to end. */
  delivery: "turn" | "steer" | "queued"
  deduped?: true
}
export type AgentsSendResult = AgentsSent | AgentRefused

export interface AgentsStopInput {
  /** The child's name or Thread ID, or `all` for every child of the caller. */
  child: string
  reason?: string
}
export type AgentsStopResult = { stopped: string[] } | AgentRefused

export interface AgentsWaitInput {
  /** Names or Thread IDs; absent: every child of the caller. */
  children?: string[]
  /** At most `WAIT_LIMIT_MS`. */
  timeoutMs?: number
  /** The cursor a previous wait returned; reports after it count. */
  after?: number
}
export type AgentsWaitResult = { reports: { child: string; name: string; status: ReportStatus; line: string; at: number }[]; cursor: number; timedOut: boolean } | AgentRefused

/** The operations an engine answers; each door calls one of these through its host call. */
export interface AgentOperations {
  start(caller: AgentCaller, input: AgentsStartInput): Promise<AgentsStartResult>
  link(caller: AgentCaller, input: AgentsLinkInput): Promise<AgentsLinkResult>
  list(caller: AgentCaller, input: AgentsListInput): Promise<AgentsListResult>
  read(caller: AgentCaller, input: AgentsReadInput): Promise<AgentsReadResult>
  report(caller: AgentCaller, input: AgentsReportInput): Promise<AgentsReportResult>
  send(caller: AgentCaller, input: AgentsSendInput): Promise<AgentsSendResult>
  stop(caller: AgentCaller, input: AgentsStopInput): Promise<AgentsStopResult>
  wait(caller: AgentCaller, input: AgentsWaitInput): Promise<AgentsWaitResult>
}
export type AgentVerb = keyof AgentOperations

/** What the MCP door shows the model of one operation. */
export interface AgentToolProjection {
  name: `agents_${AgentVerb}`
  description: string
  /** One line per input, for the model; the shape itself is the host call's. */
  fields: Readonly<Record<string, string>>
  annotations: { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean }
}

export interface AgentToolDefinition {
  verb: AgentVerb
  channel: `mako:agents-${AgentVerb}`
  replay: HostCallReplay
  /** Inputs the door fills in; the MCP schema leaves them out. */
  filled: readonly (keyof AgentToolFilled)[]
  mcp: AgentToolProjection
}

/** What a door knows of its caller and fills in for it. */
export interface AgentToolFilled {
  /** The folder the caller works in: a start's, unless it names one. */
  cwd?: string
}

/** The environment variable naming the Session whose agent started a process (`applyThreadEnvironment`): discovery's key, and a command's caller. */
export const SESSION_VARIABLE = "MAKO_SESSION_ID"

/**
 * The longest a wait (`agents_wait`, a `wait` start) holds a call on any door:
 * half the 60 s after which Cursor's MCP client, and any client left at the
 * MCP default, ends a tool call, so the start's own launch fits too. A longer
 * one would hold the caller's turn open with nothing to show; past it, the
 * result wakes the caller instead.
 */
export const WAIT_LIMIT_MS = 30_000
const WAIT_WORDS = `${WAIT_LIMIT_MS / 1000} seconds`

/** What a background spawn's answer tells its caller to do next. */
export const AFTER_START = "Its report wakes you. End your turn or keep working; don't wait or poll."

/** What a start's answer tells its caller to do next: by how it asked to hear back, and how a wait's window ended. */
export function afterStart(wake: WakeOn, waited?: StartWaited): string {
  if (waited?.outcome === "result") return "It finished: its report is above. Go on with it."
  if (waited?.outcome === "pending") return "It's still working. End your turn now: its result starts your next turn. Don't wait or poll."
  if (waited?.outcome === "question")
    return waited.answers === "you"
      ? "It needs a decision from you: tell the person, or stop it with agents_stop. Its result starts a turn of yours once it finishes."
      : "It asks the person, who answers it in its Thread. End your turn: its result starts your next turn."
  if (wake === "finish") return "Its result wakes you; its questions go to the person. End your turn or keep working; don't wait or poll."
  if (wake === "never") return "Nothing it reports wakes you, and its questions go to the person: read it with agents_read when you need it."
  return AFTER_START
}

/**
 * The paragraph the `mako` server's instructions carry on every harness, with
 * the role's word from `ROLE_WORD`. The routing workstream proposes changes
 * to it; it's written here once.
 */
export const ORCHESTRATION_INSTRUCTIONS = [
  "agents_*: other Threads this Thread starts and leads; it is their " + ROLE_WORD + ".",
  "Background, parallel, cross-harness or remote work goes through `agents_start` (from a shell, `mako agents start` is the same tool).",
  "Use `agents_start` for parallel or background work even when your harness has its own subagent tool; keep that tool for a quick look you wait for.",
  "Start a Thread only when parallel work helps: a one-file change, a question, or work that needs your own context is faster in your turn.",
  "Don't run an agent CLI with nohup: one you start from your shell still shows as your child, but it can't report, ask or take messages.",
  "After starting, end your turn: reports wake you. Don't poll `agents_list` or wait in a loop; when your next step needs a child's result, start it with `mode: \"wait\"`.",
  "The person writes to this Thread, not to its Threads: a message for one of them goes there with `agents_send` (`forward: true`) as your first call, then end your turn.",
  "If you were started by another Thread, call `agents_report` when you finish, are blocked, or need a decision; ending your turn without one reports how it ended.",
].join(" ")

/** A child as the front door's note shows it to its lead: typed facts the host already holds, never its transcript. */
export interface FrontDoorChild {
  name: string
  /** Its harness's name, as the person reads it. */
  harness: string
  state: ChildState
  /** What it was asked, its first sentence. */
  topic: string
  branch?: string
  report?: { status: ReportStatus; line: string; at: number }
  /** The person's newest words to it directly, in its own Thread. */
  direct?: { line: string; at: number }
}

/** Children the note lists by name; the rest are counted, and `agents_list` has them. */
export const FRONT_DOOR_LISTED = 16

/**
 * What a lead hears before each message the person sends it (Mako's control
 * note, never shown as the person's words): its Threads as they stand, and how
 * to route the message. It's read from typed state, so routing costs no read
 * of any transcript and no tool call before the one that sends it on.
 */
export function frontDoorNote(children: readonly FrontDoorChild[], now: number): string[] {
  if (!children.length) return []
  const listed = [...children].sort((a, b) => routeOrder(a.state) - routeOrder(b.state)).slice(0, FRONT_DOOR_LISTED)
  const more = children.length - listed.length
  return [
    `You're this Thread's ${ROLE_WORD}: the person writes to you, and you decide who handles it. Your Threads now:`,
    ...listed.map((child) => frontDoorLine(child, now)),
    ...(more > 0 ? [`… and ${more} more (agents_list).`] : []),
    "If the message is for one of them (its work, its branch, what it asked or reported), call agents_send {to, forward: true} first, adding text only for what it can't know, and end your turn. A finished one takes it as its next task, in its own Thread.",
    "If it's for you, or about how they stand, answer from this list. If none fits and it's work worth a Thread, use agents_start; otherwise do it yourself.",
  ]
}

function frontDoorLine(child: FrontDoorChild, now: number): string {
  const parts = [`- child:${child.name} · ${child.harness} · ${stateWords(child.state, child.report, now)}`, `asked: ${child.topic}`]
  if (child.branch) parts.push(`branch ${child.branch}`)
  if (child.report && child.state.kind !== "ended") parts.push(`last report (${child.report.status}, ${ago(child.report.at, now)}): ${child.report.line}`)
  if (child.direct) parts.push(`the person wrote to it directly ${ago(child.direct.at, now)}: "${child.direct.line}"`)
  return parts.join(" · ")
}

function stateWords(state: ChildState, report: FrontDoorChild["report"], now: number): string {
  switch (state.kind) {
    case "working":
      return `working${state.phase ?? state.step ? `: ${state.phase ?? state.step}` : ""}`
    case "starting":
      return "starting"
    case "queued":
      return `queued, ${state.ahead} ahead`
    case "idle":
      return "idle"
    case "blocked":
      return `waits on ${state.on === "lead" ? "you" : "the person"}: ${state.question}`
    case "ended":
      return `${state.outcome}${report ? ` ${ago(report.at, now)}: ${report.line}` : state.reason ? `: ${state.reason}` : ""}`
  }
}

/** Live work first, then what waits, then what's finished: what a message is most likely for comes first. */
function routeOrder(state: ChildState): number {
  return state.kind === "blocked" ? 0 : state.kind === "working" || state.kind === "starting" ? 1 : state.kind === "queued" || state.kind === "idle" ? 2 : 3
}

function ago(at: number, now: number): string {
  const minutes = Math.max(0, Math.round((now - at) / 60_000))
  if (minutes < 1) return "just now"
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  return hours < 48 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`
}

const START = [
  "Start another Thread that works for this one: its own Session on any harness, in this checkout or its own worktree and branch, with its own model and access (at most yours).",
  "Use it for work that outlives this turn, runs in parallel with other work, writes code beside another writer, needs another harness or model, or should be something the person can open and steer.",
  "Don't use it for a one-file change, a question you can answer, or work that needs this conversation's own context: do those in your turn.",
  "The brief is everything it knows; it sees none of this conversation.",
  "By default it returns at once and its reports wake you (mode background, wake decisions): use that whenever you have other work or can end your turn.",
  "Use mode wait only when your next step can't go on without its result: you get the result here if it comes within " + WAIT_WORDS + ", else your turn ends and the result starts your next one.",
  "Don't wait or poll after starting.",
].join(" ")

export const AGENT_TOOLS: readonly AgentToolDefinition[] = [
  {
    verb: "start",
    channel: "mako:agents-start",
    replay: "replay",
    filled: ["cwd"],
    mcp: {
      name: "agents_start",
      description: START,
      fields: {
        brief: "objective: what to do and why, with everything it needs; doneWhen: the checks that say it's done; boundaries: what not to touch; output: what its report must carry.",
        name: "A short name, unique among this Thread's children (made from the brief when absent).",
        harness: "claude, codex, cursor, grok, opencode or devin; this Thread's own when absent.",
        model: "A model the harness lists; its default when absent.",
        reasoning: "A reasoning level the model takes.",
        access: "plan, chat, ask, edits, auto, full or deny: at most this Thread's own; this Thread's when absent.",
        place: "Only when the person said where: here, device:<name> or cloud. Absent: where this Thread runs.",
        workspace: "Its own worktree: on branch if it exists, else a new branch from base. Absent: this Thread's folder, for reading or one writer.",
        title: "A few words the person sees for it.",
        role: "worker (default), reviewer, verifier, researcher, or lead for a sub-lead that starts its own.",
        mode: "background (default): returns at once; work on or end your turn. wait: only when your next step needs its result; you get it here if it's quick, else your turn ends and the result starts your next turn. Never wait on work that can run while you do other things.",
        wake: "What wakes you: decisions (default: it finished, failed, is blocked or asks), finish (only its result; its questions go to the person), or never (nothing; read it with agents_read; its questions go to the person).",
        timeoutMs: `For wait: how long to hold for its result here, at most ${WAIT_LIMIT_MS} (the default).`,
        clientKey: "Your own key for this spawn: a repeat with it answers the same child.",
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
  },
  {
    verb: "link",
    channel: "mako:agents-link",
    replay: "replay",
    filled: [],
    mcp: {
      name: "agents_link",
      description: "Make an agent CLI run that this Thread's shell started one of its children, as agents_start's are: its harness and session ID, and its pid while it runs (leave pid out for one that ended). Runs a shell started are usually found on their own. Refused for this Thread itself or one that leads it.",
      fields: { session: "Its harness's ID for its session.", harness: "Its harness.", pid: "Its process, while it runs.", name: "A short name for it.", role: "What it is to this Thread." },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
  },
  {
    verb: "list",
    channel: "mako:agents-list",
    replay: "read",
    filled: [],
    mcp: {
      name: "agents_list",
      description: "This Thread's children as they stand: name, harness, state, last step and last report. Reports wake you on their own, so read this when you need the whole picture, not to wait.",
      fields: { scope: "children (default) or tree, which adds every descendant." },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
  },
  {
    verb: "read",
    channel: "mako:agents-read",
    replay: "read",
    filled: [],
    mcp: {
      name: "agents_read",
      description: "One child's last report in full, or the end of its transcript: a bounded window, for when its digest line isn't enough.",
      fields: { child: "Its name or Thread ID.", view: "report (default) or transcript.", maxChars: "At most this many characters (default 8000)." },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
  },
  {
    verb: "report",
    channel: "mako:agents-report",
    replay: "replay",
    filled: [],
    mcp: {
      name: "agents_report",
      description: "Tell the Thread that started this one how its work stands: done, failed, blocked or needs-input (which wake it), or progress (which doesn't). Its first sentence is the line it reads.",
      fields: {
        status: "done, failed, blocked, needs-input or progress.",
        summary: "What happened, first sentence first; where to read more.",
        artifacts: "Branches, commits, pull requests, files, screenshots or test runs, each by reference.",
        question: "For blocked or needs-input: the decision you need.",
        clientKey: "Your own key for this report: a repeat with it is the same report.",
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
  },
  {
    verb: "send",
    channel: "mako:agents-send",
    replay: "replay",
    filled: [],
    mcp: {
      name: "agents_send",
      description: [
        "Give one of this Thread's children a message: the person's (forward: true passes on the one this turn answers, word for word, so don't retype it) or your own.",
        "An idle or finished child takes it as its next task in its own Thread; a working one hears it at its next step, or when its turn ends.",
        "It returns at once; what the child does reports back as its work does.",
      ].join(" "),
      fields: {
        to: "The child's name or Thread ID.",
        forward: "true: pass on the person's message this turn answers, as their words.",
        text: "Your own words: beneath the person's with forward, else the whole message.",
        clientKey: "Your own key for this message: a repeat with it is the same message.",
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
  },
  {
    verb: "stop",
    channel: "mako:agents-stop",
    replay: "replay",
    filled: [],
    mcp: {
      name: "agents_stop",
      description: "Stop one of this Thread's children (its running turn, or its process and everything it started), or all of them.",
      fields: { child: "Its name or Thread ID, or all.", reason: "Why, for its transcript and your digest." },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
  },
  {
    verb: "wait",
    channel: "mako:agents-wait",
    replay: "read",
    filled: [],
    mcp: {
      name: "agents_wait",
      description: `Wait up to ${WAIT_WORDS} for a child's next report. Reports wake you without it: end your turn instead. When your next step needs one child's result, start it with mode wait rather than calling this.`,
      fields: { children: "Names or Thread IDs; all children when absent.", timeoutMs: `At most ${WAIT_LIMIT_MS}.`, after: "The cursor an earlier wait returned." },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
  },
]

