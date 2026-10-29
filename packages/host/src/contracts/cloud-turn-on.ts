/**
 * Turning Mako Cloud on, from "I want the cloud" to the first Thread running there, as one line (`mako:cloud-turn-on`,
 * and the `cloud-turn-on` event as it changes). Nothing here is a second truth: each step is read from what owns it
 * (the account, the agents' sign-ins, the project bases, the sync engine's marks, the cloud conversations), so the line
 * says the same as the section that owns each fact, and it resumes after a quit as those do. What the host keeps of
 * its own is only when each step was first seen done, to say how long it took.
 */

/** In the order a person meets them. */
export const TURN_ON_STEPS = ["account", "plan", "agents", "projects", "history", "thread"] as const
export type TurnOnStepId = (typeof TURN_ON_STEPS)[number]

/**
 * `done`; `working`, going by itself; `yours`, waiting on the person (signing in, an invite, the first message);
 * `stuck`, held by a problem whose fix is said; `later`, not reached because a step before it is the person's.
 */
export type TurnOnStepState = "done" | "working" | "yours" | "stuck" | "later"

/** What the person can do about a step: each is one action the window offers beside it. */
export type TurnOnFix =
  /** Sign this Mac in to Mako. */
  | "sign-in"
  /** Ask the cloud again whether the account has it now (an invite, later a payment). */
  | "check-plan"
  /** Sign the named agent in again on this Mac; the cloud follows. */
  | "sign-in-agent"
  /** Ask again for the project bases that failed. */
  | "retry-bases"
  /** Copy what failed, with its correlation IDs. */
  | "copy-details"
  /** Start the first Thread in the cloud. */
  | "start-thread"

/** A project base as the cloud stands it (`POST /v1/bases/standing`). */
export type BaseStanding =
  | { state: "ready"; madeAt: string }
  | { state: "making"; since: string }
  /**
   * Due and not yet started: waiting for room on the cloud's machines, or for its next try after a failure.
   * `no-access`: the cloud can't read the repository (private, or gone), so trying again won't help.
   */
  | { state: "waiting"; message?: string; retryAt?: string; reason?: "no-access" }
  /** Tried and given up until its next use: its Threads clone as they start. */
  | { state: "failed"; message: string; reason?: "no-access" }
  /** This cloud makes no bases (its machines can't be snapshotted): every Thread clones, as fast as that is. */
  | { state: "none" }
  /** A cloud that doesn't say, or a base it hasn't heard of. */
  | { state: "unknown" }

/** One of this Mac's recent projects offered for a base, the newest first. */
export type TurnOnProject = {
  /** The project's folder on this Mac. */
  folder: string
  /** Its GitHub repository, `https://github.com/<owner>/<name>`. */
  repository: string
  base: BaseStanding
}

export type TurnOnAgent = {
  harness: string
  /** `in-cloud`: there, and kept fresh; `sending`: going now; `stuck`: needs signing in again here. */
  state: "in-cloud" | "sending" | "stuck"
  problem?: string
}

type Step<Id extends TurnOnStepId, Detail> = {
  id: Id
  state: TurnOnStepState
  /** When this Mac first saw it done (ms); it stays done once seen unless its source says otherwise. */
  at?: number
  /** Why it's stuck, in words; with the fix the window offers. */
  problem?: string
  fix?: TurnOnFix
} & Detail

export type TurnOnStep =
  | Step<"account", { connection?: "connecting" | "connected" | "offline"; signingIn?: boolean }>
  | Step<"plan", Record<never, never>>
  /** Each agent signed in on this Mac; none signed in here is done with nothing to send. `sharing` false: the person kept them here. */
  | Step<"agents", { sharing: boolean; agents: TurnOnAgent[] }>
  /** The bases of the recent projects onboarding offered, the newest first; empty when none is on GitHub. */
  | Step<"projects", { projects: TurnOnProject[] }>
  /** The last 7 days, in Threads; `today` counts the Threads at work and worked in today. */
  | Step<"history", { threads: number; inCloud: number; today: { threads: number; inCloud: number }; paused: boolean; failures: number; correlationIds: string[] }>
  /** The first cloud Thread: in which project it would start, and its machine if one is warming for it. */
  | Step<"thread", { folder?: string; repository?: string; machine?: "warming" | "ready" }>

/**
 * `ready` once a Thread can run in the cloud (signed in, the cloud on the account, the agents' sign-ins there); `on`
 * once every step is done. Bases, history and the first Thread go on behind `ready`, said, never waited for.
 */
export type CloudTurnOnPhase = "unavailable" | "signed-out" | "no-cloud" | "turning-on" | "ready" | "on"

export type CloudTurnOn = {
  phase: CloudTurnOnPhase
  /** When this Mac first heard the account has the cloud (ms), which each step's time is counted from. */
  since?: number
  readyAt?: number
  onAt?: number
  steps: TurnOnStep[]
}

export type TurnOnStepOf<Id extends TurnOnStepId> = Extract<TurnOnStep, { id: Id }>
