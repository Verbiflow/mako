import type { MoveSent, ThreadMoveStep, ThreadReturnStep } from "@mako/host/contracts/cloud-threads"
import type { ListedMove } from "@mako/protocol/thread-listing"
import { createHook, createStore } from "@/state/store"
import type { MoveWay } from "./move-progress"
import type { WebThread } from "./threads"

/**
 * A Thread moving between a Mac and the cloud, as this browser follows it: one it asked for (a Mac asked to move it up,
 * or to bring it back), or one it heard of, from the steps its owner sends to whoever watches it and from the
 * account's list, which says a move from its first step (`ListedSession.move`). The owner does the move and owns its
 * truth; this only says where it stands, and how it ended (`MoveEnd`).
 */
export interface WebMove {
  thread: string
  /**
   * The conversation whose steps its owner sends: the one it was asked from, or the one it goes on as once a Thread in
   * the main checkout forked onto its own branch (`own-branch` with `to`).
   */
  conversation: string
  way: MoveWay
  /** The Mac it leaves, or comes back to. */
  mac: { deviceId: string; name: string }
  move?: string
  /** The owner's step (`ThreadMoveStep`, `ThreadReturnStep`), or `asking` before the first is heard. */
  step: string
  /** When the step began: as the list said it, else when this browser heard it begin. */
  stepAt: number
  sent?: MoveSent
  /** Its turn was at work and goes along, paused here and carried on there. */
  handOff: boolean
  /** Asked from this browser. */
  ours: boolean
  end?: MoveEnd
}

/**
 * How a move stands at its end, as far as this browser knows. `done` and `failed` are the owner's word (moved; refused
 * with its reason, or never asked at all), and nothing heard later changes them. `unsettled`: the owner waits on the
 * cloud's answer. `unconfirmed`: this browser's own, its answer lost on the way (the phone slept, the network went);
 * how it went isn't known, so the same move is asked again by its ID. A later step overrides either.
 */
export type MoveEnd = { kind: "done" } | { kind: "failed"; reason: string } | { kind: "unsettled"; reason: string } | { kind: "unconfirmed"; reason: string }

/** Whether an end is the owner's last word on its move: nothing heard later changes it. */
export function settledEnd(end: MoveEnd | undefined): boolean {
  return end?.kind === "done" || end?.kind === "failed"
}

export const movesStore = createStore<{ moves: ReadonlyMap<string, WebMove> }>({ moves: new Map() })
export const useMoves = createHook(movesStore)

/** A move this browser follows, as it stands now. */
export function putMove(move: WebMove): void {
  const moves = new Map(movesStore.get().moves)
  moves.set(move.thread, move)
  movesStore.set({ moves })
}

/** The move is over for this browser: its strip goes. */
export function dismissMove(thread: string): void {
  const moves = new Map(movesStore.get().moves)
  if (!moves.delete(thread)) return
  movesStore.set({ moves })
}

/** A move that ended well stays said this long above the Thread, then gives way. */
export const DONE_SHOWN_MS = 2_500

/**
 * A move came to an end, or this browser lost its answer: moved, refused with the owner's reason, waiting on an answer,
 * or not confirmed. An end the owner said is kept; one this browser only assumed gives way to whatever comes next.
 */
export function endMove(thread: string, move: string | undefined, end: MoveEnd): void {
  const held = movesStore.get().moves.get(thread)
  if (!held || (move && held.move && held.move !== move) || settledEnd(held.end)) return
  putMove({ ...held, end })
  if (end.kind === "done") setTimeout(() => movesStore.get().moves.get(thread)?.end?.kind === "done" && dismissMove(thread), DONE_SHOWN_MS)
}

/** Ends that close a move, by step: done, or refused with the owner's reason. */
const CLOUD_ENDS = new Set(["moved", "kept-here", "unsettled"])
const DEVICE_ENDS = new Set(["back", "stayed", "unsettled"])

/** A step as its owner sent it, and where it was heard: whose it is, for one first heard here, and what the list says. */
export interface HeardStep {
  conversation: string
  move: string
  way: MoveWay
  step: ThreadMoveStep | ThreadReturnStep
  thread: string | undefined
  mac: { deviceId: string; name: string } | undefined
  /** The heard conversation's row's word on its move (`ListedSession.move`): a step the list said first began then. */
  listed?: ListedMove | undefined
}

/**
 * A step of a move its owner sent to whoever watches the conversation it was asked from: one asked here moves on, one
 * asked elsewhere (on the Mac) is followed from here too. `thread` and `mac` say whose, for one first heard here. A
 * step after an end this browser only assumed (not confirmed, or waiting on the cloud) carries on from there.
 */
export function stepHeard(heard: HeardStep): void {
  const held = [...movesStore.get().moves.values()].find((move) => move.conversation === heard.conversation || move.move === heard.move)
  const thread = held?.thread ?? heard.thread
  const mac = held?.mac ?? heard.mac
  if (!thread || !mac) return
  if (held?.move === heard.move && settledEnd(held.end)) return
  const step = heard.step
  if ((heard.way === "cloud" ? CLOUD_ENDS : DEVICE_ENDS).has(step.kind)) {
    if (!held) return
    if (step.kind === "moved" || step.kind === "back") endMove(thread, heard.move, { kind: "done" })
    else if ("reason" in step) endMove(thread, heard.move, { kind: step.kind === "unsettled" ? "unsettled" : "failed", reason: step.reason })
    return
  }
  const sent = step.kind === "packing" && "sent" in step ? step.sent : undefined
  const same = held?.move === heard.move && held.step === step.kind
  // A step the list said first began when it said; one heard first here, now.
  const listedAt = heard.listed?.step === step.kind ? Math.min(Date.parse(heard.listed.since), Date.now()) : undefined
  putMove({
    thread,
    // Onto its own branch as a fork: the rest of its steps are the fork's.
    conversation: step.kind === "own-branch" && "to" in step && step.to ? step.to : (held?.conversation ?? heard.conversation),
    way: heard.way,
    mac,
    move: heard.move,
    step: step.kind,
    stepAt: same ? held.stepAt : (listedAt ?? Date.now()),
    ...(sent ? { sent } : same && held.sent ? { sent: held.sent } : {}),
    handOff: (held?.handOff ?? false) || step.kind === "pausing",
    ours: held?.ours ?? false,
  })
}

/**
 * Which way each followed move goes, by Thread, as a row says it: one that failed is left to the list. Read through
 * `shallowEqual`, so a step's progress (its bytes) re-renders no list.
 */
export function followedWays(moves: ReadonlyMap<string, WebMove>) {
  return Object.fromEntries([...moves].flatMap(([thread, move]) => {
    const way = followedWay(move)
    return way ? [[thread, way] as const] : []
  }))
}

/** Which way one followed move goes as its row says it, unless it failed. */
export function followedWay(move: WebMove | undefined): MoveWay | undefined {
  return move && move.end?.kind !== "failed" ? move.way : undefined
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
