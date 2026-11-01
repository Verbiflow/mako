import type { AccessTier } from "./access.js"
import { ROLE_WORD, type AgentCaller, type AgentRefused, type Artifact, type Brief, type ChildOrigin, type ChildRole, type ChildState, type ReportStatus } from "./agents.js"
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
  /** The caller's own key for this spawn: a repeat with the same key answers the same child. */
  clientKey: string
}
export interface AgentsStarted {
  child: string
  name: string
  /** The child's conversation on this host, which `mako watch` and the window open. */
  conversation?: string
  state: "queued" | "starting" | "working"
  /** What it waits for, when queued. */
  why?: string
  tree: { running: number; started: number; of: { running: number; started: number } }
  /** A repeat of an earlier spawn: this is that spawn's child. */
  deduped?: true
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

export interface AgentsStopInput {
  /** The child's name or Thread ID, or `all` for every child of the caller. */
  child: string
  reason?: string
}
export type AgentsStopResult = { stopped: string[] } | AgentRefused

export interface AgentsWaitInput {
  /** Names or Thread IDs; absent: every child of the caller. */
  children?: string[]
  /** At most 12 s on the in-Thread server, which times a request out at 15 s. */
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
  filled: readonly string[]
  mcp: AgentToolProjection
}

/** What every spawn's answer tells its caller to do next. */
export const AFTER_START = "Its report wakes you. End your turn or keep working; don't wait or poll."

/**
 * The paragraph the `mako` server's instructions carry on every harness, with
 * the role's word from `ROLE_WORD`. The routing workstream proposes changes
 * to it; it's written here once.
 */
export const ORCHESTRATION_INSTRUCTIONS = [
  "agents_*: other Threads this Thread starts and leads; it is their " + ROLE_WORD + ".",
  "Background, parallel, cross-harness or remote work goes through `agents_start` (from a shell, `mako agents start` is the same tool).",
  "Start a Thread only when parallel work helps: a one-file change, a question, or work that needs your own context is faster in your turn.",
  "Don't run an agent CLI with nohup: one you start from your shell still shows as your child, but it can't report, ask or take messages.",
  "After starting, end your turn: reports wake you. Don't poll `agents_list` or wait in a loop.",
  "If you were started by another Thread, call `agents_report` when you finish, are blocked, or need a decision; ending your turn without one reports how it ended.",
].join(" ")

const START = [
  "Start another Thread that works for this one: its own Session on any harness, in this checkout or its own worktree and branch, with its own model and access (at most yours).",
  "Use it for work that outlives this turn, runs in parallel with other work, writes code beside another writer, needs another harness or model, or should be something the person can open and steer.",
  "Don't use it for a one-file change, a question you can answer, or work that needs this conversation's own context: do those in your turn.",
  "The brief is everything it knows; it sees none of this conversation.",
  "It returns at once. " + AFTER_START,
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
      description: "Wait up to 12 seconds for a child's next report. Reports wake you without it: end your turn instead. Use it only for a step that truly can't go on without the answer.",
      fields: { children: "Names or Thread IDs; all children when absent.", timeoutMs: "At most 12000.", after: "The cursor an earlier wait returned." },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
  },
]

/** The longest `agents_wait` waits on a door whose requests time out at 15 s. */
export const WAIT_LIMIT_MS = 12_000
