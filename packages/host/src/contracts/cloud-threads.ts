import type { MoveLeft } from "@mako/protocol/moves"
import type { OutdatedRestore } from "./restore-plan.js"
import type { SessionSettings } from "@mako/sessions/settings"
import { z } from "zod"
import { MOVE_REASON_MAX } from "@mako/protocol/moves"
import { decodeRuntimeValue, type EncodedValue } from "./runtime-value.js"

/** A public GitHub repository a cloud Thread's machine clones and works in, as the cloud takes it. */
export const CloudRepositorySchema = z
  .object({
    url: z
      .string()
      .max(200)
      .regex(/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, "expected https://github.com/<owner>/<repository>"),
    branch: z
      .string()
      .max(200)
      .regex(/^(?![-/.])(?!.*\.\.)(?!.*\/\/)[A-Za-z0-9_./-]+(?<![./])$/, "expected a branch name")
      .optional(),
  })
  .strict()

export type CloudRepository = z.infer<typeof CloudRepositorySchema>

/** A new cloud conversation's start, as its window shows it: its machine coming up, then its harness. */
export type CloudStartStep = "preparing" | "starting"

/**
 * What a `mako:cloud-prepare` did while the person writes a new cloud conversation's first message: its Thread is
 * `ready`, or still `preparing`; `later` asks again after more writing (the last few made ahead went unused); `none`
 * when this Mac or folder can't start one in the cloud.
 */
export type CloudPrepareOutcome = "ready" | "preparing" | "later" | "none"

/** What onboarding's offer of this Mac's recent projects did: `asked` for their bases, `already` offered, or `none` to offer. */
export type CloudProjectsOffer = "asked" | "already" | "none"

/** The harness and settings the composer would start a new cloud conversation with, to start it ahead on its machine. */
export interface CloudPrepareLaunch {
  harness: string
  modeId?: string
  tuning?: SessionSettings
}

/**
 * Where a new conversation runs: on a cloud machine of the account's, in a clone of `repository`, or without one,
 * of the GitHub repository the folder's `origin` names, on its upstream branch when it has one there.
 */
export interface CloudPlacement {
  repository?: CloudRepository
}

const SSH_REMOTE = /^(?:ssh:\/\/)?git@github\.com[:/]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/
const HTTPS_REMOTE = /^https:\/\/(?:[^@/]+@)?github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/

/** The GitHub repository a Git remote's URL names, as the cloud takes it; undefined for any other host. */
export function githubRepositoryUrl(remote: string): string | undefined {
  const match = SSH_REMOTE.exec(remote.trim()) ?? HTTPS_REMOTE.exec(remote.trim())
  return match ? `https://github.com/${match[1]}/${match[2]}` : undefined
}

/**
 * A Thread's move to the cloud as its windows show it: `packing` while its checkout and sessions are sent ahead,
 * nothing here changed yet; `pausing` while a handoff stops its running turn to take it along, the turn continuing
 * where the Thread lands; `handing-over` once this Mac released it and its machine takes it, when nothing runs it
 * anywhere; `resuming` once the cloud claimed it and its sessions resume there; `moved`. `kept-here` says why it
 * didn't move, with everything as it was; `unsettled` says the cloud's answer isn't known yet, and that it's asked
 * again: the Thread runs nowhere until it is.
 */
export type ThreadMoveStep =
  /**
   * A Thread in the main checkout moving onto its own branch first, taking only its own changes; `to`, once there, when
   * the conversation that goes on is another (its harness couldn't resume in another folder, so it forked): the rest of
   * the move's steps are that conversation's.
   */
  | { kind: "own-branch"; to?: string }
  /**
   * Its checkout and records going ahead while its machine gets ready. `sent`: of the checkout's bytes that have to go,
   * how many have, said again as they go (a quarter second apart at most).
   */
  | { kind: "packing"; sent?: MoveSent }
  | { kind: "pausing" }
  | { kind: "handing-over" }
  | { kind: "resuming" }
  /** Every conversation of the Thread that moved, each the cloud's now under its own id; `continued`: a turn the handoff paused goes on there. */
  | { kind: "moved"; conversations: string[]; continued?: boolean; carried?: MoveCarried }
  /** `continued`: a turn the handoff had paused goes on here. */
  | { kind: "kept-here"; reason: string; continued?: boolean }
  | { kind: "unsettled"; reason: string }

