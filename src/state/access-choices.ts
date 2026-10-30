import { chosenModes, type AccessChoices } from "@mako/host/contracts/access-choices"
import { getMako, hasBridge } from "@/lib/bridge"
import { prefsStore, setPref } from "@/state/prefs"
import { createHook, createStore } from "@/state/store"

/**
 * The person's access choice per harness, as the host keeps them for their account (`contracts/access-choices.ts`):
 * the mode a new session of each harness starts in, the same from this window, the web app or a phone. This window
 * shows them and asks the host to change them; it never keeps its own.
 */
interface AccessChoicesState {
  /** The mode ID chosen for each harness. */
  modes: Readonly<Record<string, string>>
}

/** Until the host answers, what this window kept before the host kept them, so the picker doesn't flicker. */
export const accessChoicesStore = createStore<AccessChoicesState>({ modes: { ...prefsStore.get().providerModes } })
export const useAccessChoices = createHook(accessChoicesStore)

/** The mode IDs chosen, by harness, as they stand now. */
export function chosenAccessModes(): Readonly<Record<string, string>> {
  return accessChoicesStore.get().modes
}

export function applyAccessChoices(choices: AccessChoices): void {
  accessChoicesStore.set({ modes: chosenModes(choices) })
}

/** Reads the host's choices, after handing it what this window kept on its own (`providerModes`), once. */
export async function loadAccessChoices(): Promise<void> {
  if (!hasBridge()) return
  const legacy = prefsStore.get().providerModes
  if (Object.keys(legacy).length) {
    applyAccessChoices(await getMako().adoptAccessChoices({ ...legacy }))
    setPref("providerModes", {})
    return
  }
  applyAccessChoices(await getMako().accessChoices())
}

/** Shows the choice at once; the host keeps it for the account and tells every window and device. */
export function chooseAccess(harness: string, mode: string): void {
  accessChoicesStore.set({ modes: { ...accessChoicesStore.get().modes, [harness]: mode } })
  if (!hasBridge()) return
  void getMako().chooseAccess(harness, mode).then(applyAccessChoices, () => {
    // A fixture desk refuses the write, and a host that went away is asked again by the bridge once it's back: this
    // window shows the choice either way, and the host's next word on the choices replaces it.
  })
}
