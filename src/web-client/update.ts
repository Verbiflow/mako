import { z } from "zod"
import { accountListStore } from "./account-list"
import { busy } from "./busy"
import { typing } from "./keyboard"
import { RETURNED_EVENT } from "./resume"

/**
 * A newer build, taken quietly. The page knows the build it is (`WebClientOptions.build`); the host serves the newest
 * one's name beside the app (`build.json` under its base). Looked at as the page comes back into view, as the list
 * reconnects, and every five minutes; once there's a newer one, the page reloads at the first quiet moment, on the
 * address it's on, with what was typed in the composer carried over, and says "Updated".
 */

/** What the host serves at `<base>build.json`: the build its pages are now. */
const BuildSchema = z.object({ build: z.string().min(1) })
const CHECK_EVERY_MS = 5 * 60_000
/** A moment is quiet once nothing has been touched or typed for this long. */
export const QUIET_AFTER_MS = 8_000
/** How often a waiting update looks for its moment. */
const LOOK_EVERY_MS = 1_000
/** Builds that never take an update: a development server's, and one built outside a checkout. */
const UNVERSIONED = new Set(["dev", "unversioned"])
/** Set across the reload, so the new build says it's here. */
const UPDATED_KEY = "mako:web:updated"
/** The composer's words across the reload, by the address they were typed at. */
const CARRIED_KEY = "mako:web:carried-draft"
const CarriedSchema = z.object({ path: z.string(), text: z.string() })

/** What a reload would interrupt right now. */
export interface Moment {
  /** Since the person last touched, clicked, scrolled or typed, in ms. */
  sinceInput: number
  /** A sheet, menu or dialog is open. */
  sheetOpen: boolean
  /** A field holds the keyboard. */
  typing: boolean
  /** A send, a start, an upload, an archive or a move is under way (`busy.ts`); reads never count. */
  busy: boolean
}

/** Whether a reload now would interrupt nothing the person is doing. */
export function quietMoment(moment: Moment): boolean {
  return moment.sinceInput >= QUIET_AFTER_MS && !moment.sheetOpen && !moment.typing && !moment.busy
}

/** Whether a build the host serves is newer than this page's: any other name, as builds are named by their commit. */
export function newerBuild(own: string | undefined, served: string | undefined): boolean {
  return own !== undefined && !UNVERSIONED.has(own) && served !== undefined && served !== own
}

/**
 * Watches for a newer build than `build` at `<base>build.json` and takes it at a quiet moment. Returns how to stop.
 * A page with no build of its own (a development server's) never looks.
 */
export function takeUpdates(build: string | undefined, base: string): () => void {
  if (!build || UNVERSIONED.has(build)) return () => undefined
  let lastInput = Date.now()
  let waiting: ReturnType<typeof setInterval> | undefined
  let asking = false
  /** Stopped: a look still on its way finds nothing to do (its watcher of input is gone). */
  let stopped = false
  const touched = () => {
    lastInput = Date.now()
  }
  const reloadWhenQuiet = () => {
    const moment: Moment = {
      sinceInput: Date.now() - lastInput,
      sheetOpen: document.querySelector(".web-sheet-layer[data-open], [role=menu], [role=dialog][data-state=open], [role=alertdialog]") !== null,
      typing: typing(),
      busy: busy(),
    }
    if (!quietMoment(moment)) return
    clearInterval(waiting)
    carryDraft()
    try {
      sessionStorage.setItem(UPDATED_KEY, build)
    } catch {
      // Not said after: the update is still taken.
    }
    location.reload()
  }
  const check = async () => {
    if (asking || waiting) return
    asking = true
    try {
      const answer = await fetch(new URL(`${base}build.json`, location.origin), { cache: "no-store" })
      const served = answer.ok ? BuildSchema.safeParse(await answer.json()).data?.build : undefined
      if (newerBuild(build, served) && !waiting && !stopped) waiting = setInterval(reloadWhenQuiet, LOOK_EVERY_MS)
    } catch {
      // Offline, or a host that serves no build's name: looked at again next time.
    } finally {
      asking = false
    }
  }
  const shown = () => {
    if (document.visibilityState === "visible") void check()
  }
  let phase = accountListStore.get().phase
  const unsubscribe = accountListStore.subscribe(() => {
    const now = accountListStore.get().phase
    if (now === "live" && phase !== "live") void check()
    phase = now
  })
  const inputs = ["pointerdown", "keydown", "touchstart", "wheel", "input"] as const
  for (const input of inputs) window.addEventListener(input, touched, { capture: true, passive: true })
  document.addEventListener("visibilitychange", shown)
  window.addEventListener(RETURNED_EVENT, shown)
  const every = setInterval(() => void check(), CHECK_EVERY_MS)
  void check()
  return () => {
    stopped = true
    for (const input of inputs) window.removeEventListener(input, touched, { capture: true })
    document.removeEventListener("visibilitychange", shown)
    window.removeEventListener(RETURNED_EVENT, shown)
    unsubscribe()
    clearInterval(every)
    clearInterval(waiting)
  }
}

/** The composer's field: the one in the open screen's dock. */
function composerField(): HTMLTextAreaElement | null {
  return document.querySelector<HTMLTextAreaElement>(".web-dock textarea")
}

/** What's typed in the composer, kept for the page after the reload, at the address it was typed at. */
function carryDraft(): void {
  const text = composerField()?.value ?? ""
  try {
    if (text.trim()) sessionStorage.setItem(CARRIED_KEY, JSON.stringify({ path: location.pathname + location.search, text }))
  } catch {
    // Nothing kept: a quiet moment with words typed and not sent is rare, as typing holds the update back.
  }
}

/**
 * After an update: whether this page is the newer build arriving (said once), and the composer's words put back once
 * its field is drawn at the address they were typed at, unless it already holds words of its own.
 */
export function arrivedUpdated(): boolean {
  let updated = false
  let carried: z.infer<typeof CarriedSchema> | undefined
  try {
    updated = sessionStorage.getItem(UPDATED_KEY) !== null
    sessionStorage.removeItem(UPDATED_KEY)
    const text = sessionStorage.getItem(CARRIED_KEY)
    sessionStorage.removeItem(CARRIED_KEY)
    carried = text ? CarriedSchema.safeParse(JSON.parse(text)).data : undefined
  } catch {
    // No session storage: nothing was kept to say or put back.
  }
  if (carried && carried.path === location.pathname + location.search) putBack(carried.text)
  return updated
}

/** Puts words back in the composer as if typed, once its field is drawn (within a few seconds). */
function putBack(text: string): void {
  const fill = (): boolean => {
    const field = composerField()
    if (!field) return false
    if (!field.value) {
      // React reads a field's value from its own setter's input event, so it's set as typing sets it.
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(field, text)
      field.dispatchEvent(new Event("input", { bubbles: true }))
    }
    return true
  }
  if (fill()) return
  const watch = new MutationObserver(() => {
    if (fill()) watch.disconnect()
  })
  watch.observe(document.body, { childList: true, subtree: true })
  setTimeout(() => watch.disconnect(), 15_000)
}
