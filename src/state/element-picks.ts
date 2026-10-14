import { toast } from "sonner"
import { ElementDetailSchema, type ContextInput, type ElementDetail } from "@/lib/context-detail"
import { getMako, hasBridge } from "@/lib/bridge"
import { addContext } from "@/state/composer-context"
import { createHook, createStore } from "@/state/store"
import {
  ELEMENT_PICK_WAIT_MS,
  type ElementPick,
  type ElementPickBrowser,
  type ElementPickState,
  type ElementPickTab,
  type ElementPickTarget,
  type ElementPickTargets,
} from "@mako/host/contracts/element-picks"

/**
 * Picking an element in a web page for the composer. Mako doesn't show web
 * pages itself, so the person points in their own browser tab (Chrome through
 * the Mako Browser extension, a Chromium browser on a debugging port, or an
 * Electron app an agent opened): this asks the host for the tabs it can
 * reach, starts a pick in one, waits for it in slices, and turns what was
 * picked into context chips with `addContext`, one per element.
 */

export type { ElementPickBrowser, ElementPickTab, ElementPickTargets } from "@mako/host/contracts/element-picks"

type Targets =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready"; value: ElementPickTargets }
  | { kind: "error"; message: string }

export interface ActivePick {
  id: string
  /** The tab's title or host, for the line above the composer. */
  place: string
  /** The overlay isn't up yet. */
  starting: boolean
}

interface ElementPicksState {
  targets: Targets
  /** The palette's chooser is open. */
  choosing: boolean
  active?: ActivePick
}

export const elementPicksStore = createStore<ElementPicksState>({ targets: { kind: "idle" }, choosing: false })
export const useElementPicks = createHook(elementPicksStore)

/** A tab's host for a row, or the URL when it has none. */
export function tabHost(url: string): string {
  try {
    return new URL(url).host || url
  } catch {
    return url
  }
}

/** Whether a tab shows an address: same port, and the same host or both on this machine. */
function showsAddress(url: string, address: { host: string; port: number }): boolean {
  try {
    const parsed = new URL(url)
    const local = (host: string) => host === "localhost" || host.endsWith(".localhost") || host === "127.0.0.1" || host === "[::1]"
    return Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80)) === address.port &&
      (parsed.hostname === address.host || (local(parsed.hostname) && local(address.host)))
  } catch {
    return false
  }
}

export interface OrderedTabs {
  /** Tabs showing the Thread's own app. */
  app: ElementPickTab[]
  other: ElementPickTab[]
}

/** The chooser's rows: tabs on the Thread's own app first, then the rest in the browser's order. */
export function orderTabs(tabs: readonly ElementPickTab[], app?: { host: string; port: number }): OrderedTabs {
  const own = app ? tabs.filter((tab) => showsAddress(tab.url, app)) : []
  return { app: own, other: tabs.filter((tab) => !own.includes(tab)) }
}

/** The browsers that can't list tabs now, and why, for the chooser's disabled rows. */
export function unreachableBrowsers(targets: ElementPickTargets): ElementPickBrowser[] {
  return targets.browsers.filter((browser) => browser.kind === "browser" && browser.status !== "connected")
}

function decode(data: string): Uint8Array<ArrayBuffer> {
  const binary = atob(data)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
  return bytes
}

/**
 * One chip per element: each keeps its own crop, selector and source, which
 * is what an agent needs to find each one again. The comment is the
 * person's words about the whole pick, so one element carries it on its
 * chip, and several carry it once, as the words after the last chip, rather
 * than repeating it on every one.
 */
