import { z } from "zod"
import { AccessChoicesSchema } from "./access-choices.js"
import { AutomationsChangedEventSchema } from "./automations-cloud.js"
import { PreferencesSchema } from "./preferences.js"
import type { StreamId } from "./events.js"
import { ThreadIdSchema } from "./ids.js"
import { ArchivedThreadSchema, LISTED_PER_FRAME, ListedSessionSchema } from "./thread-listing.js"
import { WAITING_PER_SESSION, WaitingMessageSchema } from "./waiting.js"

/**
 * What an account's own stream (`account:<id>`) carries: what happened to its devices and its Threads, each event
 * numbered by the account's one object and kept, so every device following it hears of each in order, and a device
 * that was off hears of what happened meanwhile when it comes back. A device that joined, from where and how; a
 * device that left, and why; Sessions listed or changed, each whole (`sessions-listed`, `thread-listing.ts`), and
 * Sessions that left the list; a device gone quiet, or back; the person's access choices. An event of a type a client
 * doesn't know is skipped, never refused.
 */

/** Where a request came from, as the cloud read its address: never the address. */
export const AccountPlaceSchema = z.lazy(() => z.object({ city: z.string().nullable(), region: z.string().nullable(), country: z.string().nullable() }))

export const AccountEventSchema = z.lazy(() => z.discriminatedUnion("type", [
  z.object({
    type: z.literal("device-joined"),
    device: z.object({
      id: z.uuid(),
      kind: z.enum(["desktop", "runtime", "cli", "browser"]),
      name: z.string().max(80),
      platform: z.string().max(40),
      enrolledBy: z.enum(["browser", "device-code"]),
      from: AccountPlaceSchema.nullable(),
    }),
  }),
  z.object({
    type: z.literal("device-removed"),
    deviceId: z.uuid(),
    /** `removed` by another of the account's devices (`by`), `signed-out` by itself, `credential-reused` by the cloud. */
    reason: z.enum(["removed", "signed-out", "credential-reused"]),
    by: z.uuid().nullable(),
  }),
  /** Sessions listed for the first time, or changed as a list shows them: each row whole, replacing the last. */
  z.object({ type: z.literal("sessions-listed"), sessions: z.array(ListedSessionSchema).min(1).max(LISTED_PER_FRAME) }),
  /** Sessions that left the list: closed, older than it keeps, or on a device that left the account. */
  z.object({ type: z.literal("sessions-unlisted"), sessions: z.array(z.uuid()).min(1).max(LISTED_PER_FRAME) }),
  /**
   * A device went quiet (`QuietDeviceSchema`: the cloud last heard from it at `since`), or, with `since` null, was heard
   * from again: what the list shows of its rows changes, the rows themselves don't. `continues`: its Mako takes a
   * Thread continued in the cloud back (`QuietDevice.continues`, link version 16 on).
   */
  z.object({ type: z.literal("device-quiet"), deviceId: z.uuid(), since: z.iso.datetime().nullable(), continues: z.literal(true).optional() }),
  /** A Session's messages waiting for its owner (`waiting.ts`), all of them as they stand now; none once each was taken or taken back. */
  z.object({ type: z.literal("messages-waiting"), session: z.uuid(), messages: z.array(WaitingMessageSchema).max(WAITING_PER_SESSION) }),
  /**
   * A cloud Thread archived: ended in the cloud and kept with the archived ones (`ArchivedThreadSchema`). Its Sessions
   * left the list, said first by `sessions-unlisted`, so a device that doesn't know this event drops them all the same.
   */
  z.object({ type: z.literal("thread-archived"), thread: ArchivedThreadSchema }),
  /** An archived cloud Thread a Mac took back: it leaves the archived ones, and its Mac lists its Sessions as its own. */
  z.object({ type: z.literal("thread-unarchived"), thread: ThreadIdSchema }),
  /** The person's access choices changed (`access-choices.ts`): all of them as they stand now, at their revision. */
  z.object({ type: z.literal("access-chosen"), choices: AccessChoicesSchema, revision: z.number().int().nonnegative() }),
  /**
   * Preferences that follow the account changed (`preferences.ts`): only those that changed, at the revision the change
   * made. A device that missed one (a skipped number, a sign-in) reads them all again.
   */
  z.object({ type: z.literal("preferences-changed"), preferences: PreferencesSchema, revision: z.number().int().nonnegative() }),
  /**
   * The account's automations' runs changed, up to the run sequence `seq` (`automations-cloud.ts`): a device reads
   * `GET /v1/automations/runs` on from the last it took, its poll kept as the fallback.
   */
  AutomationsChangedEventSchema,
]))
export type AccountEvent = z.infer<typeof AccountEventSchema>
/** An event about the account's devices, as against its Threads. */
export type AccountDeviceEvent = Extract<AccountEvent, { type: "device-joined" | "device-removed" }>

/** The stream an account's devices follow for its events. */
export function accountStream(accountId: string): StreamId {
  return `account:${accountId}`
}
