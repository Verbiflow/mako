import type { AccessTier } from "./access.js"
import { FIN_LIMIT } from "./fin-tuning.js"
import { APEX_WORD, FIN_WORD, type AgentCaller, type AgentRefused, type Artifact, type Brief, type ChildOrigin, type ChildRole, type ChildState, type FinDeliver, type FinDelivery, type ReportStatus, type StartMode, type WakeOn } from "./agents.js"
import type { Rollup } from "./children.js"
import type { HostCallReplay } from "./host-call-policy.js"
import type { AskOption, FinAsk } from "./native-agents.js"

/**
 * The orchestration operations, each defined once: a host call
 * `mako:agents-<verb>` (so the socket, the gateway and a cloud machine's host
 * all serve it with no code of their own), its input and result, its replay
 * class, and its MCP projection. Every door is a projection of this table: the
 * in-Thread `mako` server, `mako agents <verb>` and `mako mcp`. The MCP tool's
 * input schema is the host call's generated schema (`host-call-inputs.ts`)
 * without the inputs its door fills in, so a door can't drift from the call.
 */

/** Filled by a door, never by the model: the folder a Fin starts in when none is named. */
interface DoorFilled {
  cwd?: string
}

export interface AgentsStartInput extends DoorFilled {
  brief: Brief
  /** Unique among the caller's Fins; made from the brief when absent. */
  name?: string
  /** Absent: the caller's own harness. */
  harness?: string
  model?: string
  reasoning?: string
  /** True for the model's fast lane (or its harness's fast sibling of it), false for its standard one. */
  fast?: boolean
  /** The number of the person's rule this Fin follows (`finPolicyNote`): its harness and model unless the spawn names them. */
  rule?: number
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
  /** The caller's own Fins, by name or Thread, queued ones too, that it starts after: once each has finished. */
  after?: string[]
  /** True: past the person's limit or the tree's running budget it waits for one to end instead of being refused. */
  queue?: boolean
  /** The caller's own key for this spawn: a repeat with the same key answers the same Fin. */
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
 * How a `wait` start's window ended: with the Fin's result, with a question
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
  /** The Fin's conversation on this host, which `mako watch` and the window open. */
  conversation?: string
  /** How it stands as this answer is given: a repeat of a spawn whose Fin has since ended says so. */
  state: ChildState["kind"]
  /** What it waits for, when queued. */
  why?: string
  /** The Fins it starts after (`after`) that haven't finished yet, by name. */
  after?: string[]
  tree: { running: number; started: number; of: { running: number; started: number } }
  /** The person's Fins at work on this Mac, every tree's, and how many run at once (`FIN_LIMIT` unless they set another). */
  atOnce?: { working: number; of: number }
  /** Set while this Mac is busy (`macLoad`): it starts anyway, and says so, so heavy work goes one at a time. */
  mac?: string
  /** A repeat of an earlier spawn: this is that spawn's Fin. */
  deduped?: true
  /** A `wait` start's outcome; a repeat of one answers its result again. */
  waited?: StartWaited
  /** What it runs on, in words, and the choice passed over for one its harness no longer lists, or its harness at its limit. */
  runsOn?: string
  note?: string
  /** Its Apex's harness was at its limit (until `until`), so it started on the person's next harness; `instead` is another account of that harness with room. */
  limited?: { harness: string; until?: number; instead?: string }
  /** The person's rule it follows, as its row says it. */
  rule?: string
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
  /**
   * `tree` adds every descendant, each under its parent; `crew`, from a Fin, is its Apex and the other Fins it started
   * (`AgentsCrew`); `apexes`, the person's other Apexes on this host (`AgentsApexes`).
   */
  scope?: "children" | "tree" | "crew" | "apexes"
}
export interface AgentStrip {
  child: string
  name: string
  /** Its Apex's name for it, for a descendant listed with `scope: tree`. */
  under?: string
  harness: string
  model?: string
  /** Its model, reasoning and fast lane in words: "Opus 5.5 · High · Fast". */
  runsOn?: string
  /** The person's rule it was started by: "Rule 2 · Anything that isn't frontend". */
  rule?: string
  origin: ChildOrigin
  state: ChildState
  title?: string
  toolUses?: number
  /** Its last report, as one line. */
  report?: { status: ReportStatus; line: string; at: number }
  startedAt: number
}
/**
 * A Fin's view of the work it's part of (`agents_list` with `scope: crew`):
 * its Apex as it stands now, and the other Fins that Apex started, each as
 * the front door's note names it. Typed facts the host holds, never a
 * transcript, so it costs no read of one.
 */
