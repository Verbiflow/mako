import { BaseWindow, BrowserWindow, screen } from "electron"
import type { AppshotFeedback, ScreenRect } from "@mako/host/contracts/appshot-shortcut"

/**
 * What a capture looks like while Mako is behind the window it took: a
 * flash over that window, the way the system's own screenshot answers, and
 * a card in the corner of its display that says what was taken and where it
 * went, like the system's floating thumbnail. Neither takes focus: both are
 * shown inactive in non-activating panels, so the app the person is in stays
 * in front and keeps its key window (AGENTS.md, "Nothing fronts the user's
 * application"). A click on the card brings Mako forward; that is the person
 * asking. The card leaves on its own after three seconds, or stays while the
 * pointer rests on it.
 *
 * It isn't a notification: Mako notifies only for an answer, a question and
 * a failure (AGENTS.md, Notifications), and a capture is a receipt of a key
 * the person just pressed, shown where they are looking.
 *
 * It is also where Mako says, once, that another app came to the front right
 * after the press (`hint`, from the shortcut's holder): the moment the person
 * sees both apps react. The hint grows the card by a line with its own ×, and
 * a hint dismissed there isn't shown again for those keys and that app.
 */

const FLASH_OPACITY = 0.32
const FLASH_MS = 240
const CARD = { width: 380, height: 104, inset: 12 }
/** What a hint adds to the card's height: a rule and two short lines. */
const HINT_HEIGHT = 48
/** How long a finished card stays before it leaves, unless the pointer rests on it; longer with a hint to read. */
const RECEIPT_MS = 3_000
const HINT_MS = 8_000
/** A hint that comes before its card (the capture's first word is late) waits this long for one. */
const HINT_WAIT_MS = 4_000
/** A card whose capture never finished is closed anyway. */
const STALE_MS = 30_000
/** The dark theme's `--popover`, `--foreground`, `--muted-foreground` and `--border`, for a card no window could dress (none was open). */
const SHELL_COLORS = {
  surface: "oklch(0.238 0.007 50)",
  text: "oklch(0.93 0.01 60)",
  muted: "oklch(0.722 0.008 58)",
  border: "oklch(0.93 0.008 58 / 14%)",
  font: "-apple-system, system-ui, sans-serif",
}
const OPEN_URL = "mako-hud:open"
const CLOSE_URL = "mako-hud:close"
const DISMISS_URL = "mako-hud:dismiss-hint"

/**
 * The card's page. Colours and font are the desk's own (`AppshotFeedback.colors`); the easings are `--ease-out` and `--ease-swift` from `src/index.css`.
 * Exported for `scripts/test-appshot-card.mjs`, which draws it in a window of its own.
 */
