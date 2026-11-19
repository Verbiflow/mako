import { getMako, hasBridge } from "@/lib/bridge"
import type { LiveSessionMode } from "@/lib/types"
import { acpStore } from "@/state/acp-state"
import { createHook, createStore } from "@/state/store"
import { ACCESS_LADDER } from "@mako/host/contracts/agents"
import { errorMessage } from "@mako/host/contracts/error-message"

/**
 * A running session's access, changed from any window. The person's pick shows at once, as a sent message draws
 * before its host confirms it: the round trip to the host and the harness is a few milliseconds on a quiet host and
 * as long as the host's queue on a busy one, and the picker used to stand on the old level for all of it. The host's
 * answer settles it: taken, the session says the mode itself; refused, the pick goes back to where the session is and
 * the caller says why.
 *
 * Shown early, it must never be believed early: a message sent while a change is on its way waits for it
 * (`modeSettled`), so no turn starts under the level the person just left. A change to a narrower level that was
 * refused stops the message that waited on it, since the session is still wider than they chose; one to a wider level
 * lets it go, under the narrower level the session kept. The host holds the same line for every client
 * (`LiveConversations.setMode`).
 */

/** The access each conversation's person picked that its host hasn't answered for yet. */
const switchStore = createStore({ pending: new Map<string, { mode: string }>() })
export const useSwitching = createHook(switchStore)

/** How a change went: taken, or refused with why. */
export type ModeSwitch = { kind: "taken" } | { kind: "refused"; mode: string; reason: string; narrowing: boolean }

/** Each conversation's changes, one after another, and how the last one asked went. */
const chains = new Map<string, Promise<ModeSwitch>>()

function setPending(conversation: string, mode: string | undefined): void {
  const pending = new Map(switchStore.get().pending)
  if (mode) pending.set(conversation, { mode })
  else pending.delete(conversation)
  switchStore.set({ pending })
}

/** The mode a conversation's pickers show: the pick on its way, else where its session is. */
export function shownMode(conversation: string, current: string | null | undefined): string | null | undefined {
  return switchStore.get().pending.get(conversation)?.mode ?? current
}

function liveSession(conversation: string) {
  const live = acpStore.get().conversations[conversation]
  return live?.kind === "live" ? live.session : undefined
}

/**
 * Whether a session that stays in `stays` runs wider than `chosen` would have had it: by the tiers its harness gives
 * the two modes. A mode with no tier, and `deny`, which sits beside the ladder, count as narrower than anything else,
 * so a refusal there always stops the message that waited on it.
 */
export function widerThanChosen(modes: readonly LiveSessionMode[], stays: string | null | undefined, chosen: string): boolean {
  if (stays === chosen) return false
  const tier = (id: string | null | undefined) => {
    const access = modes.find((mode) => mode.id === id)?.access
    return access ? ACCESS_LADDER.indexOf(access) : -1
  }
  const kept = tier(stays)
  const wanted = tier(chosen)
  if (kept === -1 || wanted === -1) return true
  return kept > wanted
}

/**
 * Asks the conversation's host for `mode`, showing it from now. Changes asked while one is on its way go after it, in
 * the order asked, and the pick shown is the last one. Never rejects.
 */
export function switchLiveMode(conversation: string, mode: string): Promise<ModeSwitch> {
  if (!hasBridge()) return Promise.resolve({ kind: "taken" })
  setPending(conversation, mode)
  const ahead = chains.get(conversation)
  const change = (ahead ?? Promise.resolve()).then(async (): Promise<ModeSwitch> => {
    try {
      await getMako().liveSetMode(conversation, mode)
      return { kind: "taken" }
    } catch (error) {
      const session = liveSession(conversation)
      return { kind: "refused", mode, reason: errorMessage({ error }), narrowing: widerThanChosen(session?.modes ?? [], session?.currentMode, mode) }
    }
  })
  chains.set(conversation, change)
  void change.then((went) => {
    // A later pick is still on its way: it keeps the picker.
    if (chains.get(conversation) !== change) return
    chains.delete(conversation)
    if (went.kind === "taken") showUntilSaid(conversation, mode)
    else setPending(conversation, undefined)
  })
  return change
}

/** How long a pick its host took stays shown without the session saying it, before the session's own mode shows again. */
const SAID_WITHIN_MS = 2_000

/**
 * A pick its host took stays shown until the session says the mode itself: that word travels on the event stream,
 * which may trail the call's answer, and the picker would fall back to the level it left between the two. Only the
 * host's word changes what the window holds of a session (`live-door.ts`), so nothing is written for it here.
 */
function showUntilSaid(conversation: string, mode: string): void {
  const done = () => liveSession(conversation)?.currentMode === mode || chains.has(conversation) || switchStore.get().pending.get(conversation)?.mode !== mode
  const settle = () => {
    stop()
    clearTimeout(timer)
    // A later pick shows its own.
    if (!chains.has(conversation) && switchStore.get().pending.get(conversation)?.mode === mode) setPending(conversation, undefined)
  }
  const stop = acpStore.subscribe(() => { if (done()) settle() })
  const timer = setTimeout(settle, SAID_WITHIN_MS)
  if (done()) settle()
}

/**
 * Resolves once no access change for the conversation is on its way, with how the last one went; at once, `taken`,
 * when none is. Everything that starts a turn waits on it first (`sendTo`, `steerTo`, a goal, a review).
 */
export async function modeSettled(conversation: string): Promise<ModeSwitch> {
  let last: ModeSwitch = { kind: "taken" }
  for (let change = chains.get(conversation); change; change = chains.get(conversation)) {
    last = await change
    // Its own settling let go of it before this ran, or left a later pick in its place; anything else would loop.
    if (chains.get(conversation) === change) break
  }
  return last
}

/** What a message that waited on a refused narrowing says in place of going: the session is wider than its person chose. */
export function refusedNarrowing(conversation: string, change: ModeSwitch): string | undefined {
  if (change.kind !== "refused" || !change.narrowing) return undefined
  const name = liveSession(conversation)?.modes.find((mode) => mode.id === change.mode)?.name ?? change.mode
  return `Not sent: the access couldn't be changed to ${name}, so this session still allows more than you chose. ${change.reason}`
}
