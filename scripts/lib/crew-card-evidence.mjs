import { createHash } from "node:crypto"
import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import { z } from "zod"

const EVENT = "mako:test-crew-evidence"
const LIMIT = 128
const Trace = z.object({
  version: z.literal(1),
  intrusions: z.literal("fixture-markers/native-wrappers/synchronous-geometry"),
  sourceMarkers: z.boolean(),
  observerWrapped: z.boolean(),
  scrollWrapped: z.boolean(),
  dropped: z.number().int().nonnegative(),
  faults: z.number().int().nonnegative(),
  events: z
    .array(
      z.object({
        kind: z.enum([
          "begin",
          "post",
          "failure",
          "counts",
          "geometry",
          "viewport",
          "click",
          "handler",
          "publication",
          "observer",
          "scroll",
        ]),
        at: z.number().finite().nonnegative(),
        role: z.enum(["card", "line", "inner", "ancestor", "active"]).optional(),
        id: z.number().int().nonnegative().optional(),
        parent: z.number().int().nonnegative().optional(),
        thread: z.number().int().nonnegative().optional(),
        value: z.boolean().nullable().optional(),
        values: z.array(z.number().finite().nullable()).max(16).optional(),
      }),
    )
    .max(LIMIT),
})

/** Test-only source markers; extra dispatch and observer wrappers perturb scheduling. No production file is written. */
export function crewEvidencePlugin() {
  return {
    name: "crew-card-test-evidence",
    enforce: "pre",
    transform(code, id) {
      if (!id.split("?")[0].replaceAll("\\", "/").endsWith("/src/state/crew-card-view.ts")) return null
      if (createHash("sha256").update(code).digest("hex") !== "772292b1594aff8829fa3f7e3f2240761d8df89a243015d855f8cf2077b5c2f1")
        throw new Error("Crew evidence requires exact 40b8 controller source")
      const marker = (stage, extra = "") =>
        `try { globalThis.dispatchEvent(new CustomEvent(${JSON.stringify(EVENT)}, { detail: { stage: ${JSON.stringify(stage)}${extra} } })) } catch { /* Evidence must not replace the original action. */ }`
      const once = (text, before, after) => {
        if (text.split(before).length !== 2) throw new Error("Crew evidence source marker is ambiguous")
        return text.replace(before, after)
      }
      let next = once(
        code,
        "  seen = next\n",
        "  seen = next\n  " + marker("publication", ", thread: next?.thread, visible: next?.visible ?? null") + "\n",
      )
      next = once(
        next,
        "export function scrollCrewNeedsIntoView() {\n",
        "export function scrollCrewNeedsIntoView() {\n  " + marker("handler") + "\n",
      )
      return { code: marker("source") + "\n" + next, map: null }
    },
  }
}