export interface AgentsCrew {
  /** The caller's own name among them. */
  you: string
  apex: {
    title?: string
    harness?: string
    working: boolean
    /** The last thing its transcript shows it doing, while it works. */
    step?: string
    /** What it was asked, its first sentence, when it is a Fin too. */
    asked?: string
  }
  crew: CrewMate[]
}
export type CrewMate = Omit<FrontDoorChild, "direct">

/**
 * The person's other Apexes on this host (`agents_list` with `scope: apexes`),
 * every one outside the caller's own tree whose conversation is open here.
 * Typed facts the host holds, never a transcript, and reading them never
 * wakes or messages one.
 */
export interface AgentsApexes {
  apexes: OtherApex[]
}
export interface OtherApex {
  /** Its Thread, which `agents_send` takes as `apex:<thread>`. */
  thread: string
  title?: string
  harness?: string
  working: boolean
  /** The last thing its transcript shows it doing, while it works. */
  step?: string
  folder?: string
  /** Its worktree's branch, when it has one. */
  branch?: string
  /** Its Fins by where each stands for the person (`rollup`). */
  fins: Rollup
  /**
   * Its open Fins' last reports (or, before one, their state), what needs the person first, at most
   * `APEX_DIGEST_FINS` and how many more; and `said`, the first paragraph of its own last reply.
   */
  digest: { fins: { name: string; line: string }[]; more?: number; said?: string }
}
/** The open Fins one Apex's digest names; the rest are counted. */
export const APEX_DIGEST_FINS = 8
export type AgentsListResult = { children: AgentStrip[]; tree: AgentsStarted["tree"] } | AgentsCrew | AgentsApexes | AgentRefused

export interface AgentsReadInput {
  /** The Fin's name or Thread ID. */
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
  /** The answers the question offers; each a tap for the person. */
  options?: AskOption[]
  /** The option you recommend, by its place in `options`, from 0. */
  recommended?: number
  /** What whoever answers does, in one sentence. */
  action?: string
  /** A repeat with the same key is the same report. */
  clientKey: string
}
export type AgentsReportResult = { id: string; deduped?: true; delivered: "notice" | "none" } | AgentRefused

export interface AgentsSendInput {
  /** The Fin's name or Thread ID, or another of the person's Apexes as `apex:<title or Thread ID>`. */
  to: string
  /** Pass on the person's message this turn answers, word for word, as theirs: the host fills it in, so the call stays short. */
  forward?: boolean
  /** The sender's own words: with `forward`, what it adds beneath the person's; without, the whole message. */
  text?: string
  /** For a working Fin; `queue` when absent. */
  deliver?: FinDeliver
  /** A repeat with the same key is the same message. */
  clientKey: string
}
export interface AgentsSent {
  child: string
  name: string
  /** The request the message is in the Fin's conversation: a redirect names it. */
  request: string
  /**
   * It started the Fin's next turn (an idle or finished Fin: the same Thread, a new task), joined its running turn,
   * waits for that turn to end, or started the next after Mako stopped it.
   */
  delivery: FinDelivery
  /** When the Fin hears it, as its own harness takes a message: one sentence the sender reads. */
  hears: string
  deduped?: true
}
export type AgentsSendResult = AgentsSent | AgentRefused

