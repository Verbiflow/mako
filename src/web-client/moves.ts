import type { MoveSent, ThreadMoveStep, ThreadReturnStep } from "@mako/host/contracts/cloud-threads"
import { createHook, createStore } from "@/state/store"
import type { MoveWay } from "./move-progress"
import type { WebThread } from "./threads"

/**
 * A Thread moving between a Mac and the cloud, as this browser follows it: one it asked for (a Mac asked to move it up,
 * or to bring it back), or one it heard of, from the steps its owner sends to whoever watches it and from the
 * account's list, which says a move from its first step (`ListedSession.move`). The owner does the move and owns its
 * truth; this only says where it stands, and how it ended: moved, refused with the owner's reason, or waiting on an
 * answer.
 */
export interface WebMove {
  thread: string
  /** The conversation it was asked from, whose steps its owner sends. */
  conversation: string
  way: MoveWay
  /** The Mac it leaves, or comes back to. */
  mac: { deviceId: string; name: string }
  move?: string
  /** The owner's step (`ThreadMoveStep`, `ThreadReturnStep`), or `asking` before the first is heard. */
  step: string
  /** When this browser heard the step begin. */
  stepAt: number
  sent?: MoveSent
  /** Its turn was at work and goes along, paused here and carried on there. */
  handOff: boolean
  /** Asked from this browser. */
  ours: boolean
  end?: { kind: "done" } | { kind: "failed"; reason: string } | { kind: "unsettled"; reason: string }
}

export const movesStore = createStore<{ moves: ReadonlyMap<string, WebMove> }>({ moves: new Map() })
export const useMoves = createHook(movesStore)

/** A move this browser follows, as it stands now. */
export function putMove(move: WebMove): void {
  const moves = new Map(movesStore.get().moves)
  moves.set(move.thread, move)
  movesStore.set({ moves })
}

/** The move is over for this browser: its card goes, the Thread shows as it is now. */
export function dismissMove(thread: string): void {
  const moves = new Map(movesStore.get().moves)
  if (!moves.delete(thread)) return
  movesStore.set({ moves })
}

/** A move that ended well stays said this long in the Thread's place, then gives way to the Thread. */
export const DONE_SHOWN_MS = 2_500

/** A move came to its end: moved, refused with the owner's reason, or waiting on an answer. */
export function endMove(thread: string, move: string | undefined, end: NonNullable<WebMove["end"]>): void {
  const held = movesStore.get().moves.get(thread)
  if (!held || (move && held.move && held.move !== move) || held.end?.kind === "done") return
  putMove({ ...held, end })
  if (end.kind === "done") setTimeout(() => movesStore.get().moves.get(thread)?.end?.kind === "done" && dismissMove(thread), DONE_SHOWN_MS)
}

/** Ends that close a move, by step: done, or refused with the owner's reason. */
const CLOUD_ENDS = new Set(["moved", "kept-here", "unsettled"])
const DEVICE_ENDS = new Set(["back", "stayed", "unsettled"])

/**
 * A step of a move its owner sent to whoever watches the conversation it was asked from: one asked here moves on, one
 * asked elsewhere (on the Mac) is followed from here too. `thread` and `mac` say whose, for one first heard here.
 */
export function stepHeard(heard: { conversation: string; move: string; way: MoveWay; step: ThreadMoveStep | ThreadReturnStep; thread: string | undefined; mac: { deviceId: string; name: string } | undefined }): void {
  const held = [...movesStore.get().moves.values()].find((move) => move.conversation === heard.conversation || move.move === heard.move)
  const thread = held?.thread ?? heard.thread
  const mac = held?.mac ?? heard.mac
  if (!thread || !mac) return
  if (held?.end && held.move === heard.move) return
  const step = heard.step
  if ((heard.way === "cloud" ? CLOUD_ENDS : DEVICE_ENDS).has(step.kind)) {
    if (!held) return
    if (step.kind === "moved" || step.kind === "back") endMove(thread, heard.move, { kind: "done" })
    else if ("reason" in step) endMove(thread, heard.move, { kind: step.kind === "unsettled" ? "unsettled" : "failed", reason: step.reason })
    return
  }
  const sent = step.kind === "packing" && "sent" in step ? step.sent : undefined
  const same = held?.move === heard.move && held.step === step.kind
  putMove({
    thread,
    conversation: held?.conversation ?? heard.conversation,
    way: heard.way,
    mac,
    move: heard.move,
    step: step.kind,
    stepAt: same ? held.stepAt : Date.now(),
    ...(sent ? { sent } : same && held.sent ? { sent: held.sent } : {}),
    handOff: (held?.handOff ?? false) || step.kind === "pausing",
    ours: held?.ours ?? false,
  })
}

/**
 * A Thread's move as the account's list says it, when this browser follows none of its own: from a Mac's row while it
 * goes up (`move`, from its first step), or in transit (`moving`) either way.
 */
export function listedMove(thread: WebThread): Pick<WebMove, "way" | "step" | "stepAt"> | undefined {
  // A quiet device's word on a move is as old as its last report: nothing moves while it can't be heard.
  for (const session of thread.sessions) {
    if (session.quietSince) continue
    const move = session.row.move
    if (move) return { way: move.to, step: move.step, stepAt: Math.min(Date.parse(move.since), Date.now()) }
  }
  const moving = thread.sessions.find((session) => session.row.state === "moving" && !session.quietSince)
  if (moving) return { way: moving.row.runsOn.kind === "cloud" ? "device" : "cloud", step: "moving", stepAt: Date.parse(moving.row.listedAt) }
  return undefined
}