/** Runs before the mock renderer. Identity is local ordinal only; no text, paths, URLs, raw Thread IDs or errors are recorded. */
export function installCrewEvidence() {
  const root = window
  const query = new URL(root.location.href).searchParams
  if (!query.has("mock") || query.get("app") !== "apex") return
  const previous = Object.getOwnPropertyDescriptor(root, "__crewEvidence")
  if (previous && !previous.configurable) return
  const events = [],
    ids = new WeakMap(),
    threads = new Map(),
    descriptors = [],
    listeners = []
  let active = false,
    disposed = false,
    nextId = 0,
    dropped = 0,
    faults = 0,
    sourceMarkers = false,
    observerWrapped = false,
    scrollWrapped = false
  const number = (value) => (Number.isFinite(value) ? Math.max(-10000000, Math.min(10000000, Math.round(value * 100) / 100)) : null)
  const id = (node) => {
    if (!node) return 0
    if (!ids.has(node)) {
      if (nextId === 8192) dropped++
      ids.set(node, nextId < 8192 ? ++nextId : 0)
    }
    return ids.get(node)
  }
  const thread = (value) => {
    if (!value) return 0
    const name = String(value).slice(0, 128)
    if (!threads.has(name)) {
      if (threads.size === 16) {
        dropped++
        return 0
      }
      threads.set(name, threads.size + 1)
    }
    return threads.get(name)
  }
  const safe = (work) => {
    try {
      return work()
    } catch {
      faults++
      return undefined
    }
  }
  const record = (kind, fields = {}) => {
    if (!active || disposed) return
    safe(() => {
      if (events.length === 128) {
        events.splice(64, 1)
        dropped++
      }
      events.push({ kind, at: Math.round(performance.now() * 10) / 10, ...fields })
    })
  }
  const rect = (node) => {
    const r = node?.getBoundingClientRect()
    return r ? [r.left, r.top, r.right, r.bottom].map(number) : [null, null, null, null]
  }
  const geometry = (node, role) =>
    record("geometry", {
      role,
      id: id(node),
      parent: id(node?.parentElement),
      values: [...rect(node), number(node?.scrollTop), number(node?.scrollHeight), number(node?.clientHeight), number(node?.clientWidth)],
    })
  const snapshot = (kind) =>
    safe(() => {
      record(kind)
      const cards = root.document.querySelectorAll("[data-crew]"),
        lines = root.document.querySelectorAll("[data-crew-away]")
      record("counts", { values: [cards.length, lines.length, root.document.querySelectorAll("[data-crew-needs]").length] })
      dropped += Math.max(0, cards.length - 8) + Math.max(0, lines.length - 8)
      record("viewport", { values: [root.innerWidth, root.innerHeight, root.devicePixelRatio].map(number) })
      for (const card of [...cards].slice(0, 8)) {
        geometry(card, "card")
        geometry(card.querySelector("[data-crew-scroller]"), "inner")
      }
      for (const line of [...lines].slice(0, 8)) geometry(line, "line")
      let parent = cards[0]?.parentElement
      for (let depth = 0; parent && depth < 6; depth++, parent = parent.parentElement) geometry(parent, "ancestor")
      geometry(root.document.activeElement, "active")
    })
  const listen = (name, callback) => {
    root.addEventListener(name, callback, true)
    listeners.push([name, callback])
  }
  const replace = (owner, name, value) => {
    const original = Object.getOwnPropertyDescriptor(owner, name)
    if (!original || !original.configurable || !("value" in original) || !original.value) {
      faults++
      return false
    }
    Object.defineProperty(owner, name, { ...original, value })
    descriptors.push([owner, name, original])
    return true
  }
  const dispose = () => {
    if (disposed) return
    disposed = true
    active = false
    for (const [name, callback] of listeners.splice(0)) safe(() => root.removeEventListener(name, callback, true))
    for (const [owner, name, descriptor] of descriptors.splice(0).reverse()) safe(() => Object.defineProperty(owner, name, descriptor))
    safe(() => (previous ? Object.defineProperty(root, "__crewEvidence", previous) : delete root.__crewEvidence))
    threads.clear()
    events.length = 0
  }
  try {
    listen("mako:test-crew-evidence", (event) =>
      safe(() => {
        const detail = event.detail
        if (detail?.stage === "source") sourceMarkers = true
        else if (detail?.stage === "handler") record("handler")
        else if (detail?.stage === "publication")
          record("publication", {
            thread: thread(detail.thread),
            value: detail.visible === true ? true : detail.visible === false ? false : null,
          })
      }),
    )
    listen("click", (event) =>
      safe(() => {
        const line = event.target?.closest?.("[data-crew-away]")
        if (line) record("click", { id: id(line), value: event.isTrusted })
      }),
    )
    const Observer = root.IntersectionObserver
    if (Observer)
      observerWrapped = replace(
        root,
        "IntersectionObserver",
        class extends Observer {
          constructor(callback, options) {
            super(function (entries, _observer) {
              if (active && !disposed) safe(() => {
                dropped += Math.max(0, entries.length - 8)
                for (const entry of entries.slice(0, 8))
                  if (entry.target?.hasAttribute("data-crew")) {
                    record("observer", {
                      id: id(entry.target),
                      value: entry.isIntersecting,
                      values: [
                        number(entry.intersectionRatio),
                        ...rect(entry.target),
                        ...[
                          entry.intersectionRect?.left,
                          entry.intersectionRect?.top,
                          entry.intersectionRect?.right,
                          entry.intersectionRect?.bottom,
                          entry.rootBounds?.left,
                          entry.rootBounds?.top,
                          entry.rootBounds?.right,
                          entry.rootBounds?.bottom,
                        ].map(number),
                      ],
                    })
                  }
              })
              return callback.apply(this, arguments)
            }, options)
          }
        },
      )
    const scroll = root.Element.prototype.scrollIntoView
    if (scroll)
      scrollWrapped = replace(root.Element.prototype, "scrollIntoView", function (...args) {
        safe(() => {
          if (this.hasAttribute("data-crew")) record("scroll", { id: id(this), values: rect(this) })
        })
        return scroll.apply(this, args)
      })
    Object.defineProperty(root, "__crewEvidence", {
      configurable: true,
      value: {
        begin() {
          safe(() => {
            active = true
            snapshot("begin")
          })
        },
        post() {
          snapshot("post")
        },
        failure() {
          safe(() => {
            active = true
            snapshot("failure")
          })
        },
        end() {
          active = false
        },
        dump() {
          return {
            version: 1,
            intrusions: "fixture-markers/native-wrappers/synchronous-geometry",
            sourceMarkers,
            observerWrapped,
            scrollWrapped,
            dropped,
            faults,
            events: events.slice(),
          }
        },
        dispose,
      },
    })
  } catch {
    faults++
    dispose()
  }
}