export interface AgentsAnswerInput {
  /** The Fin's name or Thread ID. */
  to: string
  /** Your answer: one of its options, by its label, or your own words. For an approval, what you say with a refusal. */
  answer?: string
  /** For an approval its harness asks: true allows it once, false refuses it. */
  allow?: boolean
  /** Leave the question to the person: it reaches them on every device, with its options. */
  person?: boolean
  /** A repeat with the same key is the same answer. */
  clientKey: string
}
export interface AgentsAnswered {
  child: string
  name: string
  /** What it answered: a question in its report, its harness's question or approval; `person` when it was left to them. */
  answered: FinAsk["kind"] | "person"
  /** How a report's answer reached it, as a message does. */
  delivery?: FinDelivery
  deduped?: true
}
export type AgentsAnswerResult = AgentsAnswered | AgentRefused

export interface AgentsStopInput {
  /** The Fin's name or Thread ID, or `all` for every Fin of the caller. */
  child: string
  reason?: string
}
export type AgentsStopResult = { stopped: string[] } | AgentRefused

export interface AgentsWaitInput {
  /** Names or Thread IDs; absent: every Fin of the caller. */
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
  answer(caller: AgentCaller, input: AgentsAnswerInput): Promise<AgentsAnswerResult>
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
      ? "It needs a decision from you: answer it with agents_answer, or leave it to the person with agents_answer person: true. Its result starts a turn of yours once it finishes."
      : "It asks the person, who answers it in its Thread. End your turn: its result starts your next turn."
  if (wake === "finish") return "Its result wakes you; its questions go to the person. End your turn or keep working; don't wait or poll."
  if (wake === "never") return "Nothing it reports wakes you, and its questions go to the person: read it with agents_read when you need it."
  return AFTER_START
}

/**
 * The paragraph the `mako` server's instructions carry on every harness, with
 * the roles' words from `APEX_WORD` and `FIN_WORD`. The routing workstream
 * proposes changes to it; it's written here once.
 */
export const ORCHESTRATION_INSTRUCTIONS = [
  `agents_*: other Threads this Thread starts, its ${FIN_WORD}s, which work for it; it is their ${APEX_WORD}.`,
  "Background, parallel, cross-harness or remote work goes through `agents_start` (from a shell, `mako agents start` is the same tool).",
  "Use `agents_start` for parallel or background work even when your harness has its own subagent tool; keep that tool for a quick look you wait for.",
  "Start a Thread only when parallel work helps: a one-file change, a question, or work that needs your own context is faster in your turn.",
  `Pass \`model\`, \`reasoning\` or \`fast\` only as the person said them ("Codex on high", "the fast one"); left out, a ${FIN_WORD} runs on what the person uses.`,
  `Don't run an agent CLI with nohup: one you start from your shell still shows as your ${FIN_WORD}, but it can't report or ask, and a message to it has to stop its run.`,
  `Up to the person's limit of ${FIN_WORD}s run at once (${FIN_LIMIT} unless they set another); past it a start is refused unless you pass \`queue: true\`, which starts it when one ends.`,
  `To run work in order, pass \`after: [<${FIN_WORD} names>]\`: it starts once those finish, and if one fails or is stopped you're woken to decide instead.`,
  `After starting, end your turn: reports wake you. Don't poll \`agents_list\` or wait in a loop; when your next step needs a ${FIN_WORD}'s result, start it with \`mode: "wait"\`.`,
  `The person writes to this Thread, not to its ${FIN_WORD}s: a message for one of them goes there with \`agents_send\` (\`forward: true\`) as your first call, then end your turn.`,
  `A ${FIN_WORD}'s question or approval that wakes you is yours to answer with \`agents_answer\`, within your own access (approvals only on full access); leave it to the person with \`person: true\` when it's theirs to decide. One you leave unanswered for a minute goes to the person too.`,
  `If you're a ${FIN_WORD}, started by another Thread (your ${APEX_WORD}), call \`agents_report\` when you finish, are blocked, or need a decision (with its options and the one you recommend); ending your turn without one reports how it ended.`,
  `Other ${APEX_WORD}es of the person: read them with \`agents_list\` \`scope: apexes\` before touching shared files or branches; reading never wakes them.`,
  `Message another ${APEX_WORD} (\`agents_send\` \`to: apex:<title>\`) only when the person asked you to, or when you need something only it can give or decide (it owns the files or branch you'd change, or its work blocks yours).`,
  "Never message for status, thanks or acknowledgement: their digest already says how they stand. One message with everything it needs; its reply wakes you; don't reply to a reply unless it asks you something.",
].join(" ")

