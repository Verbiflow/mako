import { randomUUID } from "node:crypto"
import { z } from "zod"
import {
  componentFrame,
  elementLabel,
  installElementPicker,
  installReactProbe,
  pageFunctionSource,
  parseStack,
  resolveScriptPosition,
  sourceFileName,
  type ElementReactInfo,
} from "@mako/control/browser"
import type { BorrowedTab } from "./browser-service.js"
import type {
  ElementPickEnd,
  ElementPickOutcome,
  PickedElement,
} from "./contracts/element-pick.js"
import type { JsonObject } from "./json.js"

/** How long the component's source may take to resolve before the pick goes without it. */
const SOURCE_BUDGET_MS = 2_000
/** A pick nobody finishes ends on its own. */
const IDLE_MS = 10 * 60_000
/** One long poll; shorter than the connection's 30-second request timeout. */
const POLL_MS = 20_000
/** Room around a crop, CSS pixels, so the element reads in place. */
const CROP_PADDING = 8

const frameTreeSchema = z.object({
  frameTree: z.object({ frame: z.object({ id: z.string(), url: z.string() }) }),
})
const worldSchema = z.object({ executionContextId: z.number() })
const reactSchema = z.object({
  component: z.string().max(200).optional(),
  stack: z.string().max(8000).optional(),
  source: z
    .object({
      fileName: z.string().max(2000),
      lineNumber: z.number().int().positive().optional(),
      columnNumber: z.number().int().positive().optional(),
    })
    .optional(),
})
const captureSchema = z.object({
  tag: z.string().max(200),
  selector: z.string().max(4000).nullable(),
  html: z.string().max(8000),
  styles: z.string().max(8000),
  box: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }),
  id: z.string().optional(),
  hint: z.string().max(400),
  text: z.string().max(400).optional(),
  frame: z.boolean(),
  shadow: z.boolean(),
  react: reactSchema.optional(),
})
type Capture = z.infer<typeof captureSchema>
const progressSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("picking") }),
  z.object({ state: z.literal("done"), count: z.number().int().min(0).max(64), comment: z.string().max(8000), send: z.boolean() }),
  z.object({ state: z.literal("cancelled") }),
])
const rectSchema = z
  .object({ x: z.number(), y: z.number(), width: z.number(), height: z.number(), viewportWidth: z.number(), viewportHeight: z.number() })
  .nullable()
const positionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("mapped"), source: z.string(), map: z.string(), line: z.number().int().positive(), column: z.number().int().positive() }),
  z.object({ kind: z.literal("unmapped") }),
  z.object({ kind: z.literal("failed"), reason: z.string() }),
])
const evaluationSchema = z.object({
  result: z.object({ value: z.json().optional(), objectId: z.string().optional() }).optional(),
  exceptionDetails: z
    .object({ text: z.string().optional(), exception: z.object({ description: z.string().optional() }).optional() })
    .optional(),
})
const axSchema = z.object({
  nodes: z.array(
    z.object({
      backendDOMNodeId: z.number().optional(),
      ignored: z.boolean().optional(),
      role: z.object({ value: z.json().optional() }).optional(),
      name: z.object({ value: z.json().optional() }).optional(),
    })
  ),
})
const nodeSchema = z.object({ node: z.object({ backendNodeId: z.number() }) })
const pageSchema = z.object({ url: z.string(), title: z.string() })

/** What the accessibility tree calls an element, when it says more than its tag. */
interface AccessibleName {
  role?: string
  name?: string
}

/** Roles that say nothing a selector and the HTML don't. */
const PLAIN_ROLES = new Set(["generic", "none", "GenericContainer", "Unknown", "InlineTextBox", "StaticText"])

export interface ElementPickSession {
  /** Settles once: what the person picked, or why nothing was. */
  outcome: Promise<ElementPickOutcome>
  /** End the pick from Mako's side; the overlay leaves and nothing is added. */
  cancel(reason: string): void
}

export interface ElementPickSettings {
  /** At most this many elements in one pick. */
  limit: number
  /** Shows ⌘ or Ctrl for the send chord in the page's panel. */
  platform: "mac" | "other"
}

class PickEnded extends Error {
  readonly by: ElementPickEnd
  constructor(by: ElementPickEnd, reason: string) {
    super(reason)
    this.by = by
  }
}

/**
 * Put the element picker into a borrowed tab and run it to its end. Resolves
 * once the overlay is up; the session's outcome settles when the person adds
 * the elements, cancels, the page navigates or closes, or Mako cancels. The
 * tab is left as it was found: the overlay, the main-world probe and any
 * claim Mako made for the pick are removed whichever way it ends.
 */