/** How much of a move's checkout has gone to the cloud: `bytes` of `of`, which grows as each repository's is packed. */
export type MoveSent = { bytes: number; of: number }

/**
 * A move of a Thread whose agents may be working (rule 2 of moves): each running turn is paused, the Thread moves,
 * and the turn continues where it lands. `why` says who asked: the person (`asked`), a quit with agents running, or
 * this Mac going to sleep, when it must be released by `releaseBy` (wall-clock ms) or stay here untouched.
 */
export type ThreadHandOff = { why: "asked" | "quit" | "sleep"; releaseBy?: number }

/** A Thread of this Mac's whose agents are working, as a quit or a sleep would hand it to the cloud. */
export type HandOffCandidate = {
  /** The conversation at work, whose window shows the move's steps. */
  conversationId: string
  thread: string
  title?: string
  harness: string
  /** Why it can't go to the cloud now (it isn't in its own worktree, say); absent when it can. */
  refusal?: string
}

/** How a handoff went for one Thread. */
export type HandOffResult = { conversationId: string; outcome: ThreadMoveOutcome }

/** The person's choice about handing agents to the cloud when this Mac sleeps, and whether this Mac can. */
export type HandOffSettings = {
  /** Hand working agents to the cloud as this Mac goes to sleep (a closed lid, the Apple menu). */
  onSleep: boolean
  /** Why this Mac can't hand off on sleep, when it can't (signed out of the cloud, not a Mac); absent when it can. */
  unavailable?: string
}

/**
 * What `mako:thread-move` came to: the Thread runs on a cloud Thread now, or it stayed here, and why. `released`, only
 * for a quit's handoff: this Mac let go of the Thread and its host carries the rest (the last changes sent, the claim,
 * the start), so the window can close; the move's steps say how it ends.
 */
/**
 * What `mako:thread-move` came to. `conversation`: the conversation that went, when it isn't the one asked (a Thread in
 * the main checkout whose harness forked onto its own branch).
 */
export type ThreadMoveOutcome = { kind: "moved"; cloudThread: string; conversation?: string } | { kind: "released"; cloudThread: string } | { kind: "kept-here"; reason: string } | { kind: "unsettled"; reason: string }

/**
 * A way back refused before the cloud let go, because the Thread's worktree here has no project to come back into:
 * `project`, the repository its worktree was made from, isn't on this Mac anymore (moved or deleted), and `folder` is
 * the worktree. Bringing it back with the project's folder as it is now (`ThreadReturnOptions.project`) brings it there.
 */
export const ReturnProjectMissingSchema = z.object({ folder: z.string(), project: z.string().optional() })
export type ReturnProjectMissing = z.infer<typeof ReturnProjectMissingSchema>

/** How a person asks a Thread back: `project`, the folder its project is in now, when the one it was made from moved. */
export type ThreadReturnOptions = { project?: string }

/**
 * Who a return is waiting on, when it's unsettled: `cloud`, an answer this Mac didn't hear; `here`, work of this Mac's
 * own that failed after the cloud let go. Either way it's asked again by the same return.
 */
export type ReturnWaitsOn = "cloud" | "here"

/** A Thread coming back from the cloud, step by step, as the window it was asked from shows it. */
export type ThreadReturnStep =
  /** Its machine stops taking work and packs the checkout and the records. */
  | { kind: "packing" }
  /** The checkout and each Session's records are arriving here. */
  | { kind: "bringing" }
  /** Every conversation of the Thread runs here again, under its own id. */
  | { kind: "back"; conversations: string[]; landed?: ReturnLanded }
  /**
   * `outdated`: a harness here is older than the one that wrote its sessions in the cloud; updating it lets it come.
   * `missing`: its project isn't on this Mac; choosing where it is now lets it come.
   */
  | { kind: "stayed"; reason: string; outdated?: OutdatedRestore; missing?: ReturnProjectMissing }
  | { kind: "unsettled"; reason: string; waitsOn: ReturnWaitsOn }

/**
 * What a move took besides its checkout, as the person reads it: how many repositories and outside files went, and
 * what stayed and why (`MoveLeft`), from the move's carry.
 */
export type MoveCarried = { repositories: number; outside: number; left: MoveLeft[] }

