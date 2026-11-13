import { ReportActionTargetSchema } from "./report-actions.js"
import { z } from "zod"
import { NativeAgentOriginSchema } from "@mako/sessions/native-agent-origin"
import { ACCESS_TIER_NAMES, accessModeId, type AccessTier } from "./access.js"
import { ASK_OPTIONS, AskOptionSchema, CHILDREN_BINDING, WAITING_ON_LIMIT, WaitingOnSchema, type ChildStateReading, type FinAnswered, type FinAsk, type FinDecision, type NativeAgent, type WaitingOn } from "./native-agents.js"
import type { LiveSessionMode, PromptAttachment } from "./providers-acp.js"
import { ActorSchema, SessionIdSchema, ThreadIdSchema, type SessionId, type ThreadId } from "./thread-identity.js"
import { FinTuningSourceSchema, type FinTuningWords } from "./fin-tuning.js"
import type { FallbackStep } from "./fin-fallback.js"

export { CHILDREN_BINDING, WAITING_ON_LIMIT, WaitingOnSchema, type WaitingOn }

/**
 * What every person-facing string and every agent's instructions call a
 * Thread that others work for, and a Thread that works for another: an Apex
 * and its Fins. The two together have no word of their own. Identifiers say
 * `apex`; the edge's data keeps the `lead` every build reads (`ChildRole`, a
 * question's `on`), and the tree's records keep `parent` and `child`.
 */
export const APEX_WORD = "Apex"
export const FIN_WORD = "Fin"

/** "1 Fin", "3 Fins". */
export function finsWord(count: number): string {
  return `${count} ${FIN_WORD}${count === 1 ? "" : "s"}`
}

/** How the transcripts of builds before the names called an Apex (`from your lead`): they still read as its words. */
export const LEGACY_APEX_WORD = "lead"

/**
 * How a child came to be one: `started` through a door (`agents_start`),
 * `discovered` as a harness CLI run from a Mako Session's shell (found by
 * `MAKO_SESSION_ID`), `linked` named afterwards (`agents_link`), or
 * `attached` by the person.
 */
export const ChildOriginSchema = z.enum(["started", "discovered", "linked", "attached"])
export type ChildOrigin = z.infer<typeof ChildOriginSchema>

/** What a Fin is to its Apex; `lead` makes it an Apex of its own, which digests its own Fins. */
export const ChildRoleSchema = z.enum(["worker", "reviewer", "verifier", "researcher", "lead"])
export type ChildRole = z.infer<typeof ChildRoleSchema>
/** The role of a Fin that is an Apex of its own, as stored edges, rosters and the tools' `role` keep the word. */
export const APEX_ROLE = "lead" satisfies ChildRole

/**
 * Where a child runs: this Mac (`here`), another of the person's devices by
 * its name (`device:<name>`), or a cloud machine. Absent: where its parent runs.
 */
export const PlaceSchema = z.union([z.literal("here"), z.literal("cloud"), z.templateLiteral(["device:", z.string().min(1).max(120)])])
export type Place = z.infer<typeof PlaceSchema>
const PLACE_TEXT = /^(here|cloud|device:.{1,120})$/s

/** The device a `device:<name>` place names; undefined for any other place. */
export function placeDevice(place: string | undefined): string | undefined {
  return place?.startsWith("device:") ? place.slice("device:".length) : undefined
}

/**
 * The version of placement a host speaks (`AgentsCapabilities`): Fins started from another device, their notices
 * back, and their Apex's operations on them. A host without it is never a place.
 */
export const ORCHESTRATION_VERSION = 1

/**
 * A Fin's Apex on another device, on the Fin's own edge: the device whose runtime its notices go to, the Apex's
 * conversation there, and the Apex's access as it started the Fin, which bounds what it answers for it.
 */
export const RemoteParentSchema = z.object({
  device: z.string().uuid(),
  conversation: z.string().min(1).max(512).optional(),
  access: z.enum(ACCESS_TIER_NAMES),
  /** The newest of its Apex's messages that reached it, by the count its Apex's device keeps of them (`Placed.epoch`). */
  heard: z.number().int().positive().optional(),
})
export type RemoteParent = z.infer<typeof RemoteParentSchema>

/** Where a placed Fin runs, as a call is addressed to it: a device's runtime, or a cloud Thread's machine. */
export const PlaceTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("device"), device: z.string().uuid(), name: z.string().min(1).max(200) }),
  z.object({ kind: z.literal("cloud"), thread: z.string().min(1).max(160) }),
])
export type PlaceTarget = z.infer<typeof PlaceTargetSchema>

/**
 * A Fin placed elsewhere, on its Apex's device: the Apex's own record of where it put it. The Fin's edge is its
 * owner's, there; this one only routes the Apex's operations and takes the Fin's notices.
 */
export const PlacedSchema = z.object({
  target: PlaceTargetSchema,
  /** Its Session and conversation where it runs, as its start answered them. */
  session: z.string().min(1).max(160).optional(),
  conversation: z.string().min(1).max(512).optional(),
  /**
   * Whether it's at work: set when this device sets it to work, and by its own device's word after. Kept on the edge,
   * so a host that restarts still counts it against its tree's budget.
   */
  working: z.boolean().optional(),
  /**
   * How many times this device set it to work: its start, then each message and answer that reached it. Its device
   * says the newest it heard with every notice (`RemoteParent.heard`), so a report made before a message reached it
   * can't end the turn that message started.
   */
  epoch: z.number().int().positive().optional(),
  /** Its Apex stopped it while its device couldn't be reached: kept until that device says it stopped, or its Apex sends it on. */
  stop: z.object({ at: z.number(), why: z.string().max(2_000) }).optional(),
  /**
   * The newest word of its device on how it stands that this device took (`AgentsNoticeInput.standing`, a list's
   * strips): the host that said it, by its generation, and that host's count of sayings. Kept with `working`, written
   * together, so an older word, a notice replayed or one that was on its way, changes nothing, after a restart too.
   */
  said: z.object({ owner: z.number(), seq: z.number() }).optional(),
})
export type Placed = z.infer<typeof PlacedSchema>

/** What a child is asked to do, readable two levels down: the parent's intent, and how it knows it's done. */
export const BriefSchema = z.object({
  objective: z.string().min(1).max(200_000),
  doneWhen: z.array(z.string().min(1).max(2_000)).max(32).optional(),
  boundaries: z.array(z.string().min(1).max(2_000)).max(32).optional(),
  /** What its report must carry. */
  output: z.string().max(2_000).optional(),
})
export type Brief = z.infer<typeof BriefSchema>

/** How a spawn's caller hears back: at once and woken by reports (`background`), or holding for its result (`wait`). */
export const StartModeSchema = z.enum(["background", "wait"])
export type StartMode = z.infer<typeof StartModeSchema>

/** Which reports wake the parent (`reportRoute`). */
export const WakeOnSchema = z.enum(["decisions", "finish", "never"])
export type WakeOn = z.infer<typeof WakeOnSchema>

/**
 * What a spawn asked for, kept as asked. What the child runs as now (its
 * harness, model, access, folder and branch) is its Thread's and Session's,
 * read there: a child continued on another harness is that Thread's fact.
 */
