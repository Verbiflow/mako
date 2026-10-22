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
 * nothing here changed yet; `handing-over` once this Mac released it and its machine takes it, when nothing runs it
 * anywhere; `resuming` once the cloud claimed it and its sessions resume there; `moved`. `kept-here` says why it
 * didn't move, with everything as it was; `unsettled` says the cloud's answer isn't known yet, and that it's asked
 * again: the Thread runs nowhere until it is.
 */
export type ThreadMoveStep =
  | { kind: "packing" }
  | { kind: "handing-over" }
  | { kind: "resuming" }
  /** Every conversation of the Thread that moved, each the cloud's now under its own id. */
  | { kind: "moved"; conversations: string[] }
  | { kind: "kept-here"; reason: string }
  | { kind: "unsettled"; reason: string }

/** What `mako:thread-move` came to: the Thread runs on a cloud Thread now, or it stayed here, and why. */
export type ThreadMoveOutcome = { kind: "moved"; cloudThread: string } | { kind: "kept-here"; reason: string } | { kind: "unsettled"; reason: string }
