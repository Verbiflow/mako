import { z } from "zod"

/**
 * The version every envelope carries (`v` on operations, replies and events). Each side checks it exactly, so it
 * changes only when an envelope does; what a link adds goes in `LINK_VERSION`, which links negotiate.
 */
export const PROTOCOL_VERSION = 1

/**
 * The newest version of a runtime's link this build speaks, agreed at enrolment. 2 adds the runtime's `activity`
 * frame: whether it's working on a Thread, which keeps the Thread's machine running, and nothing else does. 3 adds
 * media (`media.ts`): live streams its clients watch, as binary messages beside the frames. 4 added a `listing` frame
 * keyed by cloud Thread, which a gateway takes and drops. 5 adds the runtime's `sessions` frame: its Sessions as the
 * account's list shows them, keyed by Mako's own IDs under the one-owner rule (`thread-listing.ts`). 6 lets a `sessions` row name its native
 * session, and list one Mako hasn't opened (a terminal's), with how its owner opens it. 7 adds `port-open`: a request to
 * an app the runtime serves on one of its ports, answered on a media stream (`ports.ts`). 8 adds `going-quiet`: the runtime
 * says it's going away on purpose (sleep, quit, sign-out) before it goes. 9 numbers what a runtime sends of a watched
 * conversation (`live`'s `n`), so a gateway takes a resend once and says on a new link what it last relayed (`watch`'s
 * `after`), and lets `live` carry a trace (`correlationId`) and `sessions` say when each row changed and when it was
 * reported (`changedAt`, `reportedAt`). 10 lets a `sessions` row say what a waiting Session waits on the person for
 * (`waitingFor`: an approval, a question, or anything else). 11 lets a `sessions` row say that its Thread is on its way
 * between a device and the cloud, and how far (`move`). 12 lets a `sessions` row say what its owner's rail shows of it:
 * the project it's filed under and what that project has checked out (`project`), the worktree branch it works on
 * (`worktree`), the agents it ran in before (`lineage`), and the background work it waits on (`background`). 13 lets
 * a runtime write live updates in the compact form where every reader reads it (`live-form.ts`): `watch` says the form
 * each watched conversation's readers read (`forms`), `live-form` says it of a Thread's, and `live` and `event` say the
 * form an update is in (`form`). 14 lets a `sessions` row say when the person last sent its Session a message, from any
 * device (`promptedAt`), which every rail orders its projects by, and that another app has a session Mako hasn't opened
 * open (`openElsewhere`). 15 adds SSH to a cloud Thread's machine (`ssh.ts`): `ssh-open` and `ssh-opened`, binary
 * messages from the gateway, and the runtime's `media-ack` for what it took of them. 16 lets a `sessions` row say its
 * folder's origin on GitHub and the branch it pushes to (`repository`), which a Session continued in the cloud while
 * its owner is off clones (`continues.ts`), and says a runtime that agreed it takes such a continue back as a move when
 * it returns. 17 lets a `sessions` row say the Session it was forked from (`forkOf`). 18 lets a `sessions` row say
 * what one of its Session's Fins asks the person (`asking`), which the row waits on, and where the Session stands
 * under it. 19 lets a `sessions` row say its Session's Fins (`fins`): every device shows an Apex's tree as its owner
 * does. 20 lets a row's Fins say all their selectors read of them (`FIN_STATES_VERSION`). 21 takes `borrow` frames,
 * what the runtime's Thread borrows as it changes. 22 lets a `sessions` row say its Session's place among its
 * Thread's Sessions (`order`, `SESSION_ORDER_VERSION`). 23 takes a device runtime's `advertise`: what it can serve
 * and its room. 24 carries the sessions a device lends: `source-ask`, `lent` and `lent-ended` to it, and its
 * `lease-beat`. 25 says the gateway takes a project folder Thread's `project` in a device's quiet note
 * (`QUIET_PROJECT_LINK_VERSION`). 26 says it takes a project folder Thread's other repositories there too
 * (`others`, `QUIET_OTHERS_LINK_VERSION`), and the device folder its project worktree mirrors (`projectFrom`,
 * `QUIET_PROJECT_FROM_LINK_VERSION`). 27 lets a `live` frame be `ephemeral`: the gateway passes it to the conversation's
 watchers who said they read such frames and keeps nothing of it (`EPHEMERAL_LIVE_VERSION`). 28 adds `passing`: the same
 for a Thread the runtime runs, to that Thread's readers who read such frames, never into its log
 (`PASSING_THREAD_VERSION`). 29 lets a `sessions` row say what the person marked its Thread with: where its work
 stands (`workStatus`, since `workStatusAt`) and that it's to be read again (`markedUnread`, `THREAD_MARKS_VERSION`).
 30 says the gateway holds a Fin's reports for its Apex's Session, wherever that runs (`tree-notices.ts`,
 `TREE_NOTICES_LINK_VERSION`). 31 lets a `sessions` row say its deliberate Apex: its name, what it covers, when the
 person last read its digest and its plan (`apex`, `APEX_LISTED_VERSION`), so every device shows it while its owner is
 off. 32 lets a borrower be a Thread in no project, in a `source-ask` or `lent` frame
 (`PROJECTLESS_BORROWER_LINK_VERSION`). Every envelope stays at `PROTOCOL_VERSION` on every link version.
 */
