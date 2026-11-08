import type { AcpConversation, AcpState } from "../src/state/acp-state"
import type { Store } from "../src/state/store"

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
 * For a suite that drives the window's own code: its process fails at exit if that code (anything under `src/`) wrote
 * what a host said of a conversation around the door. The suite's own fixtures may write the store directly.
 */
export function failAroundTheDoor(acpStore: Store<AcpState>, receivingLive: (id: string) => boolean): void {
  const { strays } = watchDoor(acpStore, receivingLive)
  process.on("exit", () => {
    const around = strays.filter((stray) => stray.by?.includes("/src/"))
    if (!around.length) return
    console.error(`Written around the live door (receiveLive), ${around.length} times: ${JSON.stringify(around.slice(0, 5))}`)
    process.exitCode = 1
  })
}