/** A Fin as the front door's note shows it to its Apex: typed facts the host already holds, never its transcript. */
export interface FrontDoorChild {
  name: string
  /** Its harness's name, as the person reads it. */
  harness: string
  state: ChildState
  /** What it was asked, its first sentence. */
  topic: string
  branch?: string
  report?: { status: ReportStatus; line: string; at: number }
  /** The person's newest words to it directly: in its own Thread, or from its Apex's composer. */
  direct?: { line: string; at: number }
}

/** Fins the note lists by name; the rest are counted, and `agents_list` has them. */
export const FRONT_DOOR_LISTED = 16

/**
 * What an Apex hears before each message the person sends it (Mako's control
 * note, never shown as the person's words): its Fins as they stand, and how
 * to route the message. It's read from typed state, so routing costs no read
 * of any transcript and no tool call before the one that sends it on.
 */
export function frontDoorNote(fins: readonly FrontDoorChild[], now: number): string[] {
  if (!fins.length) return []
  const listed = [...fins].sort((a, b) => routeOrder(a.state) - routeOrder(b.state)).slice(0, FRONT_DOOR_LISTED)
  const more = fins.length - listed.length
  return [
    `You're this Thread's ${APEX_WORD}: the person writes to you, and you decide who handles it. Your ${FIN_WORD}s now:`,
    ...listed.map((fin) => frontDoorLine(fin, now)),
    ...(more > 0 ? [`… and ${more} more (agents_list).`] : []),
    "If the message is for one of them (its work, its branch, what it asked or reported), call agents_send {to, forward: true} first, adding text only for what it can't know, and end your turn. A finished one takes it as its next task, in its own Thread; a working one, after its turn unless the message corrects what it's doing now (deliver: steer).",
    "If it's for you, or about how they stand, answer from this list. If none fits and it's work worth a Thread, use agents_start; otherwise do it yourself.",
  ]
}

function frontDoorLine(fin: FrontDoorChild, now: number): string {
  const parts = [`- fin:${fin.name} · ${fin.harness} · ${stateWords(fin.state, fin.report, now)}`, `asked: ${fin.topic}`]
  if (fin.branch) parts.push(`branch ${fin.branch}`)
  if (fin.report && fin.state.kind !== "ended") parts.push(`last report (${fin.report.status}, ${ago(fin.report.at, now)}): ${fin.report.line}`)
  if (fin.direct) parts.push(`the person wrote to it directly ${ago(fin.direct.at, now)}: "${fin.direct.line}"`)
  return parts.join(" · ")
}