export const ChildSpecSchema = z.object({
  brief: BriefSchema,
  harness: z.string().min(1).max(64).optional(),
  model: z.string().min(1).max(256).optional(),
  reasoning: z.string().min(1).max(64).optional(),
  fast: z.boolean().optional(),
  rule: z.number().int().positive().optional(),
  /** At most the parent's tier (`childAccess`); absent means the parent's. */
  access: z.enum(ACCESS_TIER_NAMES).optional(),
  /** A `Place`, kept as the text it was asked as: a start's options carry it through the host call's generated schema. */
  place: z.string().regex(PLACE_TEXT).optional(),
  workspace: z.object({ branch: z.string().min(1).max(256).optional(), base: z.string().min(1).max(256).optional() }).optional(),
  /** Absent: `background`. */
  mode: StartModeSchema.optional(),
  /** Absent: `decisions`. */
  wake: WakeOnSchema.optional(),
})
export type ChildSpec = z.infer<typeof ChildSpecSchema>

/**
 * Where a Fin's report goes (6.6): a notice that wakes its Apex (`apex`), a
 * question the person answers in the Fin's Thread (`person`), or nowhere but
 * the Fin's strip and `agents_read` (`none`). Progress never wakes, but for a
 * handoff to another Fin (`Report.handoff`), which reaches the Apex as a result
 * does. A `wait` spawn's result always reaches its Apex, settled-only: as the
 * Apex's next turn, never steered into the turn that's running.
 */
export function reportRoute(asked: Pick<ChildSpec, "mode" | "wake">, status: ReportStatus, handoff = false): "apex" | "person" | "none" {
  if (status === "progress" && !handoff) return "none"
  const wake = asked.wake ?? "decisions"
  if (status === "blocked" || status === "needs-input") return wake === "decisions" ? "apex" : "person"
  return wake !== "never" || asked.mode === "wait" ? "apex" : "none"
}

/**
 * Who decides what a done report asks, its result going where `reportRoute`
 * sends it: the person when the Fin said so (`decides`), when its Apex left it
 * to them (`for`), or when its spawn hears only its result or nothing, as
 * questions go there; else its Apex.
 */
export function decisionOn(asked: Pick<ChildSpec, "mode" | "wake">, report: Pick<Report, "decides" | "for">): "lead" | "person" {
  if (report.for === "person" || report.decides === "person") return "person"
  return reportRoute(asked, "needs-input") === "apex" ? "lead" : "person"
}

/**
 * A done Fin's open decision in one line, as its Apex's wake, its front-door
 * note and another Apex's digest all say it: "done; decide: Merge #371?
 * (Merge · Leave open, recommends Merge)", or "the person decides" for theirs.
 */
export function decisionWords(decision: Pick<FinDecision, "question" | "on" | "ask">): string {
  const options = decision.ask?.options ?? []
  const recommended = decision.ask?.recommended === undefined ? undefined : options[decision.ask.recommended]?.label
  const offered = options.length ? ` (${options.map((option) => option.label).join(" · ")}${recommended ? `, recommends ${recommended}` : ""})` : ""
  return `done; ${decision.on === "lead" ? "decide" : "the person decides"}: ${decision.question}${offered}`
}

/**
 * A pull request as a report or GitHub names it: its repository (`owner/name`) and number from its URL, which is kept,
 * or from `owner/name#12`; `#12` alone names no repository. Undefined for words that name no pull request.
 */
export interface PullRef {
  repository?: string
  number: number
  url?: string
}