export function cardPage(): string {
  return `<!doctype html><meta charset="utf-8"><style>
html,body{margin:0;height:100%;background:transparent;overflow:hidden;-webkit-user-select:none;cursor:default}
body{font:13px/1.35 var(--font);color:var(--text);display:flex;align-items:flex-end;justify-content:flex-end;padding:${CARD.inset}px;box-sizing:border-box}
.card{display:flex;flex-direction:column;justify-content:center;width:100%;height:100%;box-sizing:border-box;padding:10px 14px 10px 10px;border-radius:12px;background:var(--surface);
  box-shadow:0 0 0 0.5px var(--border),0 12px 28px -8px rgb(0 0 0 / 0.45),0 2px 6px -2px rgb(0 0 0 / 0.3);opacity:0;transform:translateY(8px);
  transition:opacity 200ms cubic-bezier(0.22,1,0.36,1),transform 200ms cubic-bezier(0.22,1,0.36,1)}
.card.in{opacity:1;transform:none}
.card.out{opacity:0;transform:translateY(4px);transition-duration:150ms;transition-timing-function:cubic-bezier(0.2,0,0,1)}
.media{position:relative;flex:none;width:112px;height:70px;border-radius:7px;overflow:hidden;background:var(--border);display:flex;align-items:center;justify-content:center}
.media img.thumb{width:100%;height:100%;object-fit:cover;opacity:0;transition:opacity 180ms cubic-bezier(0.22,1,0.36,1)}
.media img.thumb.in{opacity:1}
.media img.icon{position:absolute;width:28px;height:28px}
.media img.badge{position:absolute;left:5px;bottom:5px;width:18px;height:18px;filter:drop-shadow(0 1px 2px rgb(0 0 0 / 0.4))}
.row{display:flex;gap:12px;align-items:center;min-height:0}
.words{min-width:0;flex:1}
.hint{display:none;align-items:center;gap:6px;margin:8px 0 0 2px;padding-top:7px;border-top:0.5px solid var(--border);color:var(--muted);font-size:12px;line-height:1.3}
.hint.in{display:flex}
.hint span{flex:1;min-width:0}
.hint button{flex:none;appearance:none;border:0;background:transparent;color:var(--muted);font:inherit;font-size:14px;line-height:1;width:20px;height:20px;border-radius:5px;cursor:default}
.hint button:hover{background:var(--border);color:var(--text)}
.title{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.detail{color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:2px}
.detail.wrap{white-space:normal;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
.pulse{animation:pulse 1.1s cubic-bezier(0.2,0,0,1) infinite alternate}
@keyframes pulse{from{opacity:.55}to{opacity:1}}
@media (prefers-reduced-motion: reduce){.card,.card.out,.media img.thumb{transition:none;transform:none}.pulse{animation:none}}
</style>
<div class="card" id="card"><div class="row"><div class="media" id="media"></div><div class="words"><div class="title" id="title"></div><div class="detail" id="detail"></div></div></div><div class="hint" id="hint" role="note"><span id="hint-text"></span><button type="button" id="hint-close" aria-label="Don’t show this again">×</button></div></div>
<script>
const card = document.getElementById("card")
let timer = 0, hovered = false, done = false, hinted = false
function leave(){ card.classList.remove("in"); card.classList.add("out"); setTimeout(() => { location.href = ${JSON.stringify(CLOSE_URL)} }, 170) }
function arm(){ clearTimeout(timer); if (done && !hovered) timer = setTimeout(leave, hinted ? ${HINT_MS} : ${RECEIPT_MS}) }
document.getElementById("hint-close").addEventListener("click", (event) => { event.stopPropagation(); location.href = ${JSON.stringify(DISMISS_URL)} })
window.hint = (text) => {
  hinted = Boolean(text)
  document.getElementById("hint-text").textContent = text || ""
  document.getElementById("hint").classList.toggle("in", hinted)
  arm()
}
card.addEventListener("mouseenter", () => { hovered = true; clearTimeout(timer) })
card.addEventListener("mouseleave", () => { hovered = false; arm() })
card.addEventListener("click", () => { location.href = ${JSON.stringify(OPEN_URL)} })
function image(src, kind){ const img = document.createElement("img"); img.className = kind; img.alt = ""; img.src = src; return img }
window.update = (f) => {
  const root = document.documentElement.style
  if (f.colors) { root.setProperty("--surface", f.colors.surface); root.setProperty("--text", f.colors.text); root.setProperty("--muted", f.colors.muted); root.setProperty("--border", f.colors.border); root.setProperty("--font", f.colors.font) }
  const media = document.getElementById("media")
  media.replaceChildren()
  if (f.thumbnail) { const thumb = image(f.thumbnail, "thumb"); thumb.onload = () => thumb.classList.add("in"); media.append(thumb); if (f.icon) media.append(image(f.icon, "badge")) }
  else if (f.icon) media.append(image(f.icon, "icon"))
  const title = document.getElementById("title"), detail = document.getElementById("detail")
  const name = f.title ? f.app + " — " + f.title : f.app
  if (f.phase === "capturing") { title.textContent = "Taking an Appshot of " + f.app; detail.textContent = f.title || "Reading the window…"; media.classList.add("pulse"); detail.classList.remove("wrap") }
  else if (f.phase === "added") { title.textContent = "Appshot of " + f.app + " added"; detail.textContent = f.destination ? "To “" + f.destination + "”" : "To your draft"; media.classList.remove("pulse"); detail.classList.remove("wrap") }
  else { title.textContent = "Couldn't take an Appshot of " + f.app; detail.textContent = f.message || "Try again."; media.classList.remove("pulse"); detail.classList.add("wrap") }
  done = f.phase !== "capturing"
  requestAnimationFrame(() => card.classList.add("in"))
  arm()
}
</script>`
}

interface Card {
  window: BrowserWindow
  loaded: Promise<void>
  stale: ReturnType<typeof setTimeout>
  /** The hint on it, and what dismissing it does. */
  hint?: () => void
}

export interface CardHint {
  text: string
  /** The person closed the hint: it isn't shown again for these keys and this app. */
  dismiss: () => void
}

export class AppshotFeedbackWindows {
  private readonly cards = new Map<string, Card>()
  private flashing: { window: BaseWindow; timer: ReturnType<typeof setInterval> } | null = null
  /** A hint that came before any card, until a card shows it or it's too old. */
  private waiting: (CardHint & { until: number }) | null = null
  private readonly open: () => void

  /** `open` brings Mako forward: the card was clicked. */
  constructor(open: () => void) {
    this.open = open
  }

  show(feedback: AppshotFeedback): void {
    if (feedback.phase === "capturing" && feedback.bounds) this.flash(feedback.bounds)
    const card = this.cards.get(feedback.id) ?? this.card(feedback)
    void card.loaded.then(() => {
      if (card.window.isDestroyed()) return
      const dressed = { ...feedback, colors: feedback.colors ?? SHELL_COLORS }
      void card.window.webContents.executeJavaScript(`window.update(${JSON.stringify(dressed)})`).catch(() => undefined)
    })
  }