export const CREW_EVIDENCE_PRELOAD = `\n;try { (${installCrewEvidence.toString()})(); } catch { /* Fixture evidence unavailable; original page must still run. */ }\n`
export const CREW_EVIDENCE_CLEANUP = "window.__crewEvidence?.dispose(); true"

/** Artifact I/O alone is bounded; it never changes the test's 20s condition deadline or replaces a thrown value. */
async function attempt(work) {
  let timer
  try {
    return await Promise.race([
      Promise.resolve().then(work),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(undefined), 1000)
      }),
    ])
  } catch {
    return undefined
  } finally {
    clearTimeout(timer)
  }
}

async function writeTrace(page, shots, name, write, failure) {
  try {
    const code = failure
      ? "window.__crewEvidence?.failure(); window.__crewEvidence?.dump() ?? null"
      : "window.__crewEvidence?.dump() ?? null"
    const raw = await attempt(() => page.executeJavaScript(code))
    const parsed = Trace.safeParse(raw)
    const report = parsed.success ? parsed.data : { version: 1, unavailable: true }
    const text = JSON.stringify(report)
    await attempt(() =>
      write(
        join(shots, name),
        Buffer.byteLength(text) <= 65536
          ? text
          : JSON.stringify({
              version: 1,
              outputTruncated: true,
              dropped: parsed.success ? parsed.data.dropped : 0,
              outputDropped: parsed.success ? parsed.data.events.length : 0,
            }),
      ),
    )
    return parsed.success && parsed.data.sourceMarkers
  } catch {
    /* Diagnostic failure must not replace any original result. */
    return false
  }
}

/** A success is evidence of this execution only; retain its bounded markers before later navigation discards the page. */
export async function saveCrewInteraction({ page, shots, write = writeFile }) {
  try {
    await writeTrace(page, shots, "crew-card-ui-interaction.json", write, false)
  } finally {
    await attempt(() => page.executeJavaScript("window.__crewEvidence?.end(); true"))
  }
}

export async function withCrewFailureEvidence({ page, shots, write = writeFile }, work) {
  try {
    return await work()
  } catch (primary) {
    try {
      const mockSource = await writeTrace(page, shots, "crew-card-ui-failure.json", write, true)
      // No new screenshot unless the exact mock module markers were observed.
      if (mockSource) {
        const image = await attempt(() => page.capturePage())
        const bytes = await attempt(() => image?.toPNG())
        const png = z.instanceof(Uint8Array).safeParse(bytes)
        if (png.success && png.data.byteLength <= 8 * 1024 * 1024)
          await attempt(() => write(join(shots, "crew-card-ui-failure.png"), png.data))
      }
    } catch {
      /* Diagnostic failure must not replace any original thrown value. */
    }
    throw primary
  } finally {
    await attempt(() => page.executeJavaScript(CREW_EVIDENCE_CLEANUP))
  }
}