export function pullRef(text: string): PullRef | undefined {
  const trimmed = text.trim()
  const url = /^https?:\/\/[^/\s]+\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)(?:[/?#]\S*)?$/.exec(trimmed)
  const named = /^([\w.-]+\/[\w.-]+)#(\d+)$/.exec(trimmed)
  const bare = /^#?(\d+)$/.exec(trimmed)
  const [repository, digits] = url ? [`${url[1]}/${url[2]}`, url[3]] : named ? [named[1], named[2]] : [undefined, bare?.[1]]
  const number = Number(digits)
  if (!Number.isSafeInteger(number) || number <= 0) return undefined
  return { ...(repository && { repository: repository.toLowerCase() }), number, ...(url && { url: trimmed }) }
}

/** The key two names of a pull request share only when they're the same one: its repository and number, or the number alone for a bare `#12`. */
export function pullKey(ref: Pick<PullRef, "repository" | "number">): string {
  return `${ref.repository ?? ""}#${ref.number}`
}

/**
 * What a Fin waits on outside its tree, in a line: "waiting on #412 checks, the person to merge". A pull request is
 * its number alone, and `owner/name#412` only where the line names pull requests of more than one repository.
 */
export function waitingWords(items: readonly WaitingOn[] | undefined): string | undefined {
  if (!items?.length) return undefined
  const repositories = new Set(items.flatMap((item) => {
    const repository = item.kind === "pull-request" ? item.repository ?? pullRef(item.ref)?.repository : undefined
    return repository ? [repository] : []
  }))
  const words = items.map((item) => {
    if (item.kind === "other") return `${item.text.trim()} (no automatic wake)`
    if (item.kind === "person") return `the person to ${item.what.trim()}`
    const pull = pullRef(item.ref)
    const repository = item.repository ?? pull?.repository
    const number = item.number ?? pull?.number
    const ref = number === undefined ? item.ref.trim() : repositories.size > 1 && repository ? `${repository}#${number}` : `#${number}`
    return item.until ? `${ref} ${item.until}` : ref
  })
  return `waiting on ${words.join(", ")}`
}

/**
 * A waiting Fin's state words, where its row and strip say how it stands: "Waiting on acme/app#371 checks · 12m". A
 * pull request is named by its repository whenever its report gave one, since the row stands apart from its siblings.
 */
export function waitingStateWords(items: readonly WaitingOn[], since: number | undefined, now: number | undefined): string {
  const words = items.map((item) => {
    if (item.kind === "other") return `${item.text.trim()} (no automatic wake)`
    if (item.kind === "person") return `the person to ${item.what.trim()}`
    const pull = pullRef(item.ref)
    const repository = item.repository ?? pull?.repository
    const number = item.number ?? pull?.number
    const ref = number === undefined ? item.ref.trim() : `${repository ?? ""}#${number}`
    return item.until ? `${ref} ${item.until}` : ref
  })
  const line = `Waiting on ${words.join(", ")}`
  return since !== undefined && now !== undefined ? `${line} · ${waitedWords(now - since)}` : line
}

/** How long a Fin has waited, as its row says it: "<1m", "12m", "2h 5m", "3d". */
function waitedWords(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000)
  if (minutes < 1) return "<1m"
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`
  return `${Math.floor(hours / 24)}d`
}

/**
 * One of a Fin's open pull requests, from what its host already holds: its branch's, as the worktree summaries last
 * read them from GitHub (`open` or `draft`), and any its reports name (`reported`, read nowhere else). Nothing polls.
 * `repository` is `owner/name`, absent only for a bare `#12` a report named in a Thread of no one known repository.
 */
export interface FinPullRequest {
  repository?: string
  number: number
  url?: string
  state: "open" | "draft" | "reported"
}

/**
 * A Fin's open pull requests (`FinPullRequest`): its branches' that GitHub last said are open or drafts, then those its
 * reports' artifacts name that those don't, newest report first, each pull request once by repository and number
 * (`pullKey`). A bare `#12` is its one repository's when its branches' pull requests name exactly one, and otherwise
 * stays unqualified: it never stands for, or hides, a pull request of a repository it doesn't name.
 */
export function finPullRequests(held: readonly { number: number; url: string; state: "open" | "draft" | "merged" | "closed" }[], reports: readonly Pick<Report, "artifacts">[]): FinPullRequest[] {
  const heldRefs = held.map((pull) => ({ pull, ref: pullRef(pull.url) }))
  const repositories = new Set(heldRefs.flatMap(({ ref }) => (ref?.repository ? [ref.repository] : [])))
  const only = repositories.size === 1 ? [...repositories][0] : undefined
  const known = new Set(heldRefs.map(({ pull, ref }) => pullKey({ number: pull.number, ...(ref?.repository && { repository: ref.repository }) })))
  const open: FinPullRequest[] = heldRefs.flatMap(({ pull, ref }) => (pull.state === "open" || pull.state === "draft" ? [{ ...(ref?.repository && { repository: ref.repository }), number: pull.number, url: pull.url, state: pull.state }] : []))
  for (const report of [...reports].reverse())
    for (const artifact of report.artifacts ?? []) {
      if (artifact.kind !== "pull-request") continue
      const ref = pullRef(artifact.ref)
      if (!ref) continue
      const repository = ref.repository ?? only
      const key = pullKey({ number: ref.number, ...(repository && { repository }) })
      if (known.has(key)) continue
      known.add(key)
      open.push({ ...(repository && { repository }), number: ref.number, ...(ref.url && { url: ref.url }), state: "reported" })
    }
  return open
}

/** Whole seconds since a Fin's last activity at `at`, while it isn't at work or waiting its turn to start; undefined while it is. */
export function idleFor(state: ChildState, at: number, now: number): number | undefined {
  if (state.kind === "working" || state.kind === "starting" || state.kind === "queued") return undefined
  return Math.max(0, Math.floor((now - at) / 1000))
}

/**
 * A run Mako didn't start (`discovered`, `linked`): its harness's own process,
 * followed through its Session and its pid. A pid alone is reused, so its
 * start time says it's the same process. `runDir` names where a run #286's
 * builds started keeps its exit status. Its end is written once and never
 * reopened.
 */
export const FollowedRunSchema = z.object({
  harness: z.string().min(1).max(64),
  /** Native origin retained on historical discoveries, even once they leave the managed Fin lifecycle. */
  nativeAgent: NativeAgentOriginSchema.optional(),
  /** Its harness's ID for its Session, once known. */
  nativeId: z.string().min(1).max(512).optional(),
  /** The device it runs on: only that device's hosts can see its process. */
  device: z.string().uuid(),
  process: z.object({ pid: z.number().int().positive(), startedAt: z.number().optional() }).optional(),
  runDir: z.string().max(4096).optional(),
  startedAt: z.number(),
  ended: z.object({
    at: z.number(),
    kind: z.enum(["done", "failed", "stopped", "unknown"]),
    detail: z.string().max(2000).optional(),
    toolUses: z.number().int().nonnegative().optional(),
  }).optional(),
  /**
   * Mako stopped it at `at` and its process hasn't been seen to exit: it holds its place until it has, on this host or
   * the next (`AgentRuns.untilGone`). `stuck` once it outlived its kill: the person is told Mako couldn't stop it.
   */
  stopping: z.object({ at: z.number(), stuck: z.literal(true).optional(), unconfirmed: z.literal(true).optional() }).optional(),
})
export type FollowedRun = z.infer<typeof FollowedRunSchema>

const HarnessName = z.string().min(1).max(64)
/** A step of a Fin's fallback order it took (`fallbackOrder`): another account of its harness, a connection's model on it, or the next harness. */
export const FinStepSchema = z.discriminatedUnion("why", [
  z.object({ why: z.literal("account"), harness: HarnessName, account: z.string().min(1).max(320), label: z.string().max(320) }),
  z.object({ why: z.literal("connection"), harness: HarnessName, connection: z.string().min(1).max(64), connectionName: z.string().max(120), model: z.string().min(1).max(300) }),
  z.object({ why: z.literal("harness"), harness: HarnessName }),
]) satisfies z.ZodType<FallbackStep>

/**
 * It was meant for a harness whose account was at its limit, and started or went on elsewhere: the harness it left
 * (`from`), until when, another account the person could switch to (`instead`), and from this build the account at
 * its limit, the step it took (`to`), when it moved mid-run (`at`, absent at its start) and its row's words (`line`).
 */
export const FinReroutedSchema = z.object({
  from: HarnessName,
  until: z.number().optional(),
  instead: z.string().max(320).optional(),
  account: z.string().max(320).optional(),
  to: FinStepSchema.optional(),
  at: z.number().optional(),
  line: z.string().max(512).optional(),
})
export type FinRerouted = z.infer<typeof FinReroutedSchema>

/**
 * A Fin's logical turn as its fallback reads it (`fin_moves`, beside its edge), so it never loops across a restart:
 * the places it ran on (`placeKey`), the waits for a limit it already moved for, and the host generation taking a
 * move now and for which wait. It's cleared once a turn of the Fin ends without a limit.
 */
export const FinTurnSchema = z.object({
  visited: z.array(z.string().min(1).max(400)).max(64),
  handled: z.array(z.string().min(1).max(600)).max(64),
  moving: z.object({ owner: z.number(), wait: z.string().min(1).max(600), at: z.number() }).optional(),
})
export type FinTurn = z.infer<typeof FinTurnSchema>

/** A limit's one notice for a tree (`limit_notices`, by its root Thread): said once, kept until seen or its reset passes. */
export const LimitNoticeSchema = z.object({
  id: z.string().min(1).max(600),
  fin: z.string().min(1).max(200),
  /** The harness that ran out, which the Fin that carries it has left. */
  harness: z.string().min(1).max(100),
  line: z.string().max(512),
  at: z.number(),
  until: z.number().optional(),
  seen: z.literal(true).optional(),
  /** What the limit did to its tree so far, kept as it happens so a restart loses none of it: nobody reads it until it's said. */
  gathering: z.object({ account: z.string().optional(), apex: z.string().optional(), moved: z.array(z.string()), stopped: z.number() }).optional(),
})
export type LimitNotice = z.infer<typeof LimitNoticeSchema>

/**
 * The edge: one row of `thread_parents`, keyed by the child Thread, written
 * by the child's owner. It holds only what nothing else does; the child's
 * state is computed (`childState`), never stored beside it.
 */
export const ThreadParentSchema = z.object({
  /** The key: one parent per child. */
  child: ThreadIdSchema,
  parent: ThreadIdSchema,
  /** The Session notices go to; if it's gone, the parent's current Session. */
  parentSession: SessionIdSchema,
  /** Unique among the parent's children; addressable as `child:<name>`. */
  name: z.string().min(1).max(80),
  role: ChildRoleSchema,
  origin: ChildOriginSchema,
  /** What the spawn asked for, immutable. A discovered or linked child was asked nothing; its brief is what its Session first said. */
  asked: ChildSpecSchema,
  /** The spawn's operation (`start:{caller}:{clientKey}`); a repeated spawn answers this edge. */
  op: z.string().min(1).max(512),
  startedBy: ActorSchema,
  createdAt: z.number(),
  /** The delegation is stopped: paused until a message to the child resumes it (`resumed`). */
  closedAt: z.number().optional(),
  /** Why it was stopped, as whoever stopped it said: said once, with `closedAt`. */
  closedReason: z.string().max(2000).optional(),
  /** The last time a message resumed it after a stop: when, and the stop it ended. */
  resumed: z.object({ at: z.number(), closedAt: z.number(), reason: z.string().max(2000).optional() }).optional(),
  /** Present while a process Mako didn't start runs the child's turns (`FollowedRun`). */
  run: FollowedRunSchema.optional(),
  /** Where its model came from as it started (`resolveFinTuning`), and the choice passed over for one it no longer lists. */
  tuned: z
    .object({
      source: FinTuningSourceSchema,
      note: z.string().max(2_000).optional(),
      /** Its harness's account was at its limit, so it started or went on on the next step of its order (`FinRerouted`). */
      rerouted: FinReroutedSchema.optional(),
      /** The person's rule it was started by, as it read then (`n` absent: their choice for work no rule fits). */
      rule: z.object({ n: z.number().int().positive().optional(), when: z.string().max(400) }).optional(),
    })
    .optional(),
  /** Its Apex runs on another device (`RemoteParent`): `parent` and `parentSession` name a Thread and a Session there. */
  remote: RemoteParentSchema.optional(),
  /** It runs elsewhere (`Placed`): this row is its Apex's record of it, and `child` names a Thread there. */
  placed: PlacedSchema.optional(),
})
export type ThreadParent = z.infer<typeof ThreadParentSchema>

/** An old discovery of a provider's internal reviewer is history, never a managed delegation. */
export function internalDiscoveredRun(edge: ThreadParent): boolean {
  return edge.origin === "discovered" && edge.run?.nativeAgent?.kind === "internal-review"
}

/**
 * Whether a Fin is listed inside its Apex's Thread on this device. One whose Apex runs on another device
 * (`ThreadParent.remote`) has no such Thread here to be listed in, so on this device it's a Thread of its own, in the
 * rail and in the account's list, and this device is the one that writes its row there: what it's doing and what it
 * asks come from here, whether or not its Apex's device is up. Every other device shows that row under its Apex
 * (`listedApexOf`) and opens it from there, so the person reaches it, and answers what it asks, on the web or from
 * any device of theirs.
 */
export function listedUnderApex(edge: ThreadParent | undefined): edge is ThreadParent {
  return edge !== undefined && edge.remote === undefined
}

/**
 * What a start that makes a child says of its edge (`LiveStartOptions.parent`): all of it but the Thread the start makes.
 * It crosses the host call unbranded; the start parses it.
 */
export const ChildStartSchema = ThreadParentSchema.omit({ child: true, createdAt: true, closedAt: true, closedReason: true, resumed: true, run: true })
export type ChildStart = z.input<typeof ChildStartSchema>

/** A typed report from a child: explicit (`agents_report`), or implicit when its turn or run ended without one. */
export const ReportStatusSchema = z.enum(["progress", "done", "blocked", "needs-input", "failed"])
export type ReportStatus = z.infer<typeof ReportStatusSchema>
export const ArtifactSchema = z.object({
  kind: z.enum(["branch", "commit", "pull-request", "file", "screenshot", "test-run", "link"]),
  ref: z.string().min(1).max(4096),
  label: z.string().max(200).optional(),
})
export type Artifact = z.infer<typeof ArtifactSchema>
export const ReportSchema = z.object({
  /** Explicit: `report:{child}:{clientKey}`. Implicit: `report:{child}:{turn}`, the request or run whose end it is. */
  id: z.string().min(1).max(600),
  child: ThreadIdSchema,
  status: ReportStatusSchema,
  /** Its first sentence is the digest's line. */
  summary: z.string().max(16_000),
  artifacts: z.array(ArtifactSchema).max(64).optional(),
  /** What it waits on, for `blocked` and `needs-input`; on `done`, the decision its finished work leaves. */
  question: z.string().max(4_000).optional(),
  /** New explicit report questions persist independently of later narration. Absent in legacy reports. Host-owned. */
  retainsQuestion: z.literal(true).optional(),
  /** This Fin explicitly withdraws/replaces these report questions; an unrelated report settles nothing. */
  supersedes: z.array(z.string().min(1).max(600)).max(8).optional(),
  /** Who decides a done report's question (`decisionOn`): its Apex when absent, or the person. */
  decides: z.enum(["apex", "person"]).optional(),
  /**
   * What it waits on outside its tree: "#412 checks", the person's merge. With a question, on the state that asks it;
   * on a progress report, its idle state's words. A pull request's outcome wakes it (`PullWatch`).
   */
  waitingOn: z.array(WaitingOnSchema).max(WAITING_ON_LIMIT).optional(),
  /** The answers its question offers, each a tap on the person's phone. */
  options: z.array(AskOptionSchema).max(ASK_OPTIONS).optional(),
  /** The option it recommends, by its place in `options`. */
  recommended: z.number().int().nonnegative().optional(),
  /** What whoever answers does, in one sentence: "Pick the branch the release goes from." */
  action: z.string().max(400).optional(),
  /** Explicit action-only follow-through. Questions retain their existing ask identity instead. */
  followUp: ReportActionTargetSchema.optional(),
  /** Its Apex left its question to the person (`agents_answer` with `person`), or it was the person's from the start. */
  for: z.literal("person").optional(),
  /** The person's ask its Apex is told of though it can't answer it: an approval under an Apex below full access. */
  told: z.literal(true).optional(),
  /** Recorded by the owner because the turn ended without one. */
  implicit: z.literal(true).optional(),
  /**
   * Work it hands to another Fin of its Apex: a progress report that names one ("hand the slot to fin:x"), or its
   * message to a sibling, which it can't send itself (`text`, relayed). It wakes the Apex, who passes it on. Host-owned.
   */
  handoff: z.object({ to: z.string().max(200), child: ThreadIdSchema.optional(), text: z.string().max(16_000).optional() }).optional(),
  /** The child owner's generation when it was written: a report from a stale owner is refused. */
  ownerGeneration: z.number().int().positive(),
  at: z.number(),
})
export type Report = z.infer<typeof ReportSchema>

/** `notice:{child}:{reportId}`: a report its Apex's owner hears, under an ID a resend repeats; a digest in the Apex's queue carries its notices (`LiveRequest.digest`). */
export const NoticeSchema = z.object({
  id: z.string(),
  report: ReportSchema,
  /** The Fin as the digest names it: `"name" (Harness)`. */
  label: z.string(),
  /** Who wrote it as the person's card of it names them (`FinReportCard`): its name and its harness's ID, when known. */
  fin: z.object({ name: z.string(), harness: z.string().optional() }),
  /** The Fin's own Session, which the wake's request names as its actor: an agent's words, never the person's. */
  from: z.string(),
  /** The request already named to carry it, by a host that stopped before it was sent (`ThreadStore.assignWake`). */
  wake: z.string().optional(),
  /** The result of a `wait` start whose window ended first: it starts the Apex's next turn, in full, and is never steered into a running one. */
  settledOnly: z.literal(true).optional(),
  /** Another of the person's Apexes' reply to this one's message, in full: the turn the message started, as it ended. */
  reply: z.literal(true).optional(),
  /** A done report's question: who decides it (`decisionOn`). */
  decision: z.enum(["lead", "person"]).optional(),
})
export type Notice = z.infer<typeof NoticeSchema>

/** Whether a digest of these notices asks its Apex something: it goes as soon as it can, whatever the minute's budget. */
export function digestAsks(notices: readonly Notice[]): boolean {
  return notices.some(({ report, decision }) => report.status === "blocked" || report.status === "needs-input" || decision !== undefined)
}

/** Why a spawn waits: the tree's running budget, the person's limit of Fins at once (`place-full`), or (from 8.4) another place. */
export type QueueReason = "tree-running" | "place-full" | "device-offline"

/**
 * A child's state, computed by `childState` and never stored. `agents_list`,
 * the roster entry (`NativeAgent.child.state`) and the window's `rollup` all
 * read it.
 */
export type ChildState = ChildStateReading

/**
 * What the child's Thread shows now, from whatever runs its current turn: the
 * live snapshot for a turn Mako drives, or the follower for a run Mako didn't
 * start (`childReading` in the engine). One source at a time.
 */
export interface ChildThread {
  /** `placed`: it runs elsewhere, and this is read from the notices its device sent (`ThreadParent.placed`). */
  source: "live" | "followed" | "placed"
  /** Its Session, its harness's ID for it, and where this device's catalog reads its transcript. */
  session?: SessionId
  nativeId?: string
  path?: string
  /** Its live conversation on this device, while it has one. */
  conversation?: string
  title?: string
  harness?: string
  model?: string
  /** Its model, reasoning and fast lane in words, from its harness's catalog. */
  runsOn?: FinTuningWords
  /** The admission queue holds it: for a place, and for the Fins it starts after (`after`, `held`). */
  queued?: { reason: QueueReason; ahead: number; after?: string[]; held?: string; refused?: string; apexStopped?: true }
  starting?: "placing" | "preparing" | "booting" | "launching"
  /** A turn or its process is at work. */
  working?: boolean
  /** The last thing its transcript shows it doing (`lastStep`). */
  step?: string
  /** Its turn ended on work of its own Fins or its move, which it waits for: at work, but holding no room its Fins need. */
  awaiting?: string
  /** When its work now began: its turn's start, or with `awaiting`, when that turn ended. Absent when nothing says. */
  workSince?: number
  /** The requests its turn took: the one that began it and any steered into it. A process Mako follows has none. */
  workInputs?: readonly string[]
  /** An approval or question in it waits, on whom, and what answers it. */
  waiting?: { question: string; on: "lead" | "person" | "approval"; ask?: FinAsk }
  /** How its last turn or run ended; absent while one runs or before any ended. */
  ended?: { outcome: "done" | "failed" | "stopped" | "unknown"; reason?: string; at: number }
  toolUses?: number
  startedAt?: number
  updatedAt?: number
}

/** The child's reports, as its owner keeps them: the newest decides what its parent last heard. */
export interface ChildJournal {
  latest?: Report
  /** The last answer to a question in its report: who gave it, when, and the ask it answers, which it settles alone. */
  answered?: FinAnswered & {
    ask: string
    /** The request that carried it to the Fin. */
    request?: string
    at: number
    /** It reached the Fin, so the question no longer holds it. */
    delivered?: true
    /** It came as a message, not through a door that answers: from an Apex, that's its next job more than an answer. */
    routine?: true
  }
}

/**
 * Whether a row says who answered: an answer to this turn, by the request that carried it, however long that waited
 * and however soon the next turn began. A process has no requests to tell by, so only an answer since its turn began
 * counts. A plain message from its Apex may close a question (`inputDelivered`), and it's still the next job and not an answer.
 */
function answerShown(journal: ChildJournal, thread: ChildThread): boolean {
  const answer = journal.answered
  if (!answer || (answer.routine && answer.by !== "person")) return false
  if (thread.workInputs) return answer.request !== undefined && thread.workInputs.includes(answer.request)
  return thread.workSince === undefined || answer.at >= thread.workSince
}

/**
 * When a turn failed: the last anything was heard of it, its provider's activity or else its sending. A request keeps
 * no time of its own for this, and its admission is only when it was asked for, an hour ago for a Fin's long turn.
 */
export function turnFailedAt(request: { createdAt?: number; dispatchedAt?: number }, activityAt: number | undefined, start: number): number {
  return Math.max(request.dispatchedAt ?? request.createdAt ?? start, activityAt ?? 0)
}

/** Its last report's first sentence: what a strip and the digest show it at. */
export function reportPhase(report: Report | undefined): string | undefined {
  const text = report?.summary.trim()
  if (!text) return undefined
  const sentence = /^.*?[.!?](?=\s|$)/s.exec(text)?.[0] ?? text.split("\n", 1)[0]!
  return sentence.length > 160 ? `${sentence.slice(0, 159)}…` : sentence
}

/**
 * The one way anything learns a child's state. A closed delegation, or a turn
 * that ended with nothing after it, reads as ended with how it went; a child
 * whose last word is a question reads as blocked on it, and one that finished
 * asking one as done with that decision open until it's answered.
 */
export function childState(edge: ThreadParent, thread: ChildThread, journal: ChildJournal): ChildState {
  if (thread.queued) {
    const { reason, ahead, after, held, refused, apexStopped } = thread.queued
    return { kind: "queued", reason, ahead, ...(after?.length && { after }), ...(held && { held }), ...(refused && { refused }), ...(apexStopped && { apexStopped }) }
  }
  const latest = journal.latest
  // A stop after its last report is how it ended, in the words of whoever stopped it, whatever its harness still winds down.
  if (edge.closedAt !== undefined && (!latest || latest.at <= edge.closedAt)) {
    const reason = stuckWords(edge.run, edge.name) ?? edge.closedReason ?? (thread.ended?.outcome === "stopped" ? thread.ended.reason : undefined)
    // Stopped for want of an account, not by anyone's choice: its work isn't finished, and it never reads as done.
    const unfinished = reason !== undefined && reason === edge.tuned?.rerouted?.line
    return { kind: "ended", outcome: "stopped", ...(reason && { reason }), ...(unfinished && { unfinished: true as const }) }
  }
  if (thread.starting) return { kind: "starting", step: thread.starting }
  if (thread.waiting) return { kind: "blocked", question: thread.waiting.question, on: thread.waiting.on, ...(thread.waiting.ask && { ask: thread.waiting.ask }) }
  const phase = latest?.status === "progress" ? reportPhase(latest) : undefined
  // By identity, never by time: an answer settles the ask it names, and a newer ask is open whatever the clocks say.
  const answered = journal.answered && latest && journal.answered.ask === reportAsk(latest).id ? { by: journal.answered.by, answer: journal.answered.answer } : undefined
  if (thread.working && edge.closedAt === undefined) return { kind: "working", ...(thread.step && { step: thread.step }), ...(phase && { phase }), ...(answered && answerShown(journal, thread) && { answered }) }
  // A question it waits on blocks it until the answer has reached it: that answer is what it goes on with.
  if (latest && (latest.status === "blocked" || latest.status === "needs-input") && !(answered && journal.answered?.delivered) && !edge.closedAt)
    return {
      kind: "blocked",
      question: latest.question ?? reportPhase(latest) ?? "It asks for a decision.",
      on: latest.for !== "person" && reportRoute(edge.asked, latest.status) === "apex" ? "lead" : "person",
      ask: reportAsk(latest),
      ...(latest.waitingOn?.length && { waitingOn: latest.waitingOn }),
    }
  const ended = thread.ended
  if (ended?.outcome === "stopped") return { kind: "ended", outcome: "stopped", ...(ended.reason && { reason: ended.reason }) }
  if (latest?.status === "done") {
    const open = latest.question !== undefined && latest.question.trim() !== "" && !answered && !edge.closedAt
    return {
      kind: "ended",
      outcome: "done",
      ...(open && { decision: { question: latest.question!, on: decisionOn(edge.asked, latest), ask: reportAsk(latest) } }),
      ...(open && latest.waitingOn?.length && { waitingOn: latest.waitingOn }),
    }
  }
  if (latest?.status === "failed") return { kind: "ended", outcome: "failed", reason: reportPhase(latest) ?? "It failed." }
  if (ended) return ended.outcome === "done"
    ? { kind: "ended", outcome: "done" }
    : { kind: "ended", outcome: ended.outcome === "unknown" ? "failed" : ended.outcome, ...(ended.reason && { reason: ended.reason }) }
  if (edge.closedAt) return { kind: "ended", outcome: "stopped" }
  if (latest?.status === "progress" && latest.waitingOn?.length) return { kind: "idle", waitingOn: latest.waitingOn, since: latest.at }
  return { kind: "idle" }
}

/**
 * When a Fin came to stand as it does, the one rule every row's time reads. A working Fin's is its turn, however long
 * ago it was spawned, and one waiting on its own Fins counts from when that turn ended; each other state, from when it
 * got there. A working Fin with no known turn says none, since its age would read as a turn it isn't on.
 */
export function childSince(edge: ThreadParent, thread: ChildThread, journal: ChildJournal, state: ChildState): number | undefined {
  const latest = journal.latest?.at
  switch (state.kind) {
    case "queued":
    case "starting":
      // A Fin held or starting again counts from what it last did, and only one that never has from when it was asked.
      return thread.updatedAt ?? thread.startedAt ?? edge.createdAt
    case "working":
      return thread.workSince ?? (thread.source === "followed" ? thread.startedAt : undefined)
    case "blocked":
      return (thread.waiting ? thread.updatedAt : latest) ?? latest ?? thread.updatedAt
    case "idle":
      return state.since ?? thread.updatedAt ?? latest ?? thread.ended?.at ?? edge.closedAt ?? edge.createdAt
    case "ended":
      return thread.ended?.at ?? latest ?? edge.closedAt ?? edge.createdAt
  }
}

/** What a Fin whose stop outlived its kill says, in place of its stop's reason, while its process still runs (`FollowedRun.stopping`). */
export function stuckWords(run: FollowedRun | undefined, name: string): string | undefined {
  if (!run?.process) return undefined
  if (run.stopping?.unconfirmed) return `Mako couldn't confirm ${name} stopped; it may still be running (process ${run.process.pid}), so it keeps its place until Mako can tell.`
  return run.stopping?.stuck ? `Mako couldn't stop it: its process (${run.process.pid}) is still running, so it keeps its place until it exits.` : undefined
}

/** A report's question as an ask: what it offers, keyed by the report. */
export function reportAsk(report: Report): FinAsk {
  const recommended = report.recommended !== undefined && report.recommended < (report.options?.length ?? 0) ? report.recommended : undefined
  return {
    kind: "report",
    id: report.id,
    ...(report.options?.length && { options: report.options }),
    ...(recommended !== undefined && { recommended }),
    ...(report.action && { action: report.action }),
  }
}

/** A roster entry's id for a child: stable for its whole life, whatever runs its turns. */
export function childEntryId(child: ThreadId): string {
  return `mako-child:${child}`
}

/**
 * Whether a Fin's entry says what `before` says. Its time alone doesn't count: that's its conversation's last activity,
 * which moves with every token, and each move resends its Apex's whole roster to every conversation of the Thread. On
 * 2026-11-07 one Fin did that about twice a second to 14 of them, 2 to 10 MB/s to every window, past what a stream may
 * hold. What it reads moves the time along with it.
 */
export function sameChildEntry(before: NativeAgent, entry: NativeAgent): boolean {
  return JSON.stringify({ ...before, observedAt: 0 }) === JSON.stringify({ ...entry, observedAt: 0 })
}

/**
 * The roster entry a child is (`CHILDREN_BINDING`), from its edge and what its
 * Thread shows. Every surface draws this one entry (the Agents panel, the
 * transcript's line, the composer's toggle, the phone), and it's never saved in
 * the parent's journal.
 */
export function childEntry(edge: ThreadParent, thread: ChildThread, journal: ChildJournal): NativeAgent {
  const state = childState(edge, thread, journal)
  const entry: NativeAgent = {
    nativeId: childEntryId(edge.child),
    title: thread.title ?? edge.name,
    work: "agent",
    background: true,
    stoppable: state.kind === "working" || state.kind === "starting" || state.kind === "queued" || state.kind === "blocked",
    state: entryState(state),
    bindingId: CHILDREN_BINDING,
    provider: thread.harness ?? edge.asked.harness ?? edge.run?.harness ?? "unknown",
    observedAt: thread.updatedAt ?? edge.createdAt,
    startedAt: thread.startedAt ?? edge.createdAt,
    child: { thread: edge.child, name: edge.name, origin: edge.origin, ...(edge.placed && edge.asked.place && { place: edge.asked.place }), ...(thread.session && { session: thread.session }), ...(thread.nativeId && { nativeId: thread.nativeId }), ...(thread.path && { path: thread.path }), ...(thread.conversation && { conversation: thread.conversation }), state: carried(state), ...(edge.tuned?.rerouted?.line && { moved: edge.tuned.rerouted.line }) },
  }
  entry.detail = edge.asked.brief.objective.slice(0, 8192)
  const model = thread.model ?? edge.asked.model
  if (model) entry.model = model
  const rule = edge.tuned?.rule && ruleWords(edge.tuned.rule)
  if (thread.runsOn) entry.runsOn = { ...thread.runsOn, ...(edge.tuned?.note && { note: edge.tuned.note }), ...(rule && { rule }) }
  if (edge.role !== "worker") entry.role = edge.role
  if (thread.toolUses) entry.usage = { toolUses: thread.toolUses }
  if (state.kind === "ended") entry.settledAt = thread.ended?.at ?? journal.latest?.at ?? edge.closedAt ?? edge.createdAt
  const since = childSince(edge, thread, journal, state)
  if (since !== undefined) entry.since = since
  return entry
}

/** A Fin's rule as its row and strip say it: "Rule 2 · Anything that isn't frontend", or "No rule fit". */
export function ruleWords(rule: { n?: number; when: string }): string {
  return rule.n === undefined ? "No rule fit" : `Rule ${rule.n} · ${rule.when.replace(/\s+/g, " ").trim()}`
}

/** `state` within the entry's limits: its words are a roster note's at most. */
function carried(state: ChildState): ChildState {
  const cut = (text: string) => (text.length > NOTE_LIMIT ? `${text.slice(0, NOTE_LIMIT - 1)}…` : text)
  switch (state.kind) {
    case "working":
      return { kind: "working", ...(state.step && { step: cut(state.step) }), ...(state.phase && { phase: cut(state.phase) }), ...(state.answered && { answered: state.answered }) }
    case "blocked":
      return { ...state, question: cut(state.question) }
    case "ended":
      return { ...state, ...(state.reason && { reason: cut(state.reason) }), ...(state.decision && { decision: { ...state.decision, question: cut(state.decision.question) } }) }
    default:
      return state
  }
}
const NOTE_LIMIT = 8192

/** A queued Fin's row: what it starts after, else the place it waits for. */
export function queuedWords(state: Extract<ChildState, { kind: "queued" }>): string {
  if (state.refused) return `Not started: ${state.refused.replace(/^It didn't start: /, "")}`
  if (state.held) return `Not started: ${state.held} didn't finish, so its ${APEX_WORD} decides`
  if (state.apexStopped) return `Waiting: its ${APEX_WORD} was stopped`
  if (state.after?.length) return `Starts after ${state.after.join(", ")} ${state.after.length === 1 ? "finishes" : "finish"}`
  if (state.reason === "tree-running") return `Queued: ${state.ahead} ahead, the tree's running budget is in use`
  if (state.reason === "place-full") return `Queued: ${state.ahead} ahead, your limit of Fins at once is in use`
  if (state.reason === "device-offline") return "Waiting for its device to answer"
  return `Queued: ${state.ahead} ahead`
}

export function entryState(state: ChildState): NativeAgent["state"] {
  switch (state.kind) {
    case "queued":
      return { kind: "waiting", reason: queuedWords(state) }
    case "starting":
      return { kind: "working", activity: "Starting" }
    case "working":
      return { kind: "working", ...((state.phase ?? state.step) && { activity: state.phase ?? state.step }) }
    case "idle":
      return { kind: "waiting", reason: state.waitingOn?.length ? waitingStateWords(state.waitingOn, undefined, undefined) : "Idle: a message gives it its next turn" }
    case "blocked":
      return { kind: "waiting", reason: state.question }
    case "ended":
      if (state.outcome === "done") return { kind: "completed" }
      if (state.outcome === "stopped") return { kind: "canceled" }
      return { kind: "failed", error: state.reason ?? "It failed." }
  }
}

/** Mako's access ladder, least to most permissive; `deny` is beside it (`childAccess`). */
export const ACCESS_LADDER: readonly AccessTier[] = ["plan", "chat", "ask", "edits", "auto", "full"]

/**
 * The tier a child may run on under a parent on `parent`, given what it asked:
 * at most the parent's. A parent on `deny` starts children on `deny`, `plan`
 * or `chat`. Undefined: refused.
 */
export function childAccess(parent: AccessTier, asked: AccessTier | undefined): AccessTier | undefined {
  const wanted = asked ?? parent
  if (parent === "deny") return wanted === "deny" || wanted === "plan" || wanted === "chat" ? wanted : undefined
  if (wanted === "deny") return wanted
  return ACCESS_LADDER.indexOf(wanted) <= ACCESS_LADDER.indexOf(parent) ? wanted : undefined
}

/**
 * The mode a child starts in on a harness whose live driver declares `ladder`, for `tier`: the harness's own mode at
 * that tier (Claude's `bypassPermissions` for `full`, Cursor's `full-access`), else its most permissive one below
 * it, and `deny` only as `deny`. Undefined when every mode it offers is above `tier`, as Cursor's one mode is above
 * anything but `full`. A harness that declares no ladder takes Mako's own id for the tier.
 */
export function childMode(ladder: readonly LiveSessionMode[] | undefined, tier: AccessTier): { id: string; tier: AccessTier } | undefined {
  if (!ladder) return { id: accessModeId(tier), tier }
  const exact = ladder.find((mode) => mode.access === tier)
  if (exact) return { id: exact.id, tier }
  if (tier === "deny") return undefined
  let best: { id: string; tier: AccessTier } | undefined
  for (const mode of ladder) {
    const at = mode.access ? ACCESS_LADDER.indexOf(mode.access) : -1
    if (at >= 0 && at < ACCESS_LADDER.indexOf(tier) && (!best || at > ACCESS_LADDER.indexOf(best.tier))) best = { id: mode.id, tier: mode.access! }
  }
  return best
}

/**
 * For a harness with no mode at or below `tier` (`childMode` undefined): its least mode above `tier` that is still
 * within `ceiling`, its Apex's own access, as Cursor's one mode is for a Fin asked on edits under an Apex on full.
 * Undefined when none is, and always for `deny`, which only `deny` serves.
 */
export function modeWithin(ladder: readonly LiveSessionMode[] | undefined, tier: AccessTier, ceiling: AccessTier): { id: string; tier: AccessTier } | undefined {
  if (!ladder || tier === "deny" || ceiling === "deny") return undefined
  const from = ACCESS_LADDER.indexOf(tier)
  const to = ACCESS_LADDER.indexOf(ceiling)
  let best: { id: string; tier: AccessTier } | undefined
  for (const mode of ladder) {
    const at = mode.access ? ACCESS_LADDER.indexOf(mode.access) : -1
    if (at > from && at <= to && (!best || at < ACCESS_LADDER.indexOf(best.tier))) best = { id: mode.id, tier: mode.access! }
  }
  return best
}

/** The tree's budgets, held by its authority: the top Apex's host in 8.1. No depth: cycles are refused instead. */
export interface TreeBudget {
  /** Threads running at once across the tree. */
  running: number
  /** Threads started in total. */
  started: number
}
export const TREE_BUDGET: TreeBudget = { running: 32, started: 100 }

/** The host's Fins for Diagnostics: how many, how many run (and of those, how many a process Mako didn't start runs), and each tree against its budgets. */
export interface AgentsDiagnostics {
  fins: number
  running: number
  followed: number
  queued: number
  /** Reports an Apex hasn't been woken with yet. */
  notices: number
  budget: TreeBudget
  trees: { apex: string; running: number; started: number }[]
  /**
   * The person's messages and the Apexes' since this host started: the person's an Apex passed on, an Apex's own,
   * the person's moved to another Fin, and the person's sent straight to a Fin with no Apex turn.
   */
  routes: { forwarded: number; sent: number; redirected: number; direct: number }
  /**
   * Fins' asks answered since this host started: by their Apex, left by it to the person, refused to an Apex whose
   * access doesn't cover them, and answered by the person from the Apex's Thread on any device.
   */
  answers: { apex: number; passed: number; refused: number; person: number }
}

/** How a message reached a Fin: as its next turn, a step of its running one, queued behind it, or after Mako stopped that turn. */
export type FinDelivery = "turn" | "steer" | "queued" | "interrupt"

/**
 * How a message is to reach a working Fin: after its turn as its next message
 * (`queue`), into the turn it's running at its harness's next step (`steer`),
 * or by stopping that turn and starting the next with it (`interrupt`). An idle
 * Fin takes any as its next turn.
 */
export type FinDeliver = "queue" | "steer" | "interrupt"

/** The person moving a message their Apex passed on (`agents_send`) from the Fin it reached to the one it was for. */
export interface AgentsRedirectInput {
  /** The Fin it reached, by name or Thread. */
  from: string
  /** Its request in that Fin's conversation. */
  request: string
  /** The Fin it was for. */
  to: string
}

export interface AgentsRedirected {
  to: string
  /** Whether it left the first Fin before that Fin began on it. */
  withdrawn: boolean
  delivery: FinDelivery
}

/**
 * The person writing to one of an Apex's Fins from the Apex's own composer
 * (`@` a Fin, or Reply on a routing line): the message goes to the Fin as
 * the person's own, through the host, and the Apex takes no turn. It's
 * settled by `request`, the composer's id for the message: a repeat answers
 * the first delivery and sends nothing again.
 */
export interface AgentsDirectInput {
  /** The Fin, by name or Thread. */
  to: string
  request: string
  text: string
  attachments?: PromptAttachment[]
}

export interface AgentsDirected {
  /** The Fin's name and Thread. */
  to: string
  fin: string
  delivery: FinDelivery
}

/**
 * The person answering what one of an Apex's Fins asks them, from the Apex's
 * Thread on any device (`mako:agents-respond`): one of its options by its
 * place, or their own words, or for an approval, allow or refuse. It names the
 * ask it answers, so an answer given after the ask moved on answers nothing,
 * and it's settled by `request`: a repeat answers once.
 */
export interface AgentsRespondInput {
  /** The Fin, by Thread ID: one anywhere under the Apex. */
  fin: string
  /** The ask (`FinAsk.id`). */
  ask: string
  option?: number
  answer?: string
  allow?: boolean
  request: string
}

/** Who calls an orchestration operation: the door stamps it, and through the socket it's a label, not a grant. */
export type AgentCaller = { kind: "agent"; session: string } | { kind: "person" } | ApexCaller

/**
 * An Apex on another device calling for the Fins it placed here (`mako:agents-place`): its device, Thread, Session and
 * conversation there, and its access now. `forwards` is the person's message its turn answers, which a `forward` send
 * passes on; only its words cross.
 */
export interface ApexCaller {
  kind: "apex"
  device: string
  thread: string
  session: string
  conversation?: string
  access: AccessTier
  forwards?: string
  /** With a message or an answer for a Fin: the count its Apex's device will keep once it reaches it (`Placed.epoch`). */
  epoch?: number
}

/**
 * What a host says of itself as a place for Fins (`mako:agents-capabilities`), so a caller checks before it places one.
 * A stand-in: the same room goes out on the runtime link's `advertise` frame (`slots: { used, of }`, the shape here,
 * with no harnesses), which replaces this call once that lands. Then `harnesses` and the version join the probe, room
 * is read from one place, the version refusal stays, and this call goes.
 */
export interface AgentsCapabilities {
  orchestration: { version: number }
  /** How many Fins this device runs at once, and how many are at work or on their way now, as `advertise` says them. */
  slots: { used: number; of: number }
  /** The harnesses a Fin can run on here. */
  harnesses: string[]
}

/** The checkout a placed Fin works in: a Git remote this device has, or clones; `folder` instead when it's there already (a cloud Thread's clone). */
export interface PlaceWorkspace {
  remote?: string
  branch?: string
  base?: string
  folder?: string
}

/**
 * A Fin started here for an Apex on another device (`mako:agents-place`), settled by `op`
 * (`start:{apexSession}:{clientKey}`): a repeat answers the same Fin. `access` is at most the Apex's own; this device
 * caps it by its own ceiling too.
 */
export interface AgentsPlaceInput {
  version: number
  op: string
  clientKey: string
  parent: { device: string; thread: string; session: string; conversation?: string; access: AccessTier }
  brief: Brief
  name: string
  title?: string
  role?: ChildRole
  harness: string
  model?: string
  reasoning?: string
  fast?: boolean
  access: AccessTier
  workspace: PlaceWorkspace
  mode?: StartMode
  wake?: WakeOn
  queue?: boolean
}

export interface AgentsPlaced {
  child: string
  name: string
  session?: string
  conversation?: string
  harness: string
  access: AccessTier
  state: ChildState["kind"]
  runsOn?: string
  note?: string
  deduped?: true
}

/**
 * A placed Fin's report for its Apex's device (`mako:agents-notice`), under `notice:{child}:{reportId}`: a repeat is
 * the same notice, and one from an owner older than the newest heard is refused (`stale-owner`).
 */
export interface AgentsNoticeInput {
  id: string
  /** The Fin's start (`start:{apexSession}:{clientKey}`): a notice that outruns its start's answer waits for it. */
  op: string
  parent: { thread: string; session: string }
  child: string
  /** It crosses the host call unbranded; the Apex's device parses it. */
  report: z.input<typeof ReportSchema>
  /**
   * How the Fin stands as this is sent: whether it holds a place, and the newest of its Apex's messages it had heard
   * by then (`RemoteParent.heard`). Its Apex's device takes it only when that's no older than what it sent the Fin,
   * and only the newest said: `owner` is the host that says it (its generation) and `seq` its count of sayings. A
   * Fin whose standing changes with nothing new to report says its last report again, with how it stands now.
   */
  standing?: { heard: number; working: boolean; owner: number; seq: number }
}

/**
 * A placed start its Apex stopped before it knew how the start went (`mako:agents-cancel`), by the start's op. The
 * device ends the Fin if that start made one, and answers it; if it made none, it keeps the stop, so the start is
 * refused whenever it arrives. A repeat answers the same.
 */
export interface AgentsCancelInput {
  version: number
  op: string
  parent: { device: string; thread: string; session: string; conversation?: string; access: AccessTier }
  reason?: string
}

/** `fin`: the Fin that start had made here, now stopped. Absent: it made none, and never will. */
export type AgentsCancelled = { cancelled: true; fin?: AgentsPlaced } | AgentRefused

/** Heard, once: a refusal that isn't `stale-owner` leaves it in the Fin's device's outbox, to be sent again. */
export type AgentsNoticed = { heard: true; deduped?: true } | AgentRefused

/** A refusal is an answer, not an error, so every door says it the same way. */
export type AgentRefusalReason =
  | "place-unavailable"
  | "access"
  | "budget"
  | "cycle"
  | "unknown-child"
  | "relayed"
  | "unknown-apex"
  | "unknown-harness"
  | "unknown-thread"
  | "unknown-model"
  | "limited"
  | "unknown-rule"
  | "no-parent"
  | "conflict"
  | "stale-owner"
  | "rate-limited"
  | "unavailable"
  | "unsupported"
export interface AgentRefused {
  refused: AgentRefusalReason
  why: string
}