function stateWords(state: ChildState, report: FrontDoorChild["report"], now: number): string {
  switch (state.kind) {
    case "working":
      return `working${state.phase ?? state.step ? `: ${state.phase ?? state.step}` : ""}`
    case "starting":
      return "starting"
    case "queued":
      return state.held ? `not started: ${state.held} didn't finish` : state.after?.length ? `starts after ${state.after.join(", ")}` : `queued, ${state.ahead} ahead`
    case "idle":
      return "idle"
    case "blocked":
      return `waits on ${state.on === "lead" ? "you (agents_answer)" : "the person"}: ${state.question}`
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
  `Start a ${FIN_WORD}, another Thread that works for this one: its own Session on any harness, in this checkout or its own worktree and branch, with its own model and access (at most yours).`,
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
        name: `A short name, unique among this Thread's ${FIN_WORD}s (made from the brief when absent).`,
        harness: "claude, codex, cursor, grok, opencode or devin; this Thread's own when absent. When that one's account is at its limit, the person's next harness with room, and the answer says so; one you name at its limit is refused with when it resets and what the person can use instead.",
        model: "Only when the person named one: a model the harness lists, by id or name (\"opus 5.5\", \"gpt-6.1-sol\"). Absent: what the person uses: their Fins default for the harness, else this Thread's own model on this Thread's harness, else their last model there. A model it doesn't list is refused with the ones it does.",
        reasoning: "Only when the person said one (\"on high\"): a level the model takes, such as low, medium, high, xhigh or max. Absent: the level of the model's choice above.",
        rule: "The number of the person's rule that fits this work, from their rules in Mako's note. Its harness and model apply; leave harness, model, reasoning and fast out unless the person named them. Absent: their choice for work no rule fits.",
        fast: "Only when the person asked for it: true for the fast lane (\"the fast one\", quicker and pricier), false for the standard one. A harness whose fast model is a model of its own switches to it.",
        access: "plan, chat, ask, edits, auto, full or deny: at most this Thread's own; this Thread's when absent. A harness without that level runs the Fin on its nearest one below, and one whose every level is above it is refused.",
        place: "Only when the person said where a new Fin runs: here, device:<name> or cloud. Absent: where this Thread runs. To continue this Thread's own work in the cloud, use thread_move instead.",
        workspace: "Its own worktree: on branch if it exists, else a new branch from base; in a project folder of several repositories, branch is every repository's. Absent: this Thread's folder, for reading or one writer.",
        title: "A few words the person sees for it.",
        role: `worker (default), reviewer, verifier, researcher, or lead: an ${APEX_WORD} of its own, which starts its own ${FIN_WORD}s.`,
        mode: "background (default): returns at once; work on or end your turn. wait: only when your next step needs its result; you get it here if it's quick, else your turn ends and the result starts your next turn. Never wait on work that can run while you do other things.",
        wake: "What wakes you: decisions (default: it finished, failed, is blocked or asks), finish (only its result; its questions go to the person), or never (nothing; read it with agents_read; its questions go to the person).",
        timeoutMs: `For wait: how long to hold for its result here, at most ${WAIT_LIMIT_MS} (the default).`,
        after: `Only to order work: your ${FIN_WORD}s, by name or Thread (queued ones too), that must finish first. It waits until each has; if one fails or is stopped it doesn't start, and you're woken to decide.`,
        queue: `true: if the person's limit of ${FIN_WORD}s at once (${FIN_LIMIT} unless they set another) or this tree's running budget is full, it waits for one to end. Absent: a full limit refuses the start, saying so.`,
        clientKey: `Your own key for this spawn: a repeat with it answers the same ${FIN_WORD}.`,
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
      description: `Make an agent CLI run that this Thread's shell started one of its ${FIN_WORD}s, as agents_start's are: its harness and session ID, and its pid while it runs (leave pid out for one that ended). Linking it again with another pid follows it there. Runs a shell started are usually found on their own. Refused for this Thread itself or an ${APEX_WORD} above it.`,
      fields: { session: "Its harness's ID for its session.", harness: "Its harness.", pid: "Its process, while it runs.", name: `A short name for it: its name and title as a ${FIN_WORD}.`, role: "What it is to this Thread." },
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
      description: `This Thread's ${FIN_WORD}s as they stand: name, harness, state, last step and last report. Reports wake you on their own, so read this when you need the whole picture, not to wait. A ${FIN_WORD} reads its ${APEX_WORD} and the other ${FIN_WORD}s it started with scope crew, before work another of them may be doing. Scope apexes reads the person's other ${APEX_WORD}es without waking them.`,
      fields: { scope: `children (default): your ${FIN_WORD}s; tree, which adds every ${FIN_WORD} below them; or, from a ${FIN_WORD}, crew: your ${APEX_WORD} and the other ${FIN_WORD}s it started, what each was asked and last reported; or apexes: the person's other ${APEX_WORD}es, each with its folder, branch, ${FIN_WORD} counts and digest.` },
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
      description: `One ${FIN_WORD}'s last report in full, or the end of its transcript: a bounded window, for when its digest line isn't enough.`,
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
      description: `Tell this Thread's ${APEX_WORD}, the Thread that started it, how its work stands: done, failed, blocked or needs-input (which wake it), or progress (which doesn't). Its first sentence is the line it reads.`,
      fields: {
        status: "done, failed, blocked, needs-input or progress.",
        summary: "What happened, first sentence first; where to read more.",
        artifacts: "Branches, commits, pull requests, files, screenshots or test runs, each by reference.",
        question: "For blocked or needs-input: the decision you need.",
        options: "For a decision: the answers to pick from, each a label of a few words and what it does (detail). The person can pick one with a tap.",
        recommended: "The option you recommend, by its place in options, from 0.",
        action: "What whoever answers does, in one sentence: \"Pick the branch the release goes from.\"",
        clientKey: "Your own key for this report: a repeat with it is the same report.",
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
  },
  {
    verb: "answer",
    channel: "mako:agents-answer",
    replay: "replay",
    filled: [],
    mcp: {
      name: "agents_answer",
      description: [
        `Answer what one of this Thread's ${FIN_WORD}s waits on: the question its report asks, or its harness's own question or approval. The ${FIN_WORD} goes on at once.`,
        "Answer within your own access: an approval only when this Thread is on full access, a question on any.",
        "Leave it to the person (person: true) when it's theirs to decide; it reaches them on every device with its options.",
      ].join(" "),
      fields: {
        to: `The ${FIN_WORD}'s name (fin:<name>) or Thread ID.`,
        answer: "One of its options by its label, or your own words. For an approval you refuse, why.",
        allow: "For an approval: true allows it once, false refuses it.",
        person: "true: leave it to the person instead of answering.",
        clientKey: "Your own key for this answer: a repeat with it is the same answer.",
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
        `Give one of this Thread's ${FIN_WORD}s a message: the person's (forward: true passes on the one this turn answers, word for word, so don't retype it) or your own.`,
        `An idle or finished ${FIN_WORD} takes it as its next task in its own Thread. A working one takes it as deliver says: queue (the default) after its turn, for more to do; steer, into the turn it's running, when the message changes what it's doing now; interrupt, stopping that turn first, when what it's running is wrong.`,
        `One running in an agent CLI your shell started is stopped and its session resumed here with the message, its last step maybe cut short.`,
        `It returns at once, saying when that ${FIN_WORD}'s harness lets it hear the message; what the ${FIN_WORD} does reports back as its work does.`,
        `Another ${APEX_WORD} (apex:<title>) hears it after its turn (steer only when its current work is wrong); its reply wakes you once; at most 3 an hour to one.`,
      ].join(" "),
      fields: {
        to: `The ${FIN_WORD}'s name (fin:<name> as your note lists it) or Thread ID; another ${APEX_WORD}: apex:<title or Thread ID>.`,
        forward: "true: pass on the person's message this turn answers, as their words.",
        text: "Your own words: beneath the person's with forward, else the whole message.",
        deliver: `For a working ${FIN_WORD}: queue (default), steer or interrupt.`,
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
      description: `Stop one of this Thread's ${FIN_WORD}s (its running turn, or its process and everything it started), or all of them. A stop pauses it: agents_send resumes it later in the same session, told what changed meanwhile. To stop its turn and redirect it now, agents_send with deliver: interrupt.`,
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
      description: `Wait up to ${WAIT_WORDS} for a ${FIN_WORD}'s next report. Reports wake you without it: end your turn instead. When your next step needs one ${FIN_WORD}'s result, start it with mode wait rather than calling this.`,
      fields: { children: `Names or Thread IDs; all your ${FIN_WORD}s when absent.`, timeoutMs: `At most ${WAIT_LIMIT_MS}.`, after: "The cursor an earlier wait returned." },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
  },
]

