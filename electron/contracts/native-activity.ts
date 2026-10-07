import { z } from "zod"
import type { Compaction, TranscriptEvent } from "@mako/sessions/events"

export { CONTEXT_COMPACTED } from "@mako/sessions/events"

/**
 * What a running turn is doing while it has nothing to show: the provider
 * compacting its context, waiting to retry the model, or holding the turn
 * for a check of its own. Harnesses report it from their own events; one
 * that reports none still reads as working, then quiet.
 */
export const NativeActivityObservationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("compacting") }),
  z.object({
    kind: z.literal("retrying"),
    attempt: z.number().int().positive().optional(),
    maxAttempts: z.number().int().positive().optional(),
    reason: z.string().optional(),
    /** Host epoch ms of the next attempt, when the provider says. */
    retryAt: z.number().optional(),
  }),
  /** The provider holds the turn for its own check; `label` says which ("Reviewing the approval"). */
  z.object({ kind: z.literal("waiting"), label: z.string() }),
])
export type NativeActivityObservation = z.infer<typeof NativeActivityObservationSchema>

/**
 * A running turn's current `NativeActivityObservation`, from `since` (host
 * epoch ms). The host holds it for the running turn only: it ends with the
 * turn, a retry ends with the next output, and the journal never keeps it.
 */
export type NativeActivity = NativeActivityObservation & { since: number }

/**
 * What one native event means in Mako's shared vocabulary. A harness's
 * decoder returns a list of these for an event it knows (empty when it
 * deliberately shows nothing), or `undefined` for one it doesn't, which the
 * engine logs once.
 */
export type NativeNotice =
  | { kind: "activity"; activity: NativeActivityObservation | null }
  | { kind: "compacted"; compaction?: Compaction }
  | { kind: "event"; event: TranscriptEvent }
  /** The harness dropped its history from its turn `run` on. */
  | { kind: "rewound"; run: string }
