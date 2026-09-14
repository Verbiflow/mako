import { toast } from "sonner"
import { getMako, hasBridge } from "@/lib/bridge"
import type { LiveSessionMode, ThreadRef } from "@/lib/types"
import { prefsStore, setPref } from "@/state/prefs"
import type { ThreadsState } from "@/state/thread-state"

const NO_MODES: LiveSessionMode[] = []

/**
 * The access ladder a new session with `harness` offers, as the host declared
 * it before any process starts. Returns the store's own array so a selector
 * built on it does not re-render on every token.
 */
export function providerAccessModes(
  state: Pick<ThreadsState, "liveCapabilities">,
  harness: string
): LiveSessionMode[] {
  return (
    state.liveCapabilities.find((item) => item.provider === harness)?.modes ??
    NO_MODES
  )
}

/** The saved choice for `harness`, only while the provider still offers it. */
export function savedProviderMode(
  saved: Readonly<Record<string, string>>,
  modes: readonly LiveSessionMode[],
  harness: string
): string | null {
  const id = saved[harness]
  return id && modes.some((mode) => mode.id === id) ? id : null
}

/**
 * The mode a fresh session runs under when nothing was chosen, as the host
 * declared it — the level the picker reports before a session exists.
 */
export function providerDefaultMode(
  state: Pick<ThreadsState, "liveCapabilities">,
  modes: readonly LiveSessionMode[],
  harness: string
): string | null {
  const id = state.liveCapabilities.find(
    (item) => item.provider === harness
  )?.defaultMode
  return id && modes.some((mode) => mode.id === id) ? id : null
}

/**
 * The mode a catalogued thread last ran under, as the host remembered it,
 * when the composer targets that thread's own provider and the provider still
 * offers the mode. It outranks the provider-wide choice because it is the
 * thread's own fact: the tier its last turn ran under.
 */
export function threadAccessMode(
  ref: Pick<ThreadRef, "harness" | "accessMode"> | undefined,
  modes: readonly LiveSessionMode[],
  harness: string
): string | null {
  const id = ref?.harness === harness ? ref.accessMode : undefined
  return id && modes.some((mode) => mode.id === id) ? id : null
}

/**
 * Save the access level the provider's next session starts with. A live
 * session records its own switch here too, so the next session starts where
 * the last one was left.
 */
export function chooseProviderMode(harness: string, modeId: string): void {
  setPref("providerModes", {
    ...prefsStore.get().providerModes,
    [harness]: modeId,
  })
}

/**
 * A choice made while viewing a thread that is not live is the thread's:
 * the host remembers it for that native session, for every host that serves
 * it, and the provider-wide default follows so a fresh session starts there
 * too.
 */
export function chooseThreadMode(ref: Pick<ThreadRef, "path" | "harness">, modeId: string): void {
  chooseProviderMode(ref.harness, modeId)
  if (!hasBridge()) return
  getMako()
    .rememberThreadMode(ref.path, modeId)
    .catch((error) => toast.error(String(error)))
}