export const LINK_VERSION = 32

/** The first link version a runtime may send `activity` on; a gateway that agreed less never sees one. */
export const ACTIVITY_VERSION = 2

/** The first link version a gateway may ask a runtime for media on; a runtime that agreed less is never asked. */
export const MEDIA_VERSION = 3

/** The link version whose `listing` frame a gateway takes and drops: runtimes from 2026-10-24 that speak 4 send it. */
export const LISTING_VERSION = 4

/** The first link version a runtime may send `sessions` on; a gateway that agreed less never sees one. */
export const SESSIONS_VERSION = 5

/** The first link version a `sessions` row may carry `nativeId` and `capture` on: a gateway that agreed less refuses them. */
export const NATIVE_SESSIONS_VERSION = 6

/** The first link version a gateway may send `port-open` on; a runtime that agreed less is never asked. */
export const PORTS_VERSION = 7

/** The first link version a runtime may send `going-quiet` on; a gateway that agreed less never sees one. */
export const QUIET_VERSION = 8

/**
 * The first link version whose `live` frames carry the runtime's number (`n`) and a trace, whose `watch` says what was
 * last relayed of each conversation (`after`), and whose `sessions` rows say when they changed (`changedAt`) and when the
 * report went (`reportedAt`). A gateway that agreed less refuses all four.
 */
export const NUMBERED_LIVE_VERSION = 9

/** The first link version whose `sessions` rows say what a waiting Session waits on (`waitingFor`); a gateway that agreed less refuses it. */
export const WAITING_FOR_VERSION = 10

/** The first link version whose `sessions` rows say a Thread on its way between a device and the cloud (`move`); a gateway that agreed less refuses it. */
export const MOVES_VERSION = 11

/**
 * The first link version whose `sessions` rows say what their owner's rail shows of them (`project`, `worktree`,
 * `lineage`, `background`); a gateway that agreed less refuses them.
 */
export const RAIL_VERSION = 12

/**
 * The first link version whose `watch` says the live form each watched conversation's readers read (`forms`), whose
 * gateway says a Thread's (`live-form`), and whose `live` and `event` say the form an update is in (`form`). A runtime
 * on a link that agreed less is told neither, so it writes form 1 alone, which every reader reads.
 */
export const COMPACT_LIVE_VERSION = 13

/**
 * The first link version whose `sessions` rows say when the person last sent them a message (`promptedAt`) and that
 * another app has them open (`openElsewhere`); a gateway that agreed less refuses both.
 */
export const PROMPTED_VERSION = 14

/** The first link version a gateway may send `ssh-open` and binary messages on; a runtime that agreed less is never asked. */
export const SSH_VERSION = 15

/**
 * The first link version whose `sessions` rows may say their `repository`, and whose runtime takes a Thread the account
 * continued in the cloud while it was off as moved when it's back (`continues.ts`): a device on a link that agreed less
 * isn't offered for a continue, and its gateway refuses the field.
 */
export const CONTINUE_VERSION = 16

/** The first link version whose `sessions` rows may say the Session they were forked from (`forkOf`); a gateway that agreed less refuses it. */
export const FORKS_VERSION = 17

/**
 * The first link version whose `sessions` rows may say what a Session's Fin asks the person (`asking`): a link that
 * agreed less hears the row as it stands under the ask, and none of it.
 */
export const ASKING_VERSION = 18

/**
 * The first link version whose `sessions` rows may say their Session's Fins (`fins`): a link that agreed less hears the
 * row without them, as before.
 */
export const FINS_VERSION = 19

/**
 * The first link version whose `sessions` rows may say all of a Fin's state: `refused`, `apexStopped`, `answered`,
 * `unfinished`, and what an idle one waits on (`waitingOn`, `since`). A gateway that agreed 19 refuses a row saying any
 * of them, so it hears each Fin as 19 knew it.
 */
export const FIN_STATES_VERSION = 20

/**
 * The first link version that takes `borrow` frames: what the runtime's Thread borrows changed (`borrow.ts`'s pushes),
 * said as it changes. A link that agreed less reads the same pushes by asking for them.
 */
export const BORROW_LINK_VERSION = 21

/**
 * The first link version whose `sessions` rows may say their Session's place in its Thread (`order`). A gateway that
 * agreed 21 or before refuses a row saying it, so such a gateway hears the row without, and a device showing that
 * Thread ranks its rows as it did before: the first listed first.
 */
export const SESSION_ORDER_VERSION = 22

