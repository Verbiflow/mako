import { getMako } from "@/lib/bridge"
import { createHook, createStore } from "@/state/store"

/**
 * A cloud Thread's machine woken by the first key pressed in its composer, so the minute a sleeping machine takes to
 * start overlaps the writing instead of following Send. One wake per Thread, however many keys, composers or messages
 * ask: asked through the conversation (`mako:live-prewarm`), which the gateway answers by starting the Thread's machine
 * when it sleeps, and repeats under one ID while it starts (`sendWithRepeats`). A message sent meanwhile waits for it.
 *
 * A wake that answers at once found the machine awake, and is never said: "Waking…" shows only once one has taken
 * longer than `SAY_WAKING_MS`.
 */

/** A wake still unanswered after this is a machine starting, and the dock says so. */
export const SAY_WAKING_MS = 400
/** A machine woken this recently is taken as awake: the next key asks nothing. A sleeping one takes many minutes idle. */
const AWAKE_FOR_MS = 60_000

type Wake = { promise: Promise<void>; startedAt: number; done?: number }
const wakes = new Map<string, Wake>()

/** The Threads whose machine is being woken now and has taken long enough to say so. */
export const wakingStore = createStore({ waking: new Set<string>() })
export const useWaking = createHook(wakingStore)

function said(thread: string, waking: boolean): void {
  const next = new Set(wakingStore.get().waking)
  if (waking) next.add(thread)
  else next.delete(thread)
  wakingStore.set({ waking: next })
}

/**
 * Wakes the cloud Thread `thread` through its open conversation, once: a wake under way is joined, one answered within
 * the last minute is taken as done. Resolves when the machine answers; a wake that fails resolves too, as the message
 * that waits on it is sent anyway, and its own repeats and refusal say what happened.
 */
export function wakeThread(thread: string, conversation: string, now = Date.now()): Promise<void> {
  const held = wakes.get(thread)
  if (held && (held.done === undefined || now - held.done < AWAKE_FOR_MS)) return held.promise
  const wake: Wake = { startedAt: now, promise: Promise.resolve() }
  const slow = setTimeout(() => said(thread, true), SAY_WAKING_MS)
  wake.promise = getMako()
    .livePrewarm(conversation)
    .then(
      () => undefined,
      () => {
        // Not answered: the next key asks again.
        wakes.delete(thread)
      }
    )
    .finally(() => {
      clearTimeout(slow)
      wake.done = Date.now()
      said(thread, false)
    })
  wakes.set(thread, wake)
  return wake.promise
}

/** Whether a wake of `thread` is under way: a message sent now waits for it. */
export function wakingNow(thread: string): boolean {
  const held = wakes.get(thread)
  return held !== undefined && held.done === undefined
}
