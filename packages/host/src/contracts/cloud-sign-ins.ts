import { z } from "zod"

/** A harness's id, as its definition names it; one whose adapter can export its sign-in can hand it to cloud machines. */
export const CloudSignInHarnessSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/)
export type CloudSignInHarness = z.infer<typeof CloudSignInHarnessSchema>
/** More harnesses than Mako has: a machine is never given more sign-ins than this. */
export const CLOUD_SIGN_IN_MAX_HARNESSES = 32

/** Big enough for any harness's credential file; a payload over it is refused, never cut. */
export const CLOUD_SIGN_IN_MAX_BYTES = 64 * 1024

/**
 * One harness's sign-in as a cloud machine is given it: read from the Mac's
 * native store by that harness's adapter, and written back by the same
 * adapter on the machine. Mako Cloud stores and forwards it without reading
 * `payload`.
 *
 * A machine never holds a refresh token: a harness that rotates its sign-in
 * and refreshed there would sign out every other holder. For those harnesses
 * the cloud keeps the whole pair (`CloudSharedChainSchema`) and is its one
 * refresher; machines get the access alone.
 */
export const CloudSignInSchema = z
  .object({
    harness: CloudSignInHarnessSchema,
    /** Who it signs in as, for Settings: an email or account name, never a secret. */
    label: z.string().max(200).nullable(),
    /** When the access it carries lapses unless the Mac sends a fresh one; `null` for a key that doesn't. */
    expiresAt: z.iso.datetime().nullable(),
    /** The adapter's own shape of the credential, refresh token withheld. */
    payload: z.record(z.string(), z.json()),
  })
  .strict()
  .refine((signIn) => new TextEncoder().encode(JSON.stringify(signIn.payload)).length <= CLOUD_SIGN_IN_MAX_BYTES, {
    message: `A sign-in is at most ${CLOUD_SIGN_IN_MAX_BYTES} bytes`,
  })
export type CloudSignIn = z.infer<typeof CloudSignInSchema>
/** A whole sign-in, refresh token included, for Mako Cloud to keep: who it is, and the harness's own shape of it. */
export type CloudSignInChain = Pick<CloudSignIn, "label" | "payload">

/** A sign-in as Mako Cloud lists it, for Settings: never its value. */
export const CloudSignInListingSchema = z.object({
  harness: CloudSignInHarnessSchema,
  label: z.string().nullable(),
  expiresAt: z.string().nullable(),
  /** When it was last sent. */
  savedAt: z.string(),
  /** Sent by the device asking; another of the account's Macs may have sent the rest. */
  mine: z.boolean(),
})
export type CloudSignInListing = z.infer<typeof CloudSignInListingSchema>

/**
 * A sign-in Mako Cloud keeps and refreshes, so it lasts while every Mac sleeps: `shared` is a Mac's own, seeded once
 * and mirrored back to it after every refresh; `own` was signed in once more for the cloud alone. `retrying` still
 * serves machines; `needs-reconnect` is a refresh token the provider refused, signed in again on the Mac.
 */
export const CloudKeptSignInSchema = z.object({
  harness: CloudSignInHarnessSchema,
  label: z.string().nullable(),
  state: z.enum(["connected", "refreshing", "retrying", "needs-reconnect"]),
  expiresAt: z.string().nullable(),
  connectedAt: z.string(),
  refreshedAt: z.string().nullable(),
  problem: z.object({ reason: z.enum(["revoked", "interrupted", "unavailable"]), detail: z.string(), at: z.string() }).nullable(),
  /** The refresh token in use, by the first 8 characters of its SHA-256: compared, never a value. */
  token: z.string().optional(),
  source: z.enum(["shared", "own"]).optional(),
  /** Shared from the device asking. */
  mine: z.boolean().optional(),
})
export type CloudKeptSignIn = z.infer<typeof CloudKeptSignInSchema>

/** The whole pair of a sign-in this Mac shares, as the cloud last refreshed it, for its harness to run on here. */
export const CloudSharedChainSchema = z.object({
  harness: CloudSignInHarnessSchema,
  label: z.string().nullable(),
  token: z.string(),
  expiresAt: z.string().nullable(),
  payload: z.record(z.string(), z.json()),
})
export type CloudSharedChain = z.infer<typeof CloudSharedChainSchema>

/** What sharing a sign-in did: the cloud took it (`seeded`, `adopted`), had it (`current`), or has a newer one (`stale`). */
export const CloudShareOutcomeSchema = z.object({
  outcome: z.enum(["seeded", "adopted", "current", "stale"]),
  signIn: CloudKeptSignInSchema,
})
export type CloudShareOutcome = z.infer<typeof CloudShareOutcomeSchema>

/** One harness's row in Settings: what this Mac reads, and what it last sent. */
export type CloudSignInRow = {
  harness: CloudSignInHarness
  /** `sent`: Mako Cloud has what this Mac reads now. `signed-out`: nothing to send, and nothing is left there. */
  status: "sent" | "signed-out" | "failed" | "waiting"
  label: string | null
  expiresAt: string | null
  sentAt?: string
  /** Why it failed, in words for people. */
  problem?: string
  /** This harness's sign-in rotates, so it's one sign-in for this Mac and the cloud, which refreshes it for both. */
  rotates?: boolean
  /** The sign-in Mako Cloud keeps for it, which machines run with instead of this Mac's. */
  kept?: CloudKeptSignIn
  /** When this Mac's own sign-in and the one Mako Cloud refreshes for it were last the same, for a shared one. */
  inStepAt?: string
}

/** Whether this Mac shares its sign-ins with Mako Cloud, and how each harness stands. */
export type CloudSignInsState = {
  /** The person's choice, kept on this Mac. */
  sharing: boolean
  /** Why nothing is sent while sharing is on. */
  blocked?: "signed-out" | "no-cloud"
  /** When this Mac last read every harness. */
  checkedAt?: string
  harnesses: CloudSignInRow[]
}

/** What became of one harness's sign-in on a machine, for the agent's state page. Never a secret. */
export type CloudSignInInstall =
  | { harness: CloudSignInHarness; status: "installed"; at: string; expiresAt: string | null }
  | { harness: CloudSignInHarness; status: "failed"; at: string; reason: string }
  /** No longer in the account's set: signed out on the device that sent it, or no longer shared. */
  | { harness: CloudSignInHarness; status: "removed"; at: string }
