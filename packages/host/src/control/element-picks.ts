import { startElementPick, type BrowserService, type ElementPickSession } from "@mako/control-runtime/browser"
import type { MethodTable } from "../base/methods.js"
import { hostWarn } from "../base/host-log.js"
import {
  ELEMENT_PICK_WAIT_MS,
  type ElementPickBrowser,
  type ElementPickRequest,
  type ElementPickState,
  type ElementPickTab,
  type ElementPickTarget,
  type ElementPickTargets,
} from "../contracts/element-picks.js"
import type { ControlPreviews } from "./previews.js"

/** Elements one pick may hold. */
const PICK_LIMIT = 10
/** A finished pick is kept this long, so a wait repeated after a dropped connection still reads it. */
const KEPT_MS = 60_000
/** Pages a person can point at; a browser's own pages and blank tabs aren't. */
const PICKABLE_URL = /^(?:https?|file):/

interface Entry {
  id: string
  owner: string
  state: ElementPickState
  session?: ElementPickSession
  changed: Set<() => void>
  expiry?: NodeJS.Timeout
}

/**
 * The element picks a person runs from the desk. One at a time: there is one
 * pointer, so a new pick ends the one before it. The pick runs in the page
 * (`startElementPick`); this keeps its state by the client's id until the
 * client has read the outcome.
 */
export class ElementPicks {
  private readonly picks = new Map<string, Entry>()
  private readonly browser: BrowserService
  private readonly previews: ControlPreviews
  private readonly platform: "mac" | "other"
  constructor(browser: BrowserService, previews: ControlPreviews, platform: "mac" | "other") {
    this.browser = browser
    this.previews = previews
    this.platform = platform
  }

  /** Every tab a pick could start in, and every browser that could hold one. */
  async targets(): Promise<ElementPickTargets> {
    const statuses = await this.browser.refresh()
    const browsers: ElementPickBrowser[] = []
    const tabs: ElementPickTab[] = []
    for (const status of statuses) {
      // The desk is Mako itself, not a page a person picks in.
      if (status.kind === "desk") continue
      const kind = status.kind === "chromium" ? "browser" : "app"
      const connection = status.connection
      const entry: ElementPickBrowser = {
        id: status.id,
        name: status.product ?? status.name,
        kind,
        status: connection.status === "awaiting-approval" ? "connecting" : connection.status,
      }
      if (status.icon) entry.icon = status.icon
      if (connection.status === "unavailable") entry.reason = connection.reason
      browsers.push(entry)
      if (connection.status !== "connected") continue
      try {
        for (const tab of await this.browser.pageTabs(status.id, AbortSignal.timeout(5_000))) {
          if (!PICKABLE_URL.test(tab.url)) continue
          // An application Mako attached for a task is reached through that task's own tab.
          if (kind === "app" && !tab.held) continue
          tabs.push({ browser: status.id, tab: tab.tab, title: tab.title, url: tab.url, inUse: tab.held })
        }
      } catch (error) {
        entry.status = "unavailable"
        entry.reason = error instanceof Error ? error.message : String(error)
      }
    }
    return { browsers, tabs }
  }

  /** Start a pick and resolve once its overlay is up in the page; a repeated id answers with that pick's state. */
  async start(request: ElementPickRequest): Promise<ElementPickState> {
    const known = this.picks.get(request.id)
    if (known) return known.state
    const target = "target" in request ? request.target : this.conversationTab(request.conversation)
    for (const other of this.picks.values())
      if (other.state.status === "picking") other.session?.cancel("Another pick started.")
    const entry: Entry = {
      id: request.id,
      owner: `mako:element-pick:${request.id}`,
      state: { status: "picking", title: "", url: "" },
      changed: new Set(),
    }
    this.picks.set(request.id, entry)
    try {
      const tab = await this.browser.borrow(entry.owner, target.browser, target.tab, AbortSignal.timeout(15_000))
      const listed = await this.browser.pageTabs(target.browser, AbortSignal.timeout(5_000)).catch(() => [])
      const found = listed.find((page) => page.tab === target.tab)
      entry.session = await startElementPick(tab, { limit: PICK_LIMIT, platform: this.platform })
      entry.state = { status: "picking", title: found?.title ?? "", url: found?.url ?? "" }
      void entry.session.outcome.then((outcome) =>
        this.settle(entry, outcome.status === "picked" ? outcome : { status: "cancelled", by: outcome.by, reason: outcome.reason })
      )
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      hostWarn("browser", "element pick failed to start", { reason })
      this.settle(entry, { status: "cancelled", by: "mako", reason: `Mako couldn’t start the pick: ${reason}` })
    }
    return entry.state
  }

  /** The pick's state once it changes, or after `waitMs` (at most 25 seconds) if it doesn't. */
  async wait(id: string, waitMs: number): Promise<ElementPickState> {
    const entry = this.picks.get(id)
    if (!entry) return { status: "cancelled", by: "mako", reason: "Mako no longer has this pick; start another." }
    if (entry.state.status !== "picking") return entry.state
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer)
        entry.changed.delete(done)
        resolve()
      }
      const timer = setTimeout(done, Math.max(0, Math.min(waitMs, ELEMENT_PICK_WAIT_MS)))
      entry.changed.add(done)
    })
    return entry.state
  }

  /** End a pick from Mako; repeating it changes nothing. */
  cancel(id: string): ElementPickState | null {
    const entry = this.picks.get(id)
    entry?.session?.cancel("Cancelled in Mako.")
    return entry?.state ?? null
  }

  close(): void {
    for (const entry of this.picks.values()) {
      entry.session?.cancel("Mako closed.")
      clearTimeout(entry.expiry)
    }
    this.picks.clear()
  }

  private conversationTab(conversationId: string): ElementPickTarget {
    const target = this.previews.browserTab(conversationId)
    if (!target) throw new Error("This conversation isn’t showing a browser tab.")
    return target
  }

  private settle(entry: Entry, state: ElementPickState) {
    entry.state = state
    for (const wake of entry.changed) wake()
    clearTimeout(entry.expiry)
    entry.expiry = setTimeout(() => {
      if (this.picks.get(entry.id) === entry) this.picks.delete(entry.id)
    }, KEPT_MS)
    entry.expiry.unref()
  }
}

/** Element picks: the tabs, a pick, its wait and its cancel. */
export function declareElementPickMethods(methods: MethodTable, picks: ElementPicks): void {
  methods.handle("mako:element-pick-targets", () => picks.targets())
  methods.handle("mako:element-pick-start", (request: ElementPickRequest) => picks.start(request))
  methods.handle("mako:element-pick-wait", (id: string, waitMs: number) => picks.wait(id, waitMs))
  methods.handle("mako:element-pick-cancel", (id: string) => picks.cancel(id))
}
