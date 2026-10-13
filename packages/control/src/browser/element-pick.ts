/**
 * The element picker a person uses to point Mako at something in a web page.
 *
 * Everything here is plain data or a function that runs inside the page:
 * `installElementPicker` in an isolated world the host creates over CDP,
 * `installReactProbe` in the page's main world (the only world that can see
 * React's fibers), and `resolveScriptPosition` back in the isolated world,
 * where it fetches a script and its source map with the page's own origin.
 * Each page function is self-contained, because it crosses CDP as its source
 * text (`pageFunctionSource`); none may reach a module binding.
 *
 * The rest runs in Node and is pure: reading a V8 stack, choosing the frame
 * that is the component's own JSX, naming a source file from what a bundler
 * wrote, and the chip's label.
 */

/** How the overlay is told what this pick is. */
export interface ElementPickOptions {
  /** Names this pick's events between the page's two worlds. */
  token: string
  /** At most this many elements in one pick. */
  limit: number
  /** "mac" shows ⌘ for the send chord, anything else Ctrl. */
  platform: "mac" | "other"
  /** The overlay leaves on its own after this long without a word from the host; 45 seconds unless a test says otherwise. */
  abandonMs?: number
}

/** What the main world read of an element's React component. */
export interface ElementReactInfo {
  component?: string
  /** React 19's owner stack for the element (`_debugStack`), when it is a development build. */
  stack?: string
  /** React 18's JSX location (`_debugSource`), when the build kept it. */
  source?: { fileName: string; lineNumber?: number; columnNumber?: number }
}

/** What the isolated world reads of one picked element. */
export interface ElementCapture {
  tag: string
  /** A selector that matched exactly this element at pick time; ` >>> ` crosses an open shadow root. */
  selector: string | null
  html: string
  styles: string
  /** Document coordinates in CSS pixels. */
  box: { x: number; y: number; width: number; height: number }
  id?: string
  /** `tag#id` or `tag.class`, for a label when nothing better names it. */
  hint: string
  /** The words a person reads for it: its label, alt, title or text. */
  text?: string
  /** An iframe, frame, object or embed: the pick stops at it. */
  frame: boolean
  shadow: boolean
  react?: ElementReactInfo
}

/** Where a pick stands, as the host's long poll reads it. */
export type ElementPickProgress =
  | { state: "picking" }
  | { state: "done"; count: number; comment: string; send: boolean }
  | { state: "cancelled" }

/** One frame of a V8 or WebKit stack. */
export interface StackFrame {
  name?: string
  url: string
  line: number
  column: number
}

/** A generated position read back through the script's source map. */
export type ScriptPosition =
  | { kind: "mapped"; source: string; map: string; line: number; column: number }
  | { kind: "unmapped" }
  | { kind: "failed"; reason: string }

/** The isolated world's handle on a running pick. */
export interface ElementPickApi {
  next(waitMs: number): Promise<ElementPickProgress>
  element(index: number): Element | undefined
  describe(index: number): ElementCapture | null
  /** The element's viewport rectangle now, scrolled into view if it left it. */
  frameRect(index: number): { x: number; y: number; width: number; height: number; viewportWidth: number; viewportHeight: number } | null
  busy(text: string): void
  hide(): Promise<void>
  end(): void
}

/** The isolated world's own global, where the pick keeps its handle. */
export interface ElementPickScope {
  __makoElementPick?: ElementPickApi
}

/** What a page function is called with: JSON, as it crosses CDP. */
export type PageArgument = string | number | boolean | null | ElementPickOptions | StackFrame

/**
 * A page function as an expression that calls it. tsx compiles sources with
 * esbuild's keepNames, which wraps nested functions in a `__name` helper the
 * page doesn't have; the shim makes the source text run the same compiled or
 * not.
 */
export function pageFunctionSource(source: string, ...args: PageArgument[]): string {
  return `(() => { const __name = (target) => target; return (${source})(${args.map((arg) => JSON.stringify(arg)).join(", ")}) })()`
}

/**
 * Runs in the page's main world. Answers the isolated world's questions about
 * an element's React fiber through two events named for this pick, and leaves
 * when the pick's end event arrives. Nothing else is added to the page: no
 * global, no DevTools hook, no change to the app.
 */
export function installReactProbe(token: string): void {
  interface NamedType {
    displayName?: string
    name?: string
    render?: NamedType
    type?: NamedType
  }
  interface ReactFiber {
    type?: NamedType | string | null
    return?: ReactFiber | null
    _debugOwner?: (ReactFiber & { name?: string; env?: string }) | null
    _debugStack?: Error | null
    _debugSource?: { fileName?: string; lineNumber?: number; columnNumber?: number } | null
  }
  const ask = `mako-pick-ask-${token}`
  const answer = `mako-pick-answer-${token}`
  const end = `mako-pick-end-${token}`
  const isText = (value: NamedType | string | null | undefined): value is string =>
    Object.prototype.toString.call(value) === "[object String]"
  const valid = (name: string | undefined) =>
    name && /^[A-Za-z_$][\w$.]{1,59}$/.test(name) && !/^(Anonymous|Fragment|Suspense|StrictMode|Profiler)$/.test(name) ? name : undefined
  const nameOf = (type: NamedType | string | null | undefined): string | undefined => {
    if (!type || isText(type)) return undefined
    return valid(type.displayName) ?? valid(type.name) ?? valid(type.render?.displayName) ?? valid(type.render?.name) ?? valid(type.type?.displayName) ?? valid(type.type?.name)
  }
  const fiberOf = (start: Element): ReactFiber | undefined => {
    let node: Element | null = start
    for (let depth = 0; node && depth < 25; depth++, node = node.parentElement) {
      const key = Object.keys(node).find((name) => name.startsWith("__reactFiber$") || name.startsWith("__reactInternalInstance$"))
      if (key) {
        const fiber: ReactFiber | undefined = Object.getOwnPropertyDescriptor(node, key)?.value
        if (fiber) return fiber
      }
    }
    return undefined
  }
  const read = (element: Element, full: boolean): ElementReactInfo => {
    const fiber = fiberOf(element)
    if (!fiber) return {}
    // The owner is the component whose code wrote this element's JSX, which
    // is also where its owner stack points; the nearest component above it in
    // the tree can be a layout that only passed it through.
    const owner = fiber._debugOwner
    let component = owner ? (owner.type !== undefined ? nameOf(owner.type) : valid(owner.name)) : undefined
    for (let node = fiber.return, depth = 0; !component && node && depth < 60; node = node.return, depth++)
      component = nameOf(node.type)
    const info: ElementReactInfo = {}
    if (component) info.component = component
    if (!full) return info
    const stack = fiber._debugStack instanceof Error ? fiber._debugStack.stack : undefined
    if (stack) info.stack = stack.slice(0, 6000)
    const source = fiber._debugSource
    if (source?.fileName) {
      info.source = { fileName: String(source.fileName).slice(0, 1000) }
      if (Number.isInteger(source.lineNumber)) info.source.lineNumber = source.lineNumber
      if (Number.isInteger(source.columnNumber)) info.source.columnNumber = source.columnNumber
    }
    return info
  }
  const onAsk = (event: Event) => {
    const target = event.composedPath()[0]
    if (!(target instanceof Element) || !(event instanceof CustomEvent)) return
    event.stopImmediatePropagation()
    let info: ElementReactInfo = {}
    try {
      info = read(target, event.detail === "full")
    } catch {
      // A page that froze or proxied its nodes answers nothing.
    }
    target.dispatchEvent(new CustomEvent(answer, { detail: JSON.stringify(info), composed: true }))
  }
  const onEnd = () => {
    document.removeEventListener(ask, onAsk, true)
    document.removeEventListener(end, onEnd, true)
  }
  document.addEventListener(ask, onAsk, true)
  document.addEventListener(end, onEnd, true)
}