/**
 * The first link version a device's runtime may send `advertise` on: its capabilities and slots as it probed them
 * (`borrow.ts`), on enrolment, on each change and hourly. A gateway that agreed less hears none, and routes nothing to it.
 */
export const ADVERTISE_LINK_VERSION = 23

/**
 * The first link version that carries the sessions a device lends (`borrow.ts`): what it's asked as a source, the leases
 * it serves as they're issued and end, and its heartbeats for them. A device on an older link answers asks by polling
 * for them, and serves no session, since nothing could keep one alive.
 */
export const LEND_LINK_VERSION = 24

/**
 * The first link version whose gateway takes a quiet note's Thread naming its `project` (`handoff.ts`), where its
 * Sessions open on the machine. Nothing on the link itself changes: the note goes over HTTP, and a gateway before it
 * refuses a note carrying one (its schema is strict), so a device sends it only once its link agreed this.
 */
export const QUIET_PROJECT_LINK_VERSION = 25

/**
 * The first link version whose gateway takes a quiet note's Thread naming its project folder's other repositories, each
 * with its checkpoint (`others`, `handoff.ts`). As with `project`, nothing on the link changes, and a gateway before it
 * refuses a note carrying them, so a device sends them only once its link agreed this.
 */
export const QUIET_OTHERS_LINK_VERSION = 26

/**
 * The first link version whose gateway takes a quiet note's Thread naming the device folder its `project` mirrors
 * (`projectFrom`, `handoff.ts`), where it places each Session by its path from there. A gateway before it refuses a note
 * carrying one, and places every Session outside the standby's folder at `project` itself.
 */
export const QUIET_PROJECT_FROM_LINK_VERSION = 26

/**
 * The first link version whose gateway takes an `ephemeral` live frame: a watched conversation's passing state (a
 * running call's steps), relayed to its current watchers that read such frames (`EPHEMERAL_PARAM`) as an `ephemeral`
 * frame, unnumbered, and never kept in its stream's tail, so it can't push a kept update out of it. A runtime on an
 * older link sends none: such a gateway would number and keep it as any update.
 */
export const EPHEMERAL_LIVE_VERSION = 27

/**
 * The first link version whose gateway takes a runtime's `passing` frame: a Thread's passing state (a running call's
 * steps, an app's hint), relayed to the Thread's current readers that read such frames (`EPHEMERAL_PARAM`) as an
 * `ephemeral` frame, under the runtime's generation for it, and never written into the Thread's log. A runtime on an
 * older link sends none: the only way into a Thread then is its log, which keeps everything.
 */
export const PASSING_THREAD_VERSION = 28

/**
 * The first link version whose gateway takes a `sessions` row's Thread marks (`workStatus`, `workStatusAt`,
 * `markedUnread`): a gateway that agreed less gets the row without them, and its devices show no status.
 */
export const THREAD_MARKS_VERSION = 29

/**
 * The first link version whose gateway takes a Fin's report as a notice it holds for the Apex's Session
 * (`tree-notices.ts`). Nothing on the link itself changes: a notice is posted over HTTP, which a gateway before this
 * has no path for, so a Fin's host posts one only once its link agreed this. Whether the Apex's host takes a notice
 * from the account is its own word, in what it advertises (`TREE_NOTICES_CAPABILITY`).
 */
export const TREE_NOTICES_LINK_VERSION = 30

/**
 * The first link version whose gateway takes a `sessions` row's deliberate Apex (`apex`, `ListedApexSchema`): a gateway
 * that agreed less gets the row without it, and its devices read the Apex from its owner while that answers.
 */
export const APEX_LISTED_VERSION = 31

/**
 * The first link version whose device reads a borrower with no project (a cloud Thread in no repository, `borrow.ts`)
 * in a `source-ask` or `lent` frame. A gateway sends a device that agreed less no frame naming one: that device's
 * parser required a project, and a frame it can't read is no answer. Its reads over HTTP say it with `PROJECTLESS_READER`.
 */
export const PROJECTLESS_BORROWER_LINK_VERSION = 32

/**
 * The link versions this build can speak. A gateway keeps older versions working for runtimes that wake
 * weeks after they paused; raise `min` only when no supported runtime needs the old one.
 */
export const SUPPORTED_VERSIONS = { min: 1, max: LINK_VERSION } as const

export const VersionRangeSchema = z.lazy(() => z
  .object({
    min: z.number().int().positive(),
    max: z.number().int().positive(),
  })
  .strict()
  .refine((range) => range.min <= range.max, "min is above max"))

export type VersionRange = z.infer<typeof VersionRangeSchema>

/** The highest version both sides speak, or null when the ranges don't meet. */
export function negotiate(
  ours: VersionRange,
  theirs: VersionRange
): number | null {
  const version = Math.min(ours.max, theirs.max)
  return version >= Math.max(ours.min, theirs.min) ? version : null
}