  /** Another app came to the front with the press: say so on the card showing, or the next one in a moment. */
  hint(hint: CardHint): void {
    const entry = [...this.cards.values()].at(-1)
    if (entry) this.showHint(entry, hint)
    else this.waiting = { ...hint, until: Date.now() + HINT_WAIT_MS }
  }

  private showHint(card: Card, hint: CardHint): void {
    this.waiting = null
    const grow = !card.hint
    card.hint = hint.dismiss
    void card.loaded.then(() => {
      if (card.window.isDestroyed()) return
      if (grow) this.resize(card, HINT_HEIGHT)
      void card.window.webContents.executeJavaScript(`window.hint(${JSON.stringify(hint.text)})`).catch(() => undefined)
    })
  }

  private dismissHint(card: Card): void {
    const dismiss = card.hint
    if (!dismiss) return
    card.hint = undefined
    dismiss()
    if (card.window.isDestroyed()) return
    void card.window.webContents.executeJavaScript("window.hint(null)").catch(() => undefined)
    this.resize(card, -HINT_HEIGHT)
  }

  /** Taller or shorter by `by`, keeping its bottom edge where it was. */
  private resize(card: Card, by: number): void {
    const bounds = card.window.getBounds()
    card.window.setBounds({ ...bounds, y: bounds.y - by, height: bounds.height + by })
  }

  /** White over the captured window, fading out: the window was taken, and which. */
  private flash(bounds: ScreenRect): void {
    this.stopFlash()
    const window = new BaseWindow({
      x: Math.round(bounds.x),
      y: Math.round(bounds.y),
      width: Math.max(1, Math.round(bounds.width)),
      height: Math.max(1, Math.round(bounds.height)),
      frame: false,
      transparent: false,
      backgroundColor: "#ffffff",
      opacity: FLASH_OPACITY,
      hasShadow: false,
      resizable: false,
      movable: false,
      focusable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      type: "panel",
      show: false,
    })
    window.setIgnoreMouseEvents(true)
    window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    window.showInactive()
    const started = Date.now()
    const timer = setInterval(() => {
      const left = 1 - (Date.now() - started) / FLASH_MS
      if (left <= 0 || window.isDestroyed()) return this.stopFlash()
      window.setOpacity(FLASH_OPACITY * left * left)
    }, 16)
    this.flashing = { window, timer }
  }

  private stopFlash(): void {
    const flashing = this.flashing
    this.flashing = null
    if (!flashing) return
    clearInterval(flashing.timer)
    if (!flashing.window.isDestroyed()) flashing.window.destroy()
  }

  private card(feedback: AppshotFeedback): Card {
    const display = feedback.bounds ? screen.getDisplayMatching({
      x: Math.round(feedback.bounds.x),
      y: Math.round(feedback.bounds.y),
      width: Math.max(1, Math.round(feedback.bounds.width)),
      height: Math.max(1, Math.round(feedback.bounds.height)),
    }) : screen.getPrimaryDisplay()
    const area = display.workArea
    // One card at a time: a newer capture replaces the older card.
    for (const id of this.cards.keys()) this.close(id)
    const window = new BrowserWindow({
      x: area.x + area.width - CARD.width - 8,
      y: area.y + area.height - CARD.height - 8,
      width: CARD.width,
      height: CARD.height,
      frame: false,
      transparent: true,
      backgroundColor: "#00000000",
      hasShadow: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      focusable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      type: "panel",
      show: false,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
    })
    window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    window.webContents.on("will-navigate", (event, url) => {
      event.preventDefault()
      if (url === OPEN_URL) {
        this.close(feedback.id)
        this.open()
      } else if (url === CLOSE_URL) this.close(feedback.id)
      else if (url === DISMISS_URL) {
        const card = this.cards.get(feedback.id)
        if (card) this.dismissHint(card)
      }
    })
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }))
    const loaded = window
      .loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(cardPage())}`)
      .then(() => {
        if (!window.isDestroyed()) window.showInactive()
      })
      .catch(() => undefined)
    const stale = setTimeout(() => this.close(feedback.id), STALE_MS)
    const card: Card = { window, loaded, stale }
    this.cards.set(feedback.id, card)
    const waiting = this.waiting
    if (waiting && waiting.until > Date.now()) this.showHint(card, waiting)
    this.waiting = null
    window.once("closed", () => {
      clearTimeout(stale)
      if (this.cards.get(feedback.id) === card) this.cards.delete(feedback.id)
    })
    return card
  }

  private close(id: string): void {
    const card = this.cards.get(id)
    if (!card) return
    this.cards.delete(id)
    clearTimeout(card.stale)
    if (!card.window.isDestroyed()) card.window.destroy()
  }

  dispose(): void {
    this.stopFlash()
    for (const id of this.cards.keys()) this.close(id)
  }
}