/**
 * Runs in an isolated world the host made for this pick. Draws the hover
 * outline, the selection and the comment panel in a closed shadow root, keeps
 * every pointer press and click from the page while it runs, and leaves
 * nothing behind when it ends: no node, listener, style or global.
 */
export function installElementPicker(options: ElementPickOptions): void {
  const scope: Window & ElementPickScope = window
  scope.__makoElementPick?.end()

  const ask = `mako-pick-ask-${options.token}`
  const answer = `mako-pick-answer-${options.token}`
  const endProbe = `mako-pick-end-${options.token}`
  const send = options.platform === "mac" ? "⌘" : "Ctrl"

  /* ---------- reading an element ---------- */

  const esc = (value: string) => CSS.escape(value)
  const unstableId = (id: string) =>
    /^[:«]|[:«»]$|\d{4,}|^(radix|headlessui|mui|react-aria|rc|ember|ext-gen)[-:_]?|[0-9a-f]{8,}/i.test(id)
  const unstableClass = (name: string) =>
    /^(css|sc|jsx|emotion|svelte|astro|tw)-[\w-]{4,}$|^_|__[\w-]{5,}$|_[a-zA-Z0-9]{5,}$|^[a-z]{1,3}[A-Z0-9][\w]{4,}$|\d{3,}|[:[\]/@!]/.test(name)
  const TEST_ATTRIBUTES = ["data-testid", "data-test-id", "data-test", "data-cy", "data-qa", "data-pw"]
  const NAME_ATTRIBUTES = ["aria-label", "name", "placeholder", "alt", "title", "role", "type", "href", "for", "aria-labelledby"]
  const quote = (value: string) => `"${value.replace(/["\\]/g, "\\$&")}"`

  const rootOf = (element: Element): Document | ShadowRoot => {
    const root = element.getRootNode()
    return root instanceof ShadowRoot ? root : document
  }
  const matchesOnly = (root: Document | ShadowRoot, selector: string, element: Element) => {
    try {
      const found = root.querySelectorAll(selector)
      return found.length === 1 && found[0] === element
    } catch {
      return false
    }
  }
  /** Ways to name one element, cheapest first: [selector, penalty]. */
  const tokensOf = (element: Element): [string, number][] => {
    const tag = esc(element.localName)
    const tokens: [string, number][] = []
    if (element.id && !unstableId(element.id)) tokens.push([`#${esc(element.id)}`, 0])
    for (const name of TEST_ATTRIBUTES) {
      const value = element.getAttribute(name)
      if (value && value.length <= 80) tokens.push([`[${name}=${quote(value)}]`, 1])
    }
    const classes = [...element.classList].filter((name) => !unstableClass(name)).slice(0, 4)
    for (const name of classes) tokens.push([`${tag}.${esc(name)}`, 2])
    if (classes.length > 1) tokens.push([`${tag}${classes.slice(0, 2).map((name) => `.${esc(name)}`).join("")}`, 3])
    for (const name of NAME_ATTRIBUTES) {
      const value = element.getAttribute(name)
      if (value && value.length <= 80) tokens.push([`${tag}[${name}=${quote(value)}]`, 3])
    }
    tokens.push([tag, 5])
    const parent = element.parentElement
    if (parent) {
      const same = [...parent.children].filter((child) => child.localName === element.localName)
      if (same.length > 1) tokens.push([`${tag}:nth-of-type(${same.indexOf(element) + 1})`, 6])
      tokens.push([`${tag}:nth-child(${[...parent.children].indexOf(element) + 1})`, 7])
    }
    if (element.id && unstableId(element.id)) tokens.push([`#${esc(element.id)}`, 8])
    return tokens
  }
  /** A selector naming exactly `element` in its own root: a fast path, then a short penalty search, then the nth-child path. */
  const selectorIn = (element: Element): string | null => {
    const root = rootOf(element)
    const own = tokensOf(element)
    // The element's own names first, short of its position among siblings.
    for (const [token, penalty] of own) if (penalty <= 5 && matchesOnly(root, token, element)) return token
    const path: Element[] = []
    for (let node: Element | null = element.parentElement; node && path.length < 4; node = node.parentElement) path.push(node)
    let tried = 0
    const candidates: [string, number][] = own.slice(0, 6)
    for (const ancestor of path) {
      const next: [string, number][] = []
      for (const [above, cost] of tokensOf(ancestor).slice(0, 4))
        for (const [below, penalty] of candidates) next.push([`${above} ${below}`, cost + penalty + 1])
      next.sort((a, b) => a[1] - b[1])
      for (const [selector] of next) {
        if (++tried > 240) break
        if (matchesOnly(root, selector, element)) return selector
      }
      candidates.splice(0, candidates.length, ...next.slice(0, 8))
    }
    const steps: string[] = []
    for (let node: Element | null = element; node; node = node.parentElement) {
      if (node.id && !unstableId(node.id) && matchesOnly(root, `#${esc(node.id)}`, node)) {
        steps.unshift(`#${esc(node.id)}`)
        break
      }
      const parent: Element | null = node.parentElement
      steps.unshift(parent ? `${esc(node.localName)}:nth-child(${[...parent.children].indexOf(node) + 1})` : esc(node.localName))
    }
    const selector = steps.join(" > ")
    return matchesOnly(root, selector, element) ? selector : null
  }
  const selectorOf = (element: Element): string | null => {
    const parts: string[] = []
    for (let node: Element | null = element; node; ) {
      const part = selectorIn(node)
      if (!part) return null
      parts.unshift(part)
      const root = node.getRootNode()
      node = root instanceof ShadowRoot ? root.host : null
    }
    return parts.join(" >>> ")
  }

  const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"])
  const clip = (text: string, length: number) => (text.length > length ? `${text.slice(0, length - 1)}…` : text)
  const words = (text: string | null | undefined) => (text ?? "").replace(/\s+/g, " ").trim()
  const openTag = (element: Element, all: boolean) => {
    const names = all ? element.getAttributeNames() : element.getAttributeNames().filter((name) => /^(id|class|role|aria-label|href|src|type|name|alt|title|data-testid|for|value|placeholder)$/.test(name))
    const attributes = names.slice(0, 16).map((name) => {
      const value = element.getAttribute(name) ?? ""
      return value === "" ? name : `${name}=${quote(clip(value, all ? 160 : 60))}`
    })
    if (names.length > 16) attributes.push(`…${names.length - 16} more`)
    return `<${element.localName}${attributes.length ? ` ${attributes.join(" ")}` : ""}>`
  }
  /** The element's tag and attributes, its own text, and one placeholder line per child. */
  const htmlOf = (element: Element) => {
    const lines = [openTag(element, true)]
    let shown = 0
    for (const child of element.childNodes) {
      if (shown >= 24) {
        lines.push(`  <!-- ${element.childNodes.length - shown} more -->`)
        break
      }
      if (child.nodeType === Node.TEXT_NODE) {
        const text = words(child.textContent)
        if (text) {
          lines.push(`  ${clip(text, 200)}`)
          shown++
        }
      } else if (child instanceof Element) {
        const text = words(child.textContent)
        const inner = VOID.has(child.localName) ? "" : child.children.length === 0 && text && text.length <= 60 ? text : child.childNodes.length ? "…" : ""
        lines.push(`  ${openTag(child, false)}${VOID.has(child.localName) ? "" : `${inner}</${child.localName}>`}`)
        shown++
      }
    }
    if (element.shadowRoot) lines.push("  <!-- open shadow root -->")
    if (!VOID.has(element.localName)) lines.push(`</${element.localName}>`)
    let html = lines.join("\n")
    if (html.length > 4096) html = `${html.slice(0, 4094)}\n…`
    return html
  }

  /** Styles read against an element of the same tag in a blank document, so only what the page changed is named. */
  let baselineFrame: HTMLIFrameElement | undefined
  const baselines = new Map<string, Map<string, string>>()
  const baselineOf = (element: Element) => {
    const key = `${element.namespaceURI}|${element.localName}`
    const known = baselines.get(key)
    if (known) return known
    const values = new Map<string, string>()
    const frameDocument = baselineFrame?.contentDocument
    const view = baselineFrame?.contentWindow
    if (frameDocument?.body && view) {
      const blank = frameDocument.createElementNS(element.namespaceURI ?? "http://www.w3.org/1999/xhtml", element.localName)
      frameDocument.body.append(blank)
      const computed = view.getComputedStyle(blank)
      for (const name of computed) values.set(name, computed.getPropertyValue(name))
      blank.remove()
    }
    baselines.set(key, values)
    return values
  }
  const FIRST = ["display", "position", "top", "right", "bottom", "left", "z-index", "flex-direction", "flex-wrap", "justify-content", "align-items", "align-self", "flex-grow", "flex-shrink", "flex-basis", "gap", "row-gap", "column-gap", "grid-template-columns", "grid-template-rows", "grid-column", "grid-row", "margin", "padding", "border-width", "border-style", "border-color", "border-radius", "background-color", "background-image", "color", "font-family", "font-size", "font-weight", "line-height", "letter-spacing", "text-align", "text-transform", "text-decoration-line", "white-space", "overflow-x", "overflow-y", "opacity", "box-shadow", "transform", "cursor", "visibility"]
  const SIDES = ["top", "right", "bottom", "left"]
  const CORNERS = ["top-left", "top-right", "bottom-right", "bottom-left"]
  const NOISE = /^-webkit-|(^|-)(inline|block)(-|$)|^border-(start|end)-(start|end)-radius$|^inset|^(width|height|transform-origin|perspective-origin|d|cx|cy|r|rx|ry|x|y|caret-color|transition-.+|animation-.+|will-change)$/
  const stylesOf = (element: Element) => {
    const computed = getComputedStyle(element)
    const baseline = baselineOf(element)
    const color = computed.getPropertyValue("color")
    const changed = new Map<string, string>()
    for (const name of computed) {
      if (NOISE.test(name)) continue
      const value = computed.getPropertyValue(name)
      if (value === baseline.get(name)) continue
      // currentcolor follows `color`, which is already named.
      if (name !== "color" && name.endsWith("-color") && value === color && name !== "background-color") continue
      changed.set(name, value)
    }
    const fold = (group: string, names: string[]) => {
      if (!names.some((name) => changed.has(name))) return
      const values = names.map((name) => computed.getPropertyValue(name))
      for (const name of names) changed.delete(name)
      const [a, b, c, d] = values
      changed.set(group, a === b && b === c && c === d ? a! : b === d ? (a === c ? `${a} ${b}` : `${a} ${b} ${c}`) : values.join(" "))
    }
    fold("margin", SIDES.map((side) => `margin-${side}`))
    fold("padding", SIDES.map((side) => `padding-${side}`))
    fold("border-width", SIDES.map((side) => `border-${side}-width`))
    fold("border-style", SIDES.map((side) => `border-${side}-style`))
    fold("border-color", SIDES.map((side) => `border-${side}-color`))
    fold("border-radius", CORNERS.map((corner) => `border-${corner}-radius`))
    const ordered = [...FIRST.filter((name) => changed.has(name)), ...[...changed.keys()].filter((name) => !FIRST.includes(name)).sort()]
    const lines: string[] = []
    let length = 0
    for (const name of ordered) {
      const line = `${name}: ${clip(changed.get(name)!, 300)}`
      if (length + line.length + 1 > 4096) break
      lines.push(line)
      length += line.length + 1
    }
    return lines.join("\n")
  }

  /** The main world's word on an element's component; nothing when the page has no React. */
  const reactOf = (element: Element, full: boolean): ElementReactInfo | undefined => {
    let reply: string | undefined
    const listen = (event: Event) => {
      if (event instanceof CustomEvent) reply = String(event.detail)
    }
    document.addEventListener(answer, listen, true)
    try {
      element.dispatchEvent(new CustomEvent(ask, { detail: full ? "full" : "name", composed: true }))
    } finally {
      document.removeEventListener(answer, listen, true)
    }
    if (!reply) return undefined
    try {
      const parsed: ElementReactInfo = JSON.parse(reply)
      return parsed
    } catch {
      return undefined
    }
  }
  const componentNames = new WeakMap<Element, string | null>()
  const componentOf = (element: Element) => {
    if (!componentNames.has(element)) componentNames.set(element, reactOf(element, false)?.component ?? null)
    return componentNames.get(element) ?? undefined
  }
  const isFrame = (element: Element) => /^(iframe|frame|object|embed)$/.test(element.localName)
  const hintOf = (element: Element) => {
    const tag = element.localName
    if (element.id && !unstableId(element.id)) return `${tag}#${element.id}`
    const name = [...element.classList].find((value) => !unstableClass(value))
    return name ? `${tag}.${name}` : tag
  }
  const describe = (element: Element): ElementCapture => {
    const rect = element.getBoundingClientRect()
    const round = (value: number) => Math.round(value * 10) / 10
    const capture: ElementCapture = {
      tag: element.localName,
      selector: selectorOf(element),
      html: htmlOf(element),
      styles: stylesOf(element),
      box: { x: round(rect.x + scrollX), y: round(rect.y + scrollY), width: round(rect.width), height: round(rect.height) },
      hint: hintOf(element),
      frame: isFrame(element),
      shadow: element.getRootNode() instanceof ShadowRoot,
    }
    if (element.id) capture.id = element.id
    const text = words(element.getAttribute("aria-label") ?? element.getAttribute("alt") ?? element.getAttribute("title") ?? (element instanceof HTMLElement ? element.innerText : element.textContent))
    if (text) capture.text = clip(text, 120)
    const react = reactOf(element, true)
    if (react && (react.component || react.stack || react.source)) capture.react = react
    return capture
  }

  /* ---------- the overlay ---------- */

  const host = document.createElement("div")
  host.setAttribute("aria-hidden", "true")
  host.setAttribute("data-mako-pick", "")
  host.style.cssText = "all:initial!important;position:fixed!important;inset:0!important;pointer-events:none!important;z-index:2147483647!important;display:block!important"
  const root = host.attachShadow({ mode: "closed" })
  const style = document.createElement("style")
  // Mako's dark ramp, as literals: the page has none of the desk's tokens.
  style.textContent = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .layer { position: fixed; inset: 0; pointer-events: none; font: 440 12px/16px -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; color: oklch(0.93 0.01 60); -webkit-font-smoothing: antialiased; }
    .box { position: fixed; left: 0; top: 0; border-radius: 3px; pointer-events: none; box-shadow: 0 0 0 1px oklch(0.93 0.01 60 / 95%), 0 0 0 2px oklch(0.175 0.009 50 / 70%); background: oklch(0.93 0.01 60 / 7%); transition: transform 70ms cubic-bezier(0.22, 1, 0.36, 1), width 70ms cubic-bezier(0.22, 1, 0.36, 1), height 70ms cubic-bezier(0.22, 1, 0.36, 1); }
    .shield { position: fixed; left: 0; top: 0; pointer-events: auto; background: transparent; }
    .box[hidden], .tag[hidden], .panel[hidden], .hint[hidden] { display: none; }
    .box.chosen { box-shadow: 0 0 0 2px oklch(0.93 0.01 60), 0 0 0 3.5px oklch(0.175 0.009 50 / 80%); background: oklch(0.93 0.01 60 / 11%); transition: none; }
    .index { position: absolute; left: -2px; top: -2px; transform: translate(-50%, -50%); min-width: 18px; height: 18px; padding: 0 5px; border-radius: 9px; background: oklch(0.238 0.007 50); color: oklch(0.93 0.01 60); box-shadow: 0 0 0 1.5px oklch(0.93 0.01 60 / 90%); font-weight: 640; font-size: 12px; line-height: 18px; text-align: center; font-variant-numeric: tabular-nums; }
    .tag { position: fixed; left: 0; top: 0; display: flex; gap: 6px; align-items: baseline; max-width: min(420px, calc(100vw - 16px)); padding: 3px 7px; border-radius: 5px; background: oklch(0.238 0.007 50); box-shadow: 0 0 0 1px oklch(0.93 0.008 58 / 14%), 0 4px 14px oklch(0 0 0 / 28%); white-space: nowrap; pointer-events: none; }
    .tag b { font-weight: 530; overflow: hidden; text-overflow: ellipsis; }
    .tag span { color: oklch(0.722 0.008 58); overflow: hidden; text-overflow: ellipsis; }
    .tag .size { color: oklch(0.61 0.007 55); font-variant-numeric: tabular-nums; flex-shrink: 0; }
    .hint { position: fixed; top: 12px; left: 50%; transform: translateX(-50%); display: flex; align-items: center; gap: 8px; padding: 6px 12px; border-radius: 999px; background: oklch(0.238 0.007 50); box-shadow: 0 0 0 1px oklch(0.93 0.008 58 / 14%), 0 6px 20px oklch(0 0 0 / 30%); color: oklch(0.722 0.008 58); white-space: nowrap; pointer-events: none; animation: arrive 180ms cubic-bezier(0.22, 1, 0.36, 1); }
    .hint i { width: 6px; height: 6px; border-radius: 3px; background: oklch(0.682 0.14 41); }
    .hint b { color: oklch(0.93 0.01 60); font-weight: 530; }
    .panel.aside { opacity: 0.3; pointer-events: none; transition: opacity 120ms cubic-bezier(0.2, 0, 0, 1); }
    .panel { position: fixed; left: 0; top: 0; width: 340px; max-width: calc(100vw - 24px); padding: 10px; border-radius: 10px; background: oklch(0.238 0.007 50); box-shadow: 0 0 0 1px oklch(0.93 0.008 58 / 14%), 0 12px 32px oklch(0 0 0 / 36%); pointer-events: auto; animation: arrive 160ms cubic-bezier(0.22, 1, 0.36, 1); }
    .head { display: flex; align-items: baseline; gap: 8px; padding: 0 2px 8px; }
    .head b { font-weight: 530; font-size: 14px; line-height: 20px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .head span { color: oklch(0.61 0.007 55); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .head .more { margin-left: auto; flex-shrink: 0; }
    input { all: unset; box-sizing: border-box; display: block; width: 100%; height: 34px; padding: 0 10px; border-radius: 7px; background: oklch(0.175 0.009 50); box-shadow: inset 0 0 0 1px oklch(0.93 0.008 58 / 14%); font: 440 14px/20px -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; color: oklch(0.93 0.01 60); caret-color: oklch(0.682 0.14 41); }
    input::placeholder { color: oklch(0.61 0.007 55); }
    input:focus { box-shadow: inset 0 0 0 1px oklch(0.93 0.008 58 / 30%); }
    .note { margin: 8px 2px 0; color: oklch(0.722 0.008 58); }
    .foot { display: flex; align-items: center; gap: 6px; margin-top: 10px; }
    .foot .keys { flex: 1; color: oklch(0.61 0.007 55); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; padding-left: 2px; }
    kbd { font: inherit; color: oklch(0.722 0.008 58); }
    button { all: unset; box-sizing: border-box; height: 26px; padding: 0 10px; border-radius: 6px; font: 530 12px/26px -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; color: oklch(0.93 0.01 60); cursor: default; white-space: nowrap; transition: background-color 120ms cubic-bezier(0.22, 1, 0.36, 1); }
    button:hover { background: oklch(0.93 0.01 60 / 7%); }
    button:focus-visible { outline: 1px solid oklch(0.93 0.01 60 / 50%); outline-offset: 1px; }
    button.primary { background: oklch(0.93 0.01 60); color: oklch(0.175 0.009 50); }
    button.primary:hover { background: oklch(0.86 0.01 60); }
    button:disabled { opacity: 0.5; }
    @keyframes arrive { from { opacity: 0; transform: translateY(4px); } }
    .hint { animation-name: arrive-hint; }
    @keyframes arrive-hint { from { opacity: 0; transform: translate(-50%, -4px); } }
    @media (prefers-reduced-motion: reduce) { .box, .panel, .hint, button { transition: none; animation: none; } }
    @media print { .layer { display: none; } }
  `
  const layer = document.createElement("div")
  layer.className = "layer"
  const hover = document.createElement("div")
  hover.className = "box"
  hover.hidden = true
  const tag = document.createElement("div")
  tag.className = "tag"
  tag.hidden = true
  const hint = document.createElement("div")
  hint.className = "hint"
  hint.append(document.createElement("i"))
  const hintText = document.createElement("span")
  const hintStrong = document.createElement("b")
  hintStrong.textContent = "Click an element to point Mako at it"
  hintText.append(hintStrong, " · Shift-click adds more · Esc cancels")
  hint.append(hintText)
  const panel = document.createElement("div")
  panel.className = "panel"
  panel.hidden = true
  const head = document.createElement("div")
  head.className = "head"
  const title = document.createElement("b")
  const detail = document.createElement("span")
  const more = document.createElement("span")
  more.className = "more"
  head.append(title, detail, more)
  const input = document.createElement("input")
  input.type = "text"
  input.placeholder = "What should change?"
  input.setAttribute("aria-label", "What should change?")
  input.spellcheck = true
  const note = document.createElement("p")
  note.className = "note"
  note.hidden = true
  const foot = document.createElement("div")
  foot.className = "foot"
  const keys = document.createElement("span")
  keys.className = "keys"
  const sendKey = document.createElement("kbd")
  sendKey.textContent = `${send}↩`
  keys.append(sendKey, " adds and sends")
  const cancelButton = document.createElement("button")
  cancelButton.type = "button"
  cancelButton.textContent = "Cancel"
  const addButton = document.createElement("button")
  addButton.type = "button"
  addButton.className = "primary"
  addButton.textContent = "Add to Mako ↩"
  foot.append(keys, cancelButton, addButton)
  panel.append(head, input, note, foot)
  // The baseline document for computed styles lives in the closed root, where the page can't reach it.
  baselineFrame = document.createElement("iframe")
  baselineFrame.setAttribute("tabindex", "-1")
  baselineFrame.style.cssText = "position:fixed;width:0;height:0;border:0;visibility:hidden;pointer-events:none"
  layer.append(hover, tag, hint, panel)
  root.append(style, layer, baselineFrame)
  document.documentElement.append(host)

  /* ---------- state ---------- */

  let phase: "picking" | "done" | "cancelled" = "picking"
  let pointer: { x: number; y: number } | undefined
  let frame = 0
  let comment = ""
  let sendChosen = false
  const chosen: { element: Element; box: HTMLDivElement }[] = []
  const waiters = new Set<(progress: ElementPickProgress) => void>()
  const progress = (): ElementPickProgress =>
    phase === "done" ? { state: "done", count: chosen.length, comment, send: sendChosen }
      : phase === "cancelled" ? { state: "cancelled" }
        : { state: "picking" }
  const settle = () => {
    for (const waiter of waiters) waiter(progress())
    waiters.clear()
  }

  const elementAt = (x: number, y: number): Element | undefined => {
    let element = document.elementsFromPoint(x, y).find((candidate) => candidate !== host && candidate !== document.documentElement)
    // Open shadow roots are pierced; a closed one is picked as its host.
    for (let depth = 0; element?.shadowRoot && depth < 8; depth++) {
      const inner: Element | undefined = element.shadowRoot.elementsFromPoint(x, y).find((candidate) => candidate !== element && element!.shadowRoot!.contains(candidate))
      if (!inner) break
      element = inner
    }
    return element
  }
  const place = (box: HTMLElement, rect: DOMRect) => {
    box.style.transform = `translate(${Math.round(rect.x)}px, ${Math.round(rect.y)}px)`
    box.style.width = `${Math.max(1, Math.round(rect.width))}px`
    box.style.height = `${Math.max(1, Math.round(rect.height))}px`
  }
  const label = (element: Element) => {
    const component = componentOf(element)
    const rect = element.getBoundingClientRect()
    tag.replaceChildren()
    if (component) {
      const name = document.createElement("b")
      name.textContent = component
      tag.append(name)
    }
    const kind = document.createElement("span")
    kind.textContent = isFrame(element) ? `${hintOf(element)} · frame` : hintOf(element)
    const size = document.createElement("span")
    size.className = "size"
    size.textContent = `${Math.round(rect.width)}×${Math.round(rect.height)}`
    tag.append(kind, size)
    tag.hidden = false
    const above = rect.y - 26
    const top = above >= 4 ? above : Math.min(innerHeight - 26, rect.bottom + 6)
    tag.style.transform = `translate(${Math.round(Math.min(Math.max(4, rect.x), innerWidth - tag.offsetWidth - 4))}px, ${Math.round(Math.max(4, top))}px)`
  }
  const paintHover = () => {
    frame = 0
    if (phase !== "picking" || !pointer) return
    const element = elementAt(pointer.x, pointer.y)
    if (!element) {
      hover.hidden = true
      tag.hidden = true
      return
    }
    // A chosen element already wears its own outline.
    hover.hidden = chosen.some((entry) => entry.element === element)
    place(hover, element.getBoundingClientRect())
    label(element)
  }
  const paintChosen = () => {
    chosen.forEach(({ element, box }, index) => {
      place(box, element.getBoundingClientRect())
      const badge = box.firstElementChild
      if (badge instanceof HTMLElement) {
        badge.hidden = chosen.length < 2
        badge.textContent = String(index + 1)
      }
    })
  }
  const placePanel = () => {
    if (panel.hidden || !chosen.length) return
    const anchor = chosen[chosen.length - 1]!.element.getBoundingClientRect()
    const width = panel.offsetWidth
    const height = panel.offsetHeight
    const below = anchor.bottom + 10
    const top = below + height <= innerHeight - 12 ? below : anchor.top - height - 10 >= 12 ? anchor.top - height - 10 : innerHeight - height - 12
    const left = Math.min(Math.max(12, anchor.left), innerWidth - width - 12)
    panel.style.transform = `translate(${Math.round(left)}px, ${Math.round(Math.max(12, top))}px)`
  }
  // Pointer events over an embedded frame go to the frame's own document,
  // which the pick can't hear, so each frame wears a transparent shield of
  // the pick's own that takes its hover and click.
  const shields = new Map<Element, HTMLDivElement>()
  const paintShields = () => {
    const frames = new Set([...document.querySelectorAll("iframe, frame, object, embed")].slice(0, 64))
    for (const [element, shield] of shields)
      if (!frames.has(element) || !element.isConnected) {
        shield.remove()
        shields.delete(element)
      }
    for (const element of frames) {
      let shield = shields.get(element)
      if (!shield) {
        const made = document.createElement("div")
        made.className = "shield"
        made.addEventListener("pointermove", (event) => {
          pointer = { x: event.clientX, y: event.clientY }
          if (!frame) frame = requestAnimationFrame(paintHover)
        })
        made.addEventListener("click", (event) => {
          if (phase === "picking" && event.button === 0) choose(element, event.shiftKey)
        })
        layer.insertBefore(made, layer.firstChild)
        shields.set(element, made)
        shield = made
      }
      place(shield, element.getBoundingClientRect())
    }
  }
  const repaint = () => {
    if (pointer && !frame) frame = requestAnimationFrame(paintHover)
    paintShields()
    paintChosen()
    placePanel()
  }
  const summarize = () => {
    const first = chosen[0]?.element
    if (!first) return
    if (chosen.length === 1) {
      title.textContent = componentOf(first) ?? hintOf(first)
      detail.textContent = componentOf(first) ? hintOf(first) : ""
    } else {
      title.textContent = `${chosen.length} elements`
      detail.textContent = ""
    }
    more.textContent = chosen.length >= options.limit ? `Limit is ${options.limit} elements` : "Shift-click adds more"
    const frames = chosen.some(({ element }) => isFrame(element))
    note.hidden = !frames
    note.textContent = "An embedded frame is picked whole; Mako can’t reach inside another page’s frame."
  }
  const choose = (element: Element, adding: boolean) => {
    const at = chosen.findIndex((entry) => entry.element === element)
    if (adding && at >= 0) {
      chosen[at]!.box.remove()
      chosen.splice(at, 1)
    } else {
      if (!adding) {
        for (const entry of chosen) entry.box.remove()
        chosen.length = 0
      }
      if (at < 0 || !adding) {
        if (chosen.length >= options.limit) return
        const box = document.createElement("div")
        box.className = "box chosen"
        const badge = document.createElement("span")
        badge.className = "index"
        box.append(badge)
        layer.insertBefore(box, hover)
        chosen.push({ element, box })
      }
    }
    hint.hidden = chosen.length > 0
    panel.hidden = chosen.length === 0
    summarize()
    paintChosen()
    placePanel()
    if (chosen.length) input.focus({ preventScroll: true })
  }
  const finish = (sending: boolean) => {
    if (phase !== "picking" || !chosen.length) return
    comment = input.value.trim().slice(0, 4000)
    sendChosen = sending
    phase = "done"
    hover.hidden = true
    tag.hidden = true
    busy("Adding to Mako…")
    settle()
  }
  const cancel = () => {
    if (phase === "done" || phase === "cancelled") return
    phase = "cancelled"
    settle()
    end()
  }
  const busy = (text: string) => {
    input.disabled = true
    addButton.disabled = true
    cancelButton.disabled = true
    addButton.textContent = text
  }

  /* ---------- events ---------- */

  const listeners: [EventTarget, string, EventListener, AddEventListenerOptions][] = []
  const on = (target: EventTarget, type: string, listener: EventListener, listenOptions: AddEventListenerOptions) => {
    target.addEventListener(type, listener, listenOptions)
    listeners.push([target, type, listener, listenOptions])
  }
  const ours = (event: Event) => event.target === host
  // Until the pick ends, a press or click anywhere outside the panel is the pick's, never the page's.
  const swallow = (event: Event) => {
    if (ours(event)) return
    event.preventDefault()
    event.stopImmediatePropagation()
  }
  for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "dblclick", "auxclick", "contextmenu", "touchstart", "touchend", "dragstart", "selectstart"])
    on(window, type, swallow, { capture: true })
  on(window, "click", (event) => {
    if (ours(event)) return
    event.preventDefault()
    event.stopImmediatePropagation()
    if (phase !== "picking" || !(event instanceof MouseEvent) || event.button !== 0) return
    const element = elementAt(event.clientX, event.clientY)
    if (element) choose(element, event.shiftKey)
  }, { capture: true })
  // Holding Shift is adding: the panel steps aside so what lies under it can be picked too.
  const aside = (adding: boolean) => {
    panel.classList.toggle("aside", adding && chosen.length > 0 && chosen.length < options.limit)
  }
  on(window, "keyup", (event) => {
    if (event instanceof KeyboardEvent && event.key === "Shift") aside(false)
  }, { capture: true })
  on(window, "pointermove", (event) => {
    if (!(event instanceof PointerEvent)) return
    aside(event.shiftKey)
    if (ours(event)) {
      pointer = undefined
      hover.hidden = true
      tag.hidden = true
      return
    }
    pointer = { x: event.clientX, y: event.clientY }
    if (!frame) frame = requestAnimationFrame(paintHover)
  }, { capture: true, passive: true })
  const leave = () => {
    pointer = undefined
    hover.hidden = true
    tag.hidden = true
  }
  on(window, "pointerout", (event) => {
    if (event instanceof PointerEvent && event.relatedTarget === null) leave()
  }, { capture: true, passive: true })
  on(window, "blur", leave, {})
  on(window, "keydown", (event) => {
    if (!(event instanceof KeyboardEvent)) return
    if (event.key === "Escape") {
      event.preventDefault()
      event.stopImmediatePropagation()
      cancel()
      return
    }
    if (event.key === "Shift") aside(true)
    if (!ours(event)) {
      // With something chosen, Return adds it wherever the focus went.
      if (event.key === "Enter" && chosen.length && phase === "picking" && !event.isComposing) {
        event.preventDefault()
        event.stopImmediatePropagation()
        finish(event.metaKey || event.ctrlKey)
      }
      return
    }
    // The panel's keys are Mako's: a page shortcut must not fire while the person types here.
    event.stopImmediatePropagation()
    if (event.key === "Enter" && !event.isComposing && !event.shiftKey) {
      event.preventDefault()
      finish(event.metaKey || event.ctrlKey)
    }
  }, { capture: true })
  for (const type of ["keyup", "keypress", "beforeinput", "input", "paste", "copy", "cut", "compositionstart", "compositionend", "focusin", "focusout"])
    on(window, type, (event) => {
      if (ours(event)) event.stopImmediatePropagation()
    }, { capture: true })
  on(window, "scroll", repaint, { capture: true, passive: true })
  on(window, "resize", repaint, { passive: true })
  on(addButton, "click", () => finish(false), {})
  on(panel, "mousedown", (event) => {
    if (event.target !== input && !(event.target instanceof HTMLButtonElement)) event.preventDefault()
  }, {})
  paintShields()
  on(cancelButton, "click", () => cancel(), {})

  /* ---------- the host's handle ---------- */

  // The host polls every 20 seconds while it waits. A host that stopped
  // (quit, crashed, lost its connection) can't end the pick, and a page
  // whose clicks the overlay keeps would be broken until reloaded, so the
  // overlay leaves on its own once nobody has asked after it for a while.
  let seen = Date.now()
  const abandonMs = options.abandonMs ?? 45_000
  const watchdog = setInterval(() => {
    if (Date.now() - seen > abandonMs) end()
  }, Math.min(5_000, abandonMs / 2))
  const end = () => {
    if (phase === "picking") phase = "cancelled"
    settle()
    clearInterval(watchdog)
    if (frame) cancelAnimationFrame(frame)
    for (const [target, type, listener, listenOptions] of listeners) target.removeEventListener(type, listener, listenOptions)
    listeners.length = 0
    host.remove()
    baselineFrame = undefined
    document.dispatchEvent(new CustomEvent(endProbe))
    if (scope.__makoElementPick === api) delete scope.__makoElementPick
  }
  const api: ElementPickApi = {
    next(waitMs) {
      seen = Date.now()
      if (phase !== "picking") return Promise.resolve(progress())
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          waiters.delete(resolve)
          resolve(progress())
        }, Math.max(0, Math.min(waitMs, 25_000)))
        waiters.add((value) => {
          clearTimeout(timer)
          resolve(value)
        })
      })
    },
    element: (index) => chosen[index]?.element,
    describe(index) {
      seen = Date.now()
      const element = chosen[index]?.element
      return element?.isConnected ? describe(element) : null
    },
    frameRect(index) {
      seen = Date.now()
      const element = chosen[index]?.element
      if (!element?.isConnected) return null
      let rect = element.getBoundingClientRect()
      if (rect.bottom <= 0 || rect.right <= 0 || rect.top >= innerHeight || rect.left >= innerWidth) {
        element.scrollIntoView({ block: "center", inline: "center", behavior: "instant" })
        rect = element.getBoundingClientRect()
      }
      // The visual viewport leaves out the scrollbars, as the host's screenshot geometry does.
      const view = window.visualViewport
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, viewportWidth: view?.width ?? document.documentElement.clientWidth, viewportHeight: view?.height ?? document.documentElement.clientHeight }
    },
    busy,
    hide() {
      layer.style.display = "none"
      return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
    },
    end,
  }
  scope.__makoElementPick = api
}

/**
 * Runs in the isolated world. Reads one generated position back through the
 * script's source map, fetched with the page's origin so a dev server behind
 * a login answers as it does for the page. Bounded by `budgetMs`; a script
 * that names no map is `unmapped`, anything that goes wrong is `failed`.
 */
export async function resolveScriptPosition(frame: StackFrame, budgetMs: number): Promise<ScriptPosition> {
  const signal = AbortSignal.timeout(Math.max(1, budgetMs))
  const LIMIT = 24 * 1024 * 1024
  const text = async (url: string) => {
    const response = await fetch(url, { signal, credentials: "same-origin", cache: "force-cache" })
    if (!response.ok) throw new Error(`${url} answered ${response.status}`)
    const length = Number(response.headers.get("content-length") ?? 0)
    if (length > LIMIT) throw new Error(`${url} is larger than the source map budget`)
    const body = await response.text()
    if (body.length > LIMIT) throw new Error(`${url} is larger than the source map budget`)
    return { body, header: response.headers.get("sourcemap") ?? response.headers.get("x-sourcemap") }
  }
  interface IndexSection { offset: { line: number; column: number }; map?: SourceMapDocument }
  interface SourceMapDocument { sources?: (string | null)[]; sourceRoot?: string; mappings?: string; sections?: IndexSection[] }
  const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
  const decodeSegment = (segment: string): number[] => {
    const values: number[] = []
    let value = 0
    let shift = 0
    for (const character of segment) {
      const digit = BASE64.indexOf(character)
      if (digit < 0) throw new Error("The source map's mappings are malformed")
      value += (digit & 31) << shift
      if (digit & 32) shift += 5
      else {
        values.push(value & 1 ? -(value >>> 1) : value >>> 1)
        value = 0
        shift = 0
      }
    }
    return values
  }
  /** `line` and `column` are zero-based in the generated file. */
  const lookup = (map: SourceMapDocument, line: number, column: number): { source: string; line: number; column: number } | null => {
    if (map.sections) {
      const section = map.sections.filter((entry) => entry.offset.line < line || (entry.offset.line === line && entry.offset.column <= column)).at(-1)
      if (!section?.map) return null
      return lookup(section.map, line - section.offset.line, line === section.offset.line ? column - section.offset.column : column)
    }
    const lines = (map.mappings ?? "").split(";")
    if (line >= lines.length) return null
    let source = 0
    let originalLine = 0
    let originalColumn = 0
    let best: { source: number; line: number; column: number } | null = null
    for (let index = 0; index <= line; index++) {
      let generated = 0
      for (const segment of lines[index]!.split(",")) {
        if (!segment) continue
        const fields = decodeSegment(segment)
        generated += fields[0] ?? 0
        if (fields.length < 4) continue
        source += fields[1]!
        originalLine += fields[2]!
        originalColumn += fields[3]!
        if (index === line && generated <= column) best = { source, line: originalLine, column: originalColumn }
      }
    }
    const name = best ? map.sources?.[best.source] : undefined
    if (!best || !name) return null
    const root = map.sourceRoot ? (map.sourceRoot.endsWith("/") ? map.sourceRoot : `${map.sourceRoot}/`) : ""
    return { source: root && !/^[a-z][\w+.-]*:|^\//i.test(name) ? `${root}${name}` : name, line: best.line + 1, column: best.column + 1 }
  }
  try {
    const script = await text(frame.url)
    const comments = [...script.body.slice(-1_000_000).matchAll(/[#@]\s*sourceMappingURL=(\S+)\s*(?:\*\/)?\s*$/gm)]
    const reference = comments.at(-1)?.[1] ?? script.header
    if (!reference) return { kind: "unmapped" }
    let body: string
    let mapUrl: string
    if (reference.startsWith("data:")) {
      mapUrl = frame.url
      const comma = reference.indexOf(",")
      const payload = reference.slice(comma + 1)
      if (reference.slice(0, comma).endsWith(";base64")) {
        const binary = atob(payload)
        const bytes = new Uint8Array(binary.length)
        for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
        body = new TextDecoder().decode(bytes)
      } else body = decodeURIComponent(payload)
    } else {
      mapUrl = new URL(reference, frame.url).href
      body = (await text(mapUrl)).body
    }
    const map: SourceMapDocument = JSON.parse(body)
    const found = lookup(map, frame.line - 1, frame.column - 1)
    return found ? { kind: "mapped", source: found.source, map: mapUrl, line: found.line, column: found.column } : { kind: "failed", reason: "The source map has no mapping for this position" }
  } catch (error) {
    return { kind: "failed", reason: error instanceof Error ? error.message : String(error) }
  }
}

/* ---------- Node: pure helpers over what the page returned ---------- */

const V8_FRAME = /^\s*at (?:(?:async |new )?(.+?) \()?(.+?):(\d+):(\d+)\)?\s*$/
const WEBKIT_FRAME = /^\s*(?:(.*?)@)?(.+?):(\d+):(\d+)\s*$/

/** A V8 (`at Name (url:1:2)`) or WebKit (`Name@url:1:2`) stack, one frame per line it can read. */
export function parseStack(stack: string): StackFrame[] {
  const frames: StackFrame[] = []
  for (const line of stack.split("\n")) {
    const match = /^\s*at /.test(line) ? V8_FRAME.exec(line) : line.includes("@") ? WEBKIT_FRAME.exec(line) : null
    if (!match) continue
    const [, name, url, row, column] = match
    if (!url || !row || !column) continue
    const frame: StackFrame = { url, line: Number(row), column: Number(column) }
    if (name) frame.name = name
    frames.push(frame)
  }
  return frames
}

const FRAMEWORK_URL = /\/node_modules\/|\/\.vite\/deps\/|react-jsx(?:-dev)?-runtime|react-dom|\/react(?:\.development|\.production)?(?:\.min)?\.js|\/scheduler|\/next\/dist\/|\/_next\/static\/chunks\/(?:framework|main|webpack|react-refresh|polyfills)|\/@react-refresh|\/@vite\/client|chunk-[A-Z0-9]{6,}\.js/
const FRAMEWORK_NAME = /^(?:(?:exports|Object|Module)\.)?(?:jsxDEV|jsxs?|createElement|cloneElement|react-stack-bottom-frame|renderWithHooks|callComponentInDEV)$/

/**
 * The frame that is the element's JSX in the person's own code: the first one
 * that isn't React, a bundler's runtime or a dependency. React 19's owner
 * stack starts at `jsxDEV` itself, which is never the answer. A stack React
 * stopped tracking (`UnknownOwner`, after its 10,000-stack budget) has none.
 */
export function componentFrame(frames: StackFrame[]): StackFrame | undefined {
  if (frames.some((frame) => frame.name === "UnknownOwner")) return undefined
  return frames.find((frame) => /^(?:https?|file):/.test(frame.url) && !FRAMEWORK_URL.test(frame.url) && !FRAMEWORK_NAME.test(frame.name ?? ""))
}

/**
 * A source file as a person names it, from what a bundler wrote in a source
 * map or a stack: `webpack://app/./src/a.tsx?x` and
 * `turbopack:///[project]/src/a.tsx` are `src/a.tsx`, Vite's `/@fs/Users/…`
 * is the absolute path, a URL on the dev server is its path, and a name
 * relative to its map is resolved against the map first.
 */
export function sourceFileName(source: string, base?: string): string {
  let name = source.replace(/[?#].*$/, "")
  const bundled = /^(?:webpack|turbopack|rollup|vite|parcel):\/\/\/?(?:\[project\]\/|[^/]*\/)?(.*)$/.exec(name)
  if (bundled) name = bundled[1]!
  else if (name.startsWith("file://")) name = new URL(name).pathname
  else if (/^https?:\/\//.test(name)) name = new URL(name).pathname
  else if (base && !name.startsWith("/") && /^https?:\/\//.test(base)) name = new URL(name, base).pathname
  try {
    name = decodeURIComponent(name)
  } catch {
    // A name that isn't valid percent-encoding is kept as written.
  }
  if (name.startsWith("/@fs/")) return name.slice(4)
  name = name.replace(/^\.\//, "")
  // A dev server's path is relative to the project; a filesystem path is kept whole.
  return /^\/(?:Users|home|private|var|tmp|opt|Volumes|mnt|workspace|srv|root)\//.test(name) || /^[A-Za-z]:[\\/]/.test(name) ? name : name.replace(/^\/+/, "")
}

/** The chip's words for a picked element: its component, else `tag#id`, else its accessible name, else `tag.class`; at most 40 characters. */
export function elementLabel(element: { component?: string; tag: string; id?: string; name?: string; hint?: string }): string {
  const name = element.name?.replace(/\s+/g, " ").trim()
  const words = element.component
    ?? (element.id && /^[\w-]{1,32}$/.test(element.id) ? `${element.tag}#${element.id}` : undefined)
    ?? (name ? `${element.tag} “${name}”` : undefined)
    ?? element.hint
    ?? element.tag
  return words.length > 40 ? `${words.slice(0, 39).trimEnd()}…` : words
}