/**
 * How a Thread's work landed here as it came back, where it wasn't simply laid down: `merged`, files the person had
 * changed in its worktree meanwhile that kept both sides; `conflicts`, files both changed, left with Git's markers;
 * `mine`, the branch the person's own commits there were kept on; `outside`, its files outside the worktree, put in
 * place, removed, or `waiting`: the person changed them here since, so theirs stayed and the cloud's copies are kept apart.
 * `unsent`: files the cloud wrote outside the worktree that never left this Mac, kept apart and never put in place, since
 * only what this Mac sent forward comes back to its place. `failed`: each one that couldn't be written here, and why.
 */
export type ReturnLanded = {
  merged: string[]
  conflicts: string[]
  mine?: string
  /** `kept`: the folder the cloud's copies of the `waiting` and `unsent` files are kept in, each at its own path beneath it. */
  outside: { placed: string[]; removed: string[]; waiting: string[]; unsent?: string[]; failed?: Array<{ path: string; why: string }>; kept?: string }
}

/** What `mako:thread-return` came to: the Thread runs here again, or it stayed in the cloud, and why. */
export type ThreadReturnOutcome =
  | { kind: "back"; landed?: ReturnLanded }
  | { kind: "stayed"; reason: string; outdated?: OutdatedRestore; missing?: ReturnProjectMissing }
  | { kind: "unsettled"; reason: string; waitsOn: ReturnWaitsOn }

/** What a start reads of the cloud host's boot: the folder of its tab in front, which is the clone. */
const BootTabsSchema = z.object({
  activeTabId: z.string(),
  tabs: z.array(z.object({ id: z.string(), session: z.object({ meta: z.object({ cwd: z.string() }).loose() }).loose() }).loose()),
}).loose()

/** The folder a cloud host works in, read from its boot: its tab in front, which is the clone. */
export function bootFolder(boot: EncodedValue): string {
  const tabs = BootTabsSchema.parse(decodeRuntimeValue(boot))
  const cwd = tabs.tabs.find((tab) => tab.id === tabs.activeTabId)?.session.meta.cwd
  if (!cwd) throw new Error("The cloud machine has no folder to work in")
  return cwd
}

/**
 * Why a cloud Thread's start stopped before its harness: the machine couldn't make the Thread's folder, a clone of its
 * repository, even asked again. Its boot fails with these words (`mako:boot`), so no client starts a harness outside
 * the repository; `reason` is the machine agent's, which names what to do when it knows (Mako's GitHub App to install,
 * with its page).
 */
export function folderUnmade(reason: string): string {
  return `This Thread's repository couldn't be set up in the cloud, so nothing was started. ${sentence(reason)}`
}

/** The page where a person gives Mako's GitHub App access to a repository, as GitHub names it for any App. */
const GITHUB_APP_INSTALL = /\s+at\s+(https:\/\/github\.com\/apps\/[A-Za-z0-9-]+\/installations\/new)(?=[.\s]|$)/

/**
 * A start's failure as its person reads it: the words, and apart from them the GitHub page where they give Mako's
 * GitHub App access to the repository, when that's what's missing (the same page the cloud's turn-on card offers).
 */
export interface StartFailure {
  said: string
  install?: string
}

/** A start's failure read for its person (`StartFailure`). */
export function startFailure(message: string): StartFailure {
  const found = GITHUB_APP_INSTALL.exec(message)
  if (!found?.[1]) return { said: message }
  return { said: message.replace(found[0], ""), install: found[1] }
}

/** The agent's words as a sentence: Git's `fatal:` dropped, a capital first, a stop at the end. */
function sentence(words: string): string {
  const said = words.trim().replace(/^(?:fatal|error):\s*/i, "") || "No reason was given."
  return `${said[0]?.toUpperCase() ?? ""}${said.slice(1)}${/[.!?]$/.test(said) ? "" : "."}`
}

/** A reason the cloud keeps beside a move or a return: within `MOVE_REASON_MAX`, cut with an ellipsis rather than refused. */
export function clipReason(reason: string): string {
  const said = reason.trim() || "No reason was given."
  return said.length <= MOVE_REASON_MAX ? said : `${said.slice(0, MOVE_REASON_MAX - 1)}…`
}

/** The cloud's word to a cloud Thread's person when their own work is affected (`cloud-machine-notice`). */
export type { ThreadMachineNotice } from "@mako/protocol/saves"
