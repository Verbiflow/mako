import type { AcpConversation, AcpState } from "../src/state/acp-state"
import type { Store } from "../src/state/store"
import type { MakoBridge } from "@mako/host/contracts/renderer-bridge"

/**
 * What only this window says of a live conversation: its draft, what it is sending or stopping, what the person has
 * seen, its prompts not yet the host's, and the transcript it holds in memory (paged in and out by the window itself,
 * `unloadLive` and transcript residency). Every other field is what its host said, which reaches the window's state only
 * through the door (`receiveLive`).
 */
export const WINDOW_OWN = new Set<string>([
  "draftKey", "sending", "canceling", "failureSeen", "pendingPrompts", "queued", "hiddenUserPrompt", "replyBindingId",
  "threadPath", "title", "updatedAt", "hydrated", "projection", "blocks", "history", "base", "baseCoveredBlocks",
  "releasedTurns",
])

/** A change to what a host said of a conversation that didn't go through the door, and the code that wrote it. */
export interface Stray { key: string; fields: string[]; by?: string }

/** A watch of the door: the strays it has seen so far, and how to end it. */
export interface DoorWatch { strays: Stray[]; stop: () => void }

/** The first frame of the stack that isn't the store's or this watch's: what wrote the change. */
function writer(): string | undefined {
  return new Error("where").stack?.split("\n").slice(1).map((line) => line.trim())
    .find((line) => !/live-door-watch|state\/store\.ts|state\/acp-state\.ts|node:/.test(line))
}

/**
 * Watches every change to the window's conversations (the store's own subscription, which runs inside each write),
 * over every key before and after it: a live conversation made or removed, or any field but the window's own changed,
 * while nothing is being taken in through the door for it (nor let go of by the window, `letGoLive`), is a stray.
 * `strays` lists them as they're made; `stop` ends the watch.
 */
export function watchDoor(acpStore: Store<AcpState>, receivingLive: (id: string) => boolean): DoorWatch {
  const strays: Stray[] = []
  let before = acpStore.get().conversations
  const stop = acpStore.subscribe(() => {
    const after = acpStore.get().conversations
    if (after === before) return
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      const was: AcpConversation | undefined = before[key], now: AcpConversation | undefined = after[key]
      if (was === now || (was?.kind !== "live" && now?.kind !== "live") || receivingLive(key)) continue
      const [held, taken] = [new Map(Object.entries(was ?? {})), new Map(Object.entries(now ?? {}))]
      const fields = !now ? ["removed"]
        : was?.kind !== "live" ? ["kind"]
        : [...new Set([...held.keys(), ...taken.keys()])].filter((field) => !WINDOW_OWN.has(field) && !Object.is(held.get(field), taken.get(field)))
      if (fields.length) strays.push({ key, fields, by: writer() })
    }
    before = after
  })
  return { strays, stop }
}

/**
 * Every bridge method that answers with a conversation's snapshot. A message's own send (`liveContinue`) answers with
 * one the window never takes, and isn't a read.
 */
const SNAPSHOT_READS = ["liveSnapshot", "liveRead", "liveEarlier", "liveGoal", "liveReview", "liveSideQuestion", "liveMergeFork",
  "liveClearQueue", "liveEditQueued", "liveTransfer", "liveRewind", "liveBind", "liveCapture", "liveFork", "liveStart", "liveAttach",
  "liveRecoverRewinds", "resolveContinuation", "resolveOwner"] as const
type SnapshotRead = (typeof SNAPSHOT_READS)[number]

/** The bridge methods `watchReads` instruments, as a window's bridge or a test's fake of it has them. */
export type ReadBridge = Partial<Pick<MakoBridge, SnapshotRead>>

/** A bridge call that read a conversation's snapshot with no read of it out (`readLive`), and the code that made it. */
export interface Bypass { method: SnapshotRead; asked?: string; by?: string }

/** A watch of the bridge's reads: the calls it caught around the window's one read so far. */
export interface ReadWatch { bypasses: Bypass[] }

/**
 * Instruments a bridge in place: each method of `SNAPSHOT_READS` it has records a call made while no read of the
 * conversation it asks of is out (`readingLive`), so a read that goes around the window's one read fails. A call names
 * the conversation its answer is about: by its id, a fork's, a rewind's or a start's by the one it makes, and a path's
 * owner or recovered rewinds by none (a read whose answer names it); a `liveRead` of a history page reads no snapshot.
 */