export async function startElementPick(tab: BorrowedTab, settings: ElementPickSettings): Promise<ElementPickSession> {
  const stop = new AbortController()
  let ended: PickEnded | undefined
  const end = (by: ElementPickEnd, reason: string) => {
    if (ended) return
    ended = new PickEnded(by, reason)
    stop.abort(ended)
  }
  const call = (method: string, params: JsonObject, timeoutMs = 10_000) =>
    tab.send(method, params, AbortSignal.any([stop.signal, AbortSignal.timeout(timeoutMs)]))
  const token = randomUUID().replaceAll("-", "")
  let contextId: number | undefined
  const evaluate = async (expression: string, options: { world: "page" | "main"; timeoutMs?: number; byValue?: boolean } = { world: "page" }) => {
    const params: JsonObject = { expression, awaitPromise: true, returnByValue: options.byValue ?? true }
    if (options.world === "page") {
      if (contextId === undefined) throw new PickEnded("page", "The pick's page context is gone.")
      params.contextId = contextId
    }
    const reply = evaluationSchema.parse(await call("Runtime.evaluate", params, options.timeoutMs))
    if (reply.exceptionDetails)
      throw new Error(reply.exceptionDetails.exception?.description?.split("\n")[0] ?? reply.exceptionDetails.text ?? "The page refused the picker")
    return reply.result
  }

  const unsubscribe = [
    tab.onEvent((event) => {
      if (event.method === "Page.frameNavigated") {
        const navigated = z.object({ frame: z.object({ parentId: z.string().optional() }) }).safeParse(event.params)
        if (navigated.success && navigated.data.frame.parentId === undefined) end("page", "The page navigated, so the pick ended.")
      } else if (event.method === "Target.detachedFromTarget" || event.method === "Target.targetDestroyed")
        end("page", "The tab closed, so the pick ended.")
    }),
    tab.onClose(() => end("page", "The browser disconnected, so the pick ended.")),
  ]
  const idle = setTimeout(() => end("mako", "The pick waited ten minutes and ended."), IDLE_MS)
  idle.unref()

  let installed = false
  const teardown = async () => {
    clearTimeout(idle)
    for (const off of unsubscribe) off()
    if (installed && contextId !== undefined)
      await tab
        .send("Runtime.evaluate", { contextId, expression: "globalThis.__makoElementPick?.end()" }, AbortSignal.timeout(2_000))
        .catch(() => undefined)
    // The probe leaves with the overlay's end event; this is for an overlay that never arrived.
    await tab
      .send("Runtime.evaluate", { expression: `document.dispatchEvent(new CustomEvent(${JSON.stringify(`mako-pick-end-${token}`)}))` }, AbortSignal.timeout(2_000))
      .catch(() => undefined)
    await tab.release()
  }

  try {
    // The person asked for this tab, so it comes forward (AGENTS.md, "Browser
    // and computer control": nothing fronts the user's application unless the
    // call says so; this one is the person's own request).
    await call("Page.bringToFront", {})
    const tree = frameTreeSchema.parse(await call("Page.getFrameTree", {}))
    contextId = worldSchema.parse(
      await call("Page.createIsolatedWorld", { frameId: tree.frameTree.frame.id, worldName: "Mako element pick" })
    ).executionContextId
    await evaluate(pageFunctionSource(installReactProbe.toString(), token), { world: "main" })
    await evaluate(pageFunctionSource(installElementPicker.toString(), { token, limit: settings.limit, platform: settings.platform }))
    installed = true
  } catch (error) {
    await teardown()
    if (ended) throw new Error(ended.message, { cause: error })
    throw error
  }

  const run = async (): Promise<ElementPickOutcome> => {
    for (;;) {
      const progress = progressSchema.parse(
        (await evaluate(`globalThis.__makoElementPick ? globalThis.__makoElementPick.next(${POLL_MS}) : { state: "cancelled" }`, { world: "page", timeoutMs: POLL_MS + 5_000 }))?.value
      )
      if (progress.state === "cancelled") return { status: "cancelled", by: "person", reason: "Cancelled in the page." }
      if (progress.state === "done") {
        const elements = await capture(progress.count)
        if (!elements.length) return { status: "cancelled", by: "page", reason: "The picked elements left the page before Mako could read them." }
        const page = pageSchema.parse((await evaluate("({ url: location.href, title: document.title })"))?.value)
        return { status: "picked", pick: { ...page, comment: progress.comment, send: progress.send, elements } }
      }
    }
  }

  const capture = async (count: number): Promise<PickedElement[]> => {
    const read: { capture: Capture; role?: string; name?: string }[] = []
    for (let index = 0; index < count; index++) {
      const value = captureSchema.nullable().parse((await evaluate(`globalThis.__makoElementPick.describe(${index})`))?.value ?? null)
      if (!value) continue
      read.push({ capture: value, ...(await accessibility(index)) })
    }
    const deadline = Date.now() + SOURCE_BUDGET_MS
    const sources = await Promise.all(read.map(({ capture: value }) => source(value.react, deadline)))
    await evaluate("globalThis.__makoElementPick.hide()")
    const elements: PickedElement[] = []
    for (const [index, entry] of read.entries()) {
      const value = entry.capture
      const element: PickedElement = {
        tag: value.tag,
        selector: value.selector,
        html: value.html,
        styles: value.styles,
        box: value.box,
        frame: value.frame,
        label: elementLabel({ component: value.react?.component, tag: value.tag, id: value.id, name: entry.name ?? value.text, hint: value.hint }),
      }
      if (entry.role) element.role = entry.role
      const name = entry.name ?? value.text
      if (name) element.name = name.slice(0, 1000)
      if (value.react?.component) element.component = value.react.component
      const found = sources[index]
      if (found) element.source = found
      const image = await crop(index)
      if (image) element.image = image
      elements.push(element)
    }
    return elements
  }

  const accessibility = async (index: number): Promise<AccessibleName> => {
    try {
      const handle = await evaluate(`globalThis.__makoElementPick.element(${index})`, { world: "page", byValue: false })
      if (!handle?.objectId) return {}
      const { backendNodeId } = nodeSchema.parse(await call("DOM.describeNode", { objectId: handle.objectId })).node
      void call("Runtime.releaseObject", { objectId: handle.objectId }).catch(() => undefined)
      const tree = axSchema.parse(await call("Accessibility.getPartialAXTree", { backendNodeId, fetchRelatives: false }))
      const node = tree.nodes.find((entry) => entry.backendDOMNodeId === backendNodeId) ?? tree.nodes[0]
      if (!node || node.ignored) return {}
      const role = z.string().safeParse(node.role?.value).data
      const name = z.string().safeParse(node.name?.value).data?.replace(/\s+/g, " ").trim()
      const named: AccessibleName = {}
      if (role && !PLAIN_ROLES.has(role)) named.role = role
      if (name) named.name = name
      return named
    } catch (error) {
      if (ended) throw error
      return {}
    }
  }

  const source = async (react: ElementReactInfo | undefined, deadline: number): Promise<PickedElement["source"]> => {
    if (react?.source?.fileName) {
      const found: NonNullable<PickedElement["source"]> = { file: sourceFileName(react.source.fileName) }
      if (react.source.lineNumber) found.line = react.source.lineNumber
      if (react.source.columnNumber) found.column = react.source.columnNumber
      return found
    }
    const frame = react?.stack ? componentFrame(parseStack(react.stack)) : undefined
    if (!frame) return undefined
    const remaining = deadline - Date.now()
    if (!/^https?:/.test(frame.url) || remaining < 100) return { file: sourceFileName(frame.url) }
    const position = await evaluate(pageFunctionSource(resolveScriptPosition.toString(), frame, remaining - 50), { world: "page", timeoutMs: remaining })
      .then((result) => positionSchema.parse(result?.value))
      .catch((error) => {
        if (ended) throw error
        return { kind: "failed" as const, reason: "The source map didn't answer in time" }
      })
    if (position.kind === "mapped") return { file: sourceFileName(position.source, position.map), line: position.line, column: position.column }
    // A script with no map is the source as written; a map that failed leaves only the file.
    if (position.kind === "unmapped") return { file: sourceFileName(frame.url), line: frame.line, column: frame.column }
    return { file: sourceFileName(frame.url) }
  }

  const crop = async (index: number): Promise<PickedElement["image"]> => {
    try {
      const rect = rectSchema.parse((await evaluate(`globalThis.__makoElementPick.frameRect(${index})`))?.value ?? null)
      if (!rect) return undefined
      const left = Math.max(0, Math.floor(rect.x - CROP_PADDING))
      const top = Math.max(0, Math.floor(rect.y - CROP_PADDING))
      const right = Math.min(Math.floor(rect.viewportWidth), Math.ceil(rect.x + rect.width + CROP_PADDING))
      const bottom = Math.min(Math.floor(rect.viewportHeight), Math.ceil(rect.y + rect.height + CROP_PADDING))
      if (right - left < 2 || bottom - top < 2) return undefined
      return await tab.screenshot({ x: left, y: top, width: right - left, height: bottom - top }, AbortSignal.any([stop.signal, AbortSignal.timeout(10_000)]))
    } catch (error) {
      if (ended) throw error
      return undefined
    }
  }

  const outcome = run()
    .catch((error): ElementPickOutcome => {
      if (ended) return { status: "cancelled", by: ended.by, reason: ended.message }
      const message = error instanceof Error ? error.message : String(error)
      // A context destroyed under the poll is a navigation the event hasn't reported yet.
      return /context|destroyed|detached|not found|closed/i.test(message)
        ? { status: "cancelled", by: "page", reason: "The page changed, so the pick ended." }
        : { status: "cancelled", by: "mako", reason: `The pick failed: ${message}` }
    })
    .finally(() => teardown())
  return {
    outcome,
    cancel: (reason) => end("mako", reason),
  }
}
