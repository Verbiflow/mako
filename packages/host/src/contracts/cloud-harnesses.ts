import { z } from "zod"
import type { RuntimeUpdateOffer } from "./restore-plan.js"

/**
 * The harness versions Mako Cloud's machines run, as the cloud says (`GET /v1/cloud/harnesses`). Every account's
 * machines start from one image, built from one Mako revision, which installs exactly the versions that revision
 * tested. The cloud serves the record of the image it makes machines from now, so a Mac weighs its own harnesses
 * against what a machine will run, never against its own idea of it: this Mako's `tested` can be older or newer than
 * the image's.
 */
export const CloudHarnessesSchema = z.object({
  /** The image new machines start from. */
  image: z.string(),
  /** The Mako revision it was built from. */
  revision: z.string(),
  /** Each harness's version there: the version its sessions are written with, and the one a restore there weighs. */
  harnesses: z.record(z.string(), z.string()),
})
export type CloudHarnesses = z.infer<typeof CloudHarnessesSchema>

/**
 * A harness this Mac runs older than the cloud's. Once a Session of it works in the cloud, the cloud's version wrote
 * it, and records go only into the version that wrote them or a newer one (`restoreGate`): the Thread comes back
 * only once this Mac's is at least `cloud`.
 */
export type HarnessBehind = {
  harness: string
  /** This Mac's, as a restore here reads it. */
  here: string
  cloud: string
  /**
   * How this Mac's gets to `cloud`: Mako's update when it installs `cloud` or newer; Mako itself (`owner`) when this
   * Mako tested an older version than the cloud runs, since its update never goes past what it tested; otherwise the
   * app that owns the install, or a command (`RuntimeUpdates.restoreRuntime`).
   */
  offer: RuntimeUpdateOffer
  /** For an `update` offer, the version it installs: this Mako's `tested`, `cloud` or newer. */
  to?: string
}

/** A Session the cloud can't resume: the version here that wrote it is newer than the cloud's, so its arrival refuses it. */
export type HarnessAhead = {
  harness: string
  /** The newest version here that wrote it. */
  wrote: string
  cloud: string
}

/**
 * What a Thread's harnesses here and in the cloud mean for moving it, before anything moves
 * (`mako:thread-harness-check`). `ahead` refuses the move (its arrival would). `behind` lets it go, and says what
 * the way back will need. For a Thread in the cloud, only `behind`: what bringing it back needs. `unknown`: the cloud
 * didn't say what it runs (one that predates saying it, or one this Mac can't reach), so nothing is said ahead, and
 * the arrival's and the return's own checks still hold.
 */
export type ThreadHarnessCheck =
  | { kind: "unknown"; reason: string }
  /** `refusal`: when something is `ahead`, the words the move is refused with. */
  | { kind: "known"; image: string; ahead: HarnessAhead[]; behind: HarnessBehind[]; refusal?: string }