export function watchReads(bridge: ReadBridge, readingLive: (id?: string) => boolean): ReadWatch {
  const watch: ReadWatch = { bypasses: [] }
  const asked = (method: SnapshotRead, id: string | undefined) => {
    if (!readingLive(id)) watch.bypasses.push({ method, ...(id !== undefined && { asked: id }), by: writer() })
  }
  const { liveSnapshot, liveRead, liveEarlier, liveGoal, liveReview, liveSideQuestion, liveMergeFork, liveClearQueue, liveEditQueued,
    liveTransfer, liveRewind, liveBind, liveCapture, liveFork, liveStart, liveAttach, liveRecoverRewinds, resolveContinuation, resolveOwner } = bridge
  if (liveSnapshot) bridge.liveSnapshot = (...args) => (asked("liveSnapshot", args[0]), liveSnapshot(...args))
  if (liveRead) bridge.liveRead = (...args) => (args[1].kind === "snapshot" && asked("liveRead", args[0]), liveRead(...args))
  if (liveEarlier) bridge.liveEarlier = (...args) => (asked("liveEarlier", args[0]), liveEarlier(...args))
  if (liveGoal) bridge.liveGoal = (...args) => (asked("liveGoal", args[0]), liveGoal(...args))
  if (liveReview) bridge.liveReview = (...args) => (asked("liveReview", args[0]), liveReview(...args))
  if (liveSideQuestion) bridge.liveSideQuestion = (...args) => (asked("liveSideQuestion", args[0]), liveSideQuestion(...args))
  if (liveMergeFork) bridge.liveMergeFork = (...args) => (asked("liveMergeFork", args[0]), liveMergeFork(...args))
  if (liveClearQueue) bridge.liveClearQueue = (...args) => (asked("liveClearQueue", args[0]), liveClearQueue(...args))
  if (liveEditQueued) bridge.liveEditQueued = (...args) => (asked("liveEditQueued", args[0]), liveEditQueued(...args))
  if (liveTransfer) bridge.liveTransfer = (...args) => (asked("liveTransfer", args[0]), liveTransfer(...args))
  if (liveRewind) bridge.liveRewind = (...args) => (asked("liveRewind", args[1].id), liveRewind(...args))
  if (liveBind) bridge.liveBind = (...args) => (asked("liveBind", args[0]), liveBind(...args))
  if (liveCapture) bridge.liveCapture = (...args) => (asked("liveCapture", args[0]), liveCapture(...args))
  if (liveFork) bridge.liveFork = (...args) => (asked("liveFork", args[1].id), liveFork(...args))
  if (liveStart) bridge.liveStart = (...args) => (asked("liveStart", args[2].conversationId), liveStart(...args))
  if (liveAttach) bridge.liveAttach = (...args) => (asked("liveAttach", undefined), liveAttach(...args))
  if (liveRecoverRewinds) bridge.liveRecoverRewinds = (...args) => (asked("liveRecoverRewinds", undefined), liveRecoverRewinds(...args))
  if (resolveContinuation) bridge.resolveContinuation = (...args) => (asked("resolveContinuation", undefined), resolveContinuation(...args))
  if (resolveOwner) bridge.resolveOwner = (...args) => (asked("resolveOwner", undefined), resolveOwner(...args))
  return watch
}

/**
 * For a suite that drives the window's own code: its process fails at exit if that code (anything under `src/`) wrote
 * what a host said of a conversation around the door, or read a conversation's snapshot around its one read
 * (`readLive`), on the bridge it holds when this is called. The suite's own fixtures may do either directly.
 */
export function failAroundTheDoor(acpStore: Store<AcpState>, receivingLive: (id: string) => boolean, readingLive?: (id?: string) => boolean): void {
  const { strays } = watchDoor(acpStore, receivingLive)
  const bridge = globalThis.window?.mako
  const reads: ReadWatch = readingLive && bridge ? watchReads(bridge, readingLive) : { bypasses: [] }
  process.on("exit", () => {
    const around = strays.filter((stray) => stray.by?.includes("/src/"))
    const unread = reads.bypasses.filter((bypass) => bypass.by?.includes("/src/"))
    if (around.length) console.error(`Written around the live door (receiveLive), ${around.length} times: ${JSON.stringify(around.slice(0, 5))}`)
    if (unread.length) console.error(`Read around the window's one read (readLive), ${unread.length} times: ${JSON.stringify(unread.slice(0, 5))}`)
    if (around.length || unread.length) process.exitCode = 1
  })
}
