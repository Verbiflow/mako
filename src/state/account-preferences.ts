import type { PreferenceValues } from "@mako/host/contracts/preferences"
import { getMako, hasBridge } from "@/lib/bridge"
import { prefsStore, setPref } from "@/state/prefs"
import { applyProjectOrder } from "@/state/project-order"

/**
 * The preferences that follow the person's account (`contracts/preferences.ts`) as this window shows them. The host
 * keeps them for the account; this window applies what it says and hands it the person's changes: the theme, chosen
 * here, is every window's, the web app's and the phone's, and so is the order the rail's projects were dragged to.
 */

/** The theme the host said last: a change to `prefs.theme` that only applies it isn't the person's, and isn't sent. */
let applied: string | undefined
let following = false

export function applyPreferences(values: PreferenceValues): void {
  applyProjectOrder(values["rail.projectOrder"])
  // The account holds no theme: this window keeps its own until the person chooses one somewhere.
  if (values.theme === undefined) return
  applied = values.theme
  if (prefsStore.get().theme !== values.theme) setPref("theme", values.theme)
}

/**
 * Reads the host's preferences, after offering it this window's theme once (edited at an unknown time, so the account
 * keeps any theme the person chose anywhere else over it), and from then on sends the person's changes.
 */
export async function loadPreferences(): Promise<void> {
  if (!hasBridge()) return
  const mako = getMako()
  applyPreferences(await mako.offerPreference("theme", prefsStore.get().theme, 0))
  if (following) return
  following = true
  let theme = prefsStore.get().theme
  prefsStore.subscribe(() => {
    const next = prefsStore.get().theme
    if (next === theme) return
    theme = next
    if (next === applied) return
    applied = next
    void mako.setPreference("theme", next).then(applyPreferences, () => {
      // A fixture desk refuses the write, and a host that went away is asked again by the bridge once it's back: the
      // window shows the choice either way, and the host's next word on the preferences replaces it.
    })
  })
}