export function pickContexts(pick: ElementPick): ContextInput[] {
  const comment = pick.comment.trim()
  const single = pick.elements.length === 1
  return pick.elements.map((element, index) => {
    const fields: ElementDetail = {
      kind: "element",
      url: pick.url,
      title: pick.title,
      tag: element.tag,
      selector: element.selector,
      html: element.html,
      styles: element.styles,
      box: element.box,
    }
    if (element.role) fields.role = element.role
    if (element.name) fields.name = element.name
    if (element.component) fields.component = element.component
    if (element.source) fields.source = element.source
    if (single && comment) fields.comment = comment
    // The host's wire type mirrors this one; parsing holds the two together.
    const detail = ElementDetailSchema.parse(fields)
    const input: ContextInput = { detail, label: element.label }
    if (element.image) {
      const name = element.label.replace(/[^\w .#-]+/g, "-").slice(0, 40) || element.tag
      input.image = new File([decode(element.image.data)], `${name}.png`, { type: "image/png" })
    }
    if (!single && comment && index === pick.elements.length - 1) input.text = comment
    return input
  })
}

function settle(state: Exclude<ElementPickState, { status: "picking" }>, id: string) {
  if (elementPicksStore.get().active?.id === id) elementPicksStore.set({ active: undefined })
  if (state.status === "cancelled") {
    // Esc in the page, or Cancel here, needs no word back; anything else does.
    if (state.by === "page") toast(state.reason)
    else if (state.by === "mako" && state.reason !== "Cancelled in Mako.") toast.error(state.reason)
    return
  }
  const inputs = pickContexts(state.pick)
  // ⌘↩ in the page sends once the last chip is in.
  const last = inputs.at(-1)
  if (last && state.pick.send) last.send = true
  for (const input of inputs) addContext(input)
  // The person finished in the browser; this window is where the chips are.
  void getMako().surfaceWindow().catch(() => undefined)
  const label = inputs.length === 1 ? inputs[0]!.label : `${inputs.length} elements`
  toast(state.pick.send ? `Sending with ${label}` : `Added ${label}`)
}

async function follow(id: string, first: ElementPickState) {
  let state = first
  while (state.status === "picking") {
    try {
      state = await getMako().waitElementPick(id, ELEMENT_PICK_WAIT_MS)
    } catch (error) {
      state = { status: "cancelled", by: "mako", reason: error instanceof Error ? error.message : "Mako lost the pick." }
    }
  }
  settle(state, id)
}

export const elementPicks = {
  async loadTargets(): Promise<void> {
    if (!hasBridge()) return
    if (elementPicksStore.get().targets.kind !== "ready") elementPicksStore.set({ targets: { kind: "loading" } })
    try {
      elementPicksStore.set({ targets: { kind: "ready", value: await getMako().elementPickTargets() } })
    } catch (error) {
      elementPicksStore.set({ targets: { kind: "error", message: error instanceof Error ? error.message : "Browser tabs couldn’t be listed." } })
    }
  },

  /** Open or close the palette's chooser. */
  choose(open: boolean): void {
    elementPicksStore.set({ choosing: open })
    if (open) void elementPicks.loadTargets()
  },

  /** Turn on browser use for a browser that is set up but not connected, then list again. */
  async connect(browser: string): Promise<void> {
    try {
      await getMako().connectBrowser(browser)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "The browser didn’t connect.")
    }
    await elementPicks.loadTargets()
  },

  /**
   * Start a pick in a tab, or in the tab a conversation's agent is showing.
   * The tab comes forward with the picker in it; the chips arrive when the
   * person adds them there. A pick already running ends first.
   */
  async start(target: ElementPickTarget | { conversation: string }, place: string): Promise<void> {
    const running = elementPicksStore.get().active
    if (running) void getMako().cancelElementPick(running.id).catch(() => undefined)
    const id = crypto.randomUUID()
    elementPicksStore.set({ active: { id, place, starting: true }, choosing: false })
    let state: ElementPickState
    try {
      state = await getMako().startElementPick("conversation" in target ? { id, conversation: target.conversation } : { id, target })
    } catch (error) {
      if (elementPicksStore.get().active?.id === id) elementPicksStore.set({ active: undefined })
      toast.error(error instanceof Error ? error.message : "The pick couldn’t start.")
      return
    }
    if (state.status === "picking" && elementPicksStore.get().active?.id === id)
      elementPicksStore.set({ active: { id, place: state.title || (state.url ? tabHost(state.url) : place), starting: false } })
    await follow(id, state)
  },

  /** End the running pick from Mako; the overlay leaves the page and nothing is added. */
  cancel(): void {
    const active = elementPicksStore.get().active
    if (!active) return
    elementPicksStore.set({ active: undefined })
    void getMako().cancelElementPick(active.id).catch(() => undefined)
  },
}
