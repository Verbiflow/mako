import type { OutdatedRestore } from "./restore-plan.js"
import type { SessionSettings } from "@mako/sessions/settings"
import { z } from "zod"

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
  | { kind: "packing" }
  | { kind: "pausing" }
  | { kind: "handing-over" }
  | { kind: "resuming" }
  /** Every conversation of the Thread that moved, each the cloud's now under its own id; `continued`: a turn the handoff paused goes on there. */
  | { kind: "moved"; conversations: string[]; continued?: boolean }
  /** `continued`: a turn the handoff had paused goes on here. */
  | { kind: "kept-here"; reason: string; continued?: boolean }
  | { kind: "unsettled"; reason: string }

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
export type ThreadMoveOutcome = { kind: "moved"; cloudThread: string } | { kind: "released"; cloudThread: string } | { kind: "kept-here"; reason: string } | { kind: "unsettled"; reason: string }

/** A Thread coming back from the cloud, step by step, as the window it was asked from shows it. */
export type ThreadReturnStep =
  /** Its machine stops taking work and packs the checkout and the records. */
  | { kind: "packing" }
  /** The checkout and each Session's records are arriving here. */
  | { kind: "bringing" }
  /** Every conversation of the Thread runs here again, under its own id. */
  | { kind: "back"; conversations: string[] }
  /** `outdated`: a harness here is older than the one that wrote its sessions in the cloud; updating it lets it come. */
  | { kind: "stayed"; reason: string; outdated?: OutdatedRestore }
  | { kind: "unsettled"; reason: string }

/** What `mako:thread-return` came to: the Thread runs here again, or it stayed in the cloud, and why. */
export type ThreadReturnOutcome = { kind: "back" } | { kind: "stayed"; reason: string; outdated?: OutdatedRestore } | { kind: "unsettled"; reason: string }
