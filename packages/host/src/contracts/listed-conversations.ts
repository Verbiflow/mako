import { sessionStream } from "@mako/protocol"
import type { ListedSession, ListedState } from "@mako/protocol/thread-listing"
import type { LiveSummary } from "./live-conversations.js"

/**
 * A Session of the account's list as a window lists it, before anything of its owner is read: the one mapping every
 * client of the account uses, a Mac's host for its windows and a browser alike, so they can't list a row differently.
 */

/** How a list shows a Session's state, as a session's status: `waiting` is a turn at work, with what it waits on said beside. */
export const LISTED_STATUS = { working: "running", waiting: "running", idle: "ready", failed: "failed", moving: "starting" } as const satisfies Record<ListedState, LiveSummary["session"]["status"]>
/**
 * The same, for a row of a quiet device (`QuietDevice`): nothing there runs or answers for anyone else, so nothing is
 * shown at work or waiting on the person; a message to it waits in the account until the device is back.
 */
export const QUIET_STATUS = { ...LISTED_STATUS, working: "ready", waiting: "ready" } as const satisfies Record<ListedState, LiveSummary["session"]["status"]>

/**
 * What a window lists of a Session it knows only from the account's list: the row, where it runs in words, and nothing
 * that takes its owner. Opening it reads the rest there, as it would any cloud conversation's. A row of a quiet device
 * is listed as that device left it, but not at work.
 */
export function listedSummary(row: ListedSession, where: string, quietSince: string | undefined): LiveSummary {
  const quiet = quietSince !== undefined
  const summary: LiveSummary = {
    session: {
      id: row.conversation,
      harness: row.harness,
      cwd: row.folder ?? "",
      status: (quiet ? QUIET_STATUS : LISTED_STATUS)[row.state],
      connection: "hibernated",
      modes: [],
      currentMode: null,
      configOptions: [],
    },
    revision: 0,
    createdAt: Date.parse(row.createdAt),
    elsewhere: where,
    threadId: row.thread,
    sessionId: row.session,
  }
  if (row.title) summary.session.title = row.title
  if (row.threadTitle) summary.threadTitle = row.threadTitle
  if (row.waitingOn && !quiet) summary.waitingOn = row.waitingOn
  if (quiet) summary.quietSince = Date.parse(quietSince)
  return summary
}

/** Where a cloud conversation's folder is, in words. */
export const CLOUD_FOLDER_WHERE = "a cloud machine"

/**
 * Who answers a listed Session's calls, and the stream its live updates come on: a device's runtime (`d-<device>`),
 * through the cloud, and that conversation's own stream there, which its device sends only while someone watches; or a
 * cloud Thread, whose stream carries every conversation its machine runs.
 */
export type ListedOwner =
  | { kind: "device"; deviceId: string; runtimeId: string; stream: string }
  | { kind: "cloud"; threadId: string; stream: string }

export function listedOwner(row: Pick<ListedSession, "runsOn" | "conversation">): ListedOwner {
  if (row.runsOn.kind === "cloud") return { kind: "cloud", threadId: row.runsOn.threadId, stream: `thread:${row.runsOn.threadId}` }
  const runtimeId = `d-${row.runsOn.deviceId}`
  return { kind: "device", deviceId: row.runsOn.deviceId, runtimeId, stream: sessionStream(runtimeId, row.conversation) }
}
