import { z } from "zod"
import type { ExtensionCommand } from "@mako/control-runtime/extension"

const frameSchema = z.object({
  frameTree: z.object({ frame: z.object({ id: z.string() }) }),
})
const worldSchema = z.object({ executionContextId: z.number() })
const pointSchema = z.object({ x: z.number().finite(), y: z.number().finite() })

type CursorAction = {
  x?: number
  y?: number
  pressed?: boolean
  clear?: boolean
}
declare global {
  interface Window {
    makoCursor?: (action: CursorAction) => void
  }
}

/** Runs only in a debugger-created isolated world. No page globals or styles. */
export function installCursor() {
  if (window.makoCursor) return
  const host = document.createElement("div")
  host.setAttribute("aria-hidden", "true")
  host.style.cssText =
    "all:initial!important;position:fixed!important;inset:0!important;pointer-events:none!important;z-index:2147483647!important;contain:strict!important"
  const root = host.attachShadow({ mode: "closed" })
  const style = document.createElement("style")
  style.textContent = `:host{pointer-events:none}div{position:absolute;left:0;top:0;opacity:0;will-change:transform;transition:transform 80ms ease-out,opacity 120ms ease-out;pointer-events:none}svg{display:block;width:24px;height:28px;filter:drop-shadow(0 1px 2px #0005)}span{position:absolute;left:19px;top:19px;padding:3px 6px;border:1px solid #fffaf340;border-radius:5px;background:#302c27;color:#fffaf3;font:500 10px/1 -apple-system,BlinkMacSystemFont,sans-serif;white-space:nowrap}circle{opacity:0}div[data-pressed] circle{opacity:1}@media(prefers-reduced-motion:reduce){div{transition:none}}@media print{div{display:none}}`
  const cursor = document.createElement("div")
  // Static product artwork; never derived from page or agent HTML.
  cursor.innerHTML =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 28"><circle cx="5" cy="5" r="4" fill="none" stroke="#f5efe6" stroke-width="2"/><path d="M4 3v19l5-5 4 8 4-2-4-8h7L4 3Z" fill="#302c27" stroke="#fffaf3" stroke-width="1.5" stroke-linejoin="round"/></svg>'
  const label = document.createElement("span")
  label.textContent = "Mako"
  cursor.append(label)
  root.append(style, cursor)
  document.documentElement.append(host)
  let timer = 0
  const clear = () => {
    window.clearTimeout(timer)
    cursor.style.visibility = "hidden"
    cursor.style.opacity = "0"
  }
  document.addEventListener("visibilitychange", clear)
  window.makoCursor = (action) => {
    if (action.clear || document.visibilityState !== "visible") {
      clear()
      return
    }
    let { x, y } = action
    if (x === undefined || y === undefined) {
      const box = document.activeElement?.getBoundingClientRect()
      if (!box || box.width === 0 || box.height === 0) return
      x = box.x + Math.min(16, box.width / 2)
      y = box.y + Math.min(16, box.height / 2)
    }
    cursor.style.transform = `translate3d(${x}px,${y}px,0)`
    cursor.toggleAttribute("data-pressed", action.pressed === true)
    cursor.style.visibility = "visible"
    cursor.style.opacity = "1"
    window.clearTimeout(timer)
    timer = window.setTimeout(clear, 700)
  }
}

/** Visual acknowledgments never delay input. Hidden tabs send zero cursor CDP calls. */
export class ExtensionCursor {
  private readonly recording = new Set<string>()
  async setRecording(targetId: string, active: boolean) {
    if (active) {
      this.recording.add(targetId)
      await this.clear(targetId)
    } else this.recording.delete(targetId)
  }
  private readonly visible = new Set<number>()
  private refreshVersion = 0
  private readonly worlds = new Map<string, number>()
  private revision = 0
  private readonly revisions = new Map<string, number>()
  private readonly pending = new Map<string, Promise<void>>()
  private readonly queued = new Map<
    string,
    { tabId: number; action: CursorAction; revision: number }
  >()
  constructor(
    private readonly api: Pick<typeof chrome, "tabs" | "windows" | "debugger">
  ) {}
  async refresh() {
    const version = ++this.refreshVersion
    const tabs = await this.api.tabs.query({ active: true })
    const windows = await this.api.windows.getAll()
    const visibleWindows = new Set(
      windows
        .filter((w) => w.focused && w.state !== "minimized")
        .map((w) => w.id)
    )
    if (version !== this.refreshVersion) return
    this.visible.clear()
    for (const tab of tabs)
      if (tab.id !== undefined && visibleWindows.has(tab.windowId))
        this.visible.add(tab.id)
  }
  forget(targetId: string) {
    this.recording.delete(targetId)
    this.worlds.delete(targetId)
    this.queued.delete(targetId)
    this.revisions.delete(targetId)
  }
  action(
    targetId: string,
    tabId: number | undefined,
    method: string,
    params: ExtensionCommand["params"]
  ) {
    if (
      tabId === undefined ||
      !this.visible.has(tabId) ||
      this.recording.has(targetId)
    )
      return
    if (
      ![
        "Input.dispatchMouseEvent",
        "Input.insertText",
        "Input.dispatchKeyEvent",
      ].includes(method)
    )
      return
    const point = pointSchema.safeParse(params)
    const action: CursorAction = point.success
      ? {
          ...point.data,
          pressed:
            params.type === "mousePressed" || params.type === "mouseReleased",
        }
      : {}
    // Coalesce feedback under load, never queue one paint per keystroke.
    const revision = ++this.revision
    this.revisions.set(targetId, revision)
    this.queued.set(targetId, { tabId, action, revision })
    if (this.pending.has(targetId)) return
    const work = this.paint(targetId)
      .catch(() => {
        this.worlds.delete(targetId)
      })
      .finally(() => this.pending.delete(targetId))
    this.pending.set(targetId, work)
  }
  private async paint(targetId: string) {
    while (this.queued.has(targetId)) {
      const next = this.queued.get(targetId)
      this.queued.delete(targetId)
      if (!next || !this.visible.has(next.tabId)) continue
      let contextId = this.worlds.get(targetId)
      if (contextId === undefined) {
        const tree = frameSchema.parse(
          await this.api.debugger.sendCommand({ targetId }, "Page.getFrameTree")
        )
        if (this.revisions.get(targetId) !== next.revision) continue
        contextId = worldSchema.parse(
          await this.api.debugger.sendCommand(
            { targetId },
            "Page.createIsolatedWorld",
            { frameId: tree.frameTree.frame.id, worldName: "Mako cursor" }
          )
        ).executionContextId
        if (this.revisions.get(targetId) !== next.revision) continue
        await this.api.debugger.sendCommand({ targetId }, "Runtime.evaluate", {
          contextId,
          expression: `(${installCursor.toString()})()`,
        })
        if (this.revisions.get(targetId) !== next.revision) continue
        this.worlds.set(targetId, contextId)
      }
      if (this.revisions.get(targetId) !== next.revision) continue
      await this.api.debugger.sendCommand({ targetId }, "Runtime.evaluate", {
        contextId,
        expression: `window.makoCursor?.(${JSON.stringify(next.action)})`,
      })
    }
  }
  async clear(targetId: string) {
    this.queued.delete(targetId)
    this.revisions.delete(targetId)
    const contextId = this.worlds.get(targetId)
    if (contextId !== undefined)
      await this.api.debugger
        .sendCommand({ targetId }, "Runtime.evaluate", {
          contextId,
          expression: "window.makoCursor?.({clear:true})",
        })
        .catch(() => {})
  }
}
