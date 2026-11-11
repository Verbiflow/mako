import { z } from "zod"

const BoundaryEvidence = z.object({
  events: z.array(z.record(z.string(), z.json())).max(128),
  dropped: z.number().int().nonnegative(),
  unavailable: z.number().int().nonnegative(),
  complete: z.boolean(),
  bounds: z.object({
    strings: z.number().int().nonnegative(), originalStringUnits: z.number().int().nonnegative(), retainedStringUnits: z.number().int().nonnegative(),
    truncatedStrings: z.number().int().nonnegative(), collectionItems: z.number().int().nonnegative(), retainedCollectionItems: z.number().int().nonnegative(),
    truncatedCollectionItems: z.number().int().nonnegative(), attemptedEvents: z.number().int().nonnegative(),
  }).strict(),
  cleanupFailures: z.array(z.string().max(120)).max(32),
  rowHandlerEntry: z.string().max(180),
}).strict().refine(value => value.bounds.attemptedEvents === value.events.length + value.dropped
  && value.bounds.collectionItems - value.bounds.retainedCollectionItems === value.bounds.truncatedCollectionItems
  && value.bounds.originalStringUnits >= value.bounds.retainedStringUnits && value.bounds.truncatedStrings <= value.bounds.strings
  && ((value.bounds.truncatedStrings === 0) === (value.bounds.originalStringUnits === value.bounds.retainedStringUnits)))
.refine(value => value.complete === (value.dropped === 0 && value.unavailable === 0 && value.cleanupFailures.length === 0 && value.bounds.truncatedStrings === 0 && value.bounds.truncatedCollectionItems === 0))

/** Runs only inside the existing synthetic Inbox page; never invokes navigation or another pointer action. */
export function installInboxBoundaryProbe({ acp, acpStore, store, viewerStore, threadGroupsStore, threadsStore, windowRoutesStore, tabsStore, rowThread }, { id, deadline } = {}) {
  if (window.inboxBoundaryProbe) throw new Error("An Inbox boundary probe already owns this page")
  const selector = ".thread-jump-scope [data-apex-row]"
  const events = [], releases = [], restores = []
  let closed = false, dropped = 0, unavailable = 0, serial = 0, targetKey = null
  let targetElement, targetScroller, targetPoint, previousInput, inputState = "not-observed"
  const bounds = { strings: 0, originalStringUnits: 0, retainedStringUnits: 0, truncatedStrings: 0,
    collectionItems: 0, retainedCollectionItems: 0, truncatedCollectionItems: 0, attemptedEvents: 0 }
  const text = value => {
    const parsed = z.string().safeParse(value)
    if (!parsed.success) return null
    bounds.strings++; bounds.originalStringUnits += value.length; bounds.retainedStringUnits += Math.min(value.length, 120)
    if (value.length > 120) bounds.truncatedStrings++
    return value.slice(0, 120)
  }
  const list = (values, counts, key, project) => {
    counts[key] = { original: values.length, retained: Math.min(values.length, 16), dropped: Math.max(0, values.length - 16) }
    bounds.collectionItems += values.length; bounds.retainedCollectionItems += counts[key].retained; bounds.truncatedCollectionItems += counts[key].dropped
    return values.slice(0, 16).map(project)
  }
  const node = element => element ? { tag: text(element.tagName), role: text(element.getAttribute?.("role")),
    conversation: text(element.getAttribute?.("data-conversation-id")), tab: text(element.getAttribute?.("data-session-tab")),
    closestRowKey: text(element.closest?.("[data-conversation-id]")?.getAttribute("data-conversation-id")) } : null
  const rect = value => Object.fromEntries(["x", "y", "width", "height"].map(key => [key, Number.isFinite(value[key]) ? value[key] : null]))
  const snapshot = () => {
    const acp = acpStore.get(), view = viewerStore.get(), groups = threadGroupsStore.get(), boot = store.get()
    const current = acp.conversations[acp.activeKey], target = acp.conversations[targetKey], counts = {}
    const thread = value => {
      if (!value) return null
      const result = rowThread(value, groups.threadOf)
      if (!result) unavailable++ // Absence of identity is unknown, not a proven ungrouped Session.
      return result ?? null
    }
    const targetThread = thread(target), activeThread = thread(current), tabs = tabsStore.get()
    if (!z.string().safeParse(tabs.activeId).success) unavailable++
    if (targetKey && !target) unavailable++
    if (acp.activeKey && !current) unavailable++
    const conversation = value => value ? { key: text(value.key), session: text(value.sessionId), kind: text(value.kind), thread: text(value.threadId), hydrated: value.hydrated === true,
      revision: value.revision ?? null, epoch: text(value.epoch) } : null
    const sessions = (id, name) => list(id ? (groups.groups[id]?.sessions ?? []) : [], counts, name, session => ({ id: text(session.id), started: session.started }))
    return { phase: text(boot.phase), activeKey: text(acp.activeKey), activeTab: text(tabs.activeId), current: conversation(current), target: conversation(target),
      routePresent: Boolean(windowRoutesStore.get().routes), focusedPane: text(view.focusedPaneId),
      panes: list(view.panes, counts, "panes", pane => ({ id: text(pane.id), activeId: text(pane.activeId), session: pane.session ? { thread: text(pane.session.thread), tab: text(pane.session.tab) } : null })),
      openGroup: text(groups.open), groupForTarget: text(targetThread), groupForActive: text(activeThread),
      targetGroupSessions: sessions(targetThread, "targetGroupSessions"), activeGroupSessions: sessions(activeThread, "activeGroupSessions"),
      targetListed: targetThread ? threadsStore.get().threads.some(thread => thread.threadId === targetThread) : null,
      selectedTabs: list([...document.querySelectorAll('[data-session-tab][aria-selected="true"]')], counts, "selectedTabs", node), counts,
      tabCount: document.querySelectorAll("[data-session-tab]").length, inbox: Boolean(document.querySelector("[data-inbox]")),
      readOutcome: "not directly observed; hydration/revision store observations only" }
  }
  const record = (kind, fields = {}) => {
    if (closed) return
    bounds.attemptedEvents++
    if (events.length === 128) { dropped++; return }
    try { const entry = { order: ++serial, kind, ...fields, state: snapshot() }; events.push(entry); return entry }
    catch { unavailable++; events.push({ order: ++serial, kind: "observation-unavailable", during: kind }) }
  }
  const wrap = (owner, key, name) => {
    const original = owner[key]
    if (!z.function().safeParse(original).success) throw new Error(name + " is not callable")
    const observe = function (...args) {
      record(name + ":entry", { target: text(args[0]?.key ?? args[0]) })
      try {
        const value = original.call(this, ...args)
        record(name + ":return", { result: z.boolean().safeParse(value).success ? value : value === undefined ? "undefined" : "other-return-preserved" })
        return value
      } catch (error) { record(name + ":throw", { errorKind: error instanceof Error ? "Error" : "non-Error value preserved" }); throw error }
    }
    owner[key] = observe
    restores.push(() => { if (owner[key] !== observe) throw new Error(name + " ownership changed"); owner[key] = original })
  }
  const listener = event => {
    const row = document.querySelector(selector)
    record(event.type, { trusted: event.isTrusted, x: event.clientX, y: event.clientY, hit: node(event.target), targetContainsEvent: Boolean(row?.contains(event.target)), sameNode: row === targetElement, intendedConnected: targetElement?.isConnected === true, intendedContainsEvent: Boolean(targetElement?.contains(event.target)) })
  }
  let timer
  const probe = {
    id,
    target(element, deadline) {
      if (closed || !Number.isFinite(deadline) || Date.now() >= deadline) throw new Error("INPUT precondition: target lease expired/unknown; no press")
      targetElement = element; targetKey = element.getAttribute("data-conversation-id"); targetPoint = undefined
      targetScroller = element.closest(".scroll-fade-scroller"); previousInput = undefined; inputState = "settling"
      const matches = document.querySelectorAll(selector)
      const entry = record("target-identified", { count: matches.length, target: node(element) })
      const refuse = reason => { inputState = "refused"; if (entry) entry.inputRefusal = reason; throw new Error("INPUT precondition: " + reason + "; no press") }
      if (matches.length !== 1 || matches[0] !== element || !element.isConnected) refuse("missing/multiple/disconnected intended row")
      if (!z.string().min(1).max(120).safeParse(targetKey).success || !id) refuse("unknown row/probe identity")
      if (!targetScroller?.isConnected) refuse("unknown/disconnected rail scroller")
      return { key: targetKey, owner: id }
    },
    point(point, lease) {
      if (closed || !Number.isFinite(lease.deadline) || Date.now() >= lease.deadline) throw new Error("INPUT precondition: readiness lease expired/unknown; no press")
      const choosing = point === null
      inputState = choosing ? "settling" : "waiting"
      // Snapshot/diagnostic effects run BEFORE the final same-node/geometry/animation/hit observation.
      const entry = record(choosing ? "before-point-selection" : "before-original-press", { point, frame: Number.isFinite(lease.frame) ? lease.frame : null })
      const refuse = reason => { inputState = "refused"; if (entry) entry.inputRefusal = reason; throw new Error("INPUT precondition: " + reason + "; no press") }
      const matches = document.querySelectorAll(selector)
      if (lease.owner !== id || lease.key !== targetKey || !targetElement || matches.length !== 1 || matches[0] !== targetElement || !targetElement.isConnected || targetElement.getAttribute("data-conversation-id") !== targetKey) refuse("intended row/probe missing, multiple, replaced or key changed")
      if (choosing ? targetPoint !== undefined : !targetPoint || point.x !== targetPoint.x || point.y !== targetPoint.y) refuse("original point changed/already selected")
      if (!targetScroller?.isConnected || targetElement.closest(".scroll-fade-scroller") !== targetScroller) refuse("rail scroller replaced/disconnected")
      const animations = targetScroller.getAnimations({ subtree: true }).filter(animation => animation.id === "rail-flip")
      const counts = {}, animationFacts = list(animations, counts, "railFlip", animation => ({ id: text(animation.id), state: text(animation.playState), pending: animation.pending, endTime: animation.effect?.getComputedTiming().endTime }))
      let settled = true
      for (const animation of animations) {
        if (!["idle", "running", "paused", "finished"].includes(animation.playState) || !z.boolean().safeParse(animation.pending).success || !Number.isFinite(animation.effect?.getComputedTiming().endTime)) refuse("unknown/nonfinite rail-flip animation")
        if (animation.pending || !["idle", "finished"].includes(animation.playState)) settled = false
      }
      const geometry = rect(targetElement.getBoundingClientRect())
      const scroll = { x: window.scrollX, y: window.scrollY, left: targetScroller.scrollLeft, top: targetScroller.scrollTop }
      const position = [geometry.x, geometry.y, geometry.width, geometry.height, ...Object.values(scroll)]
      if (!position.every(Number.isFinite) || geometry.width <= 0 || geometry.height <= 0 || !Number.isFinite(lease.frame)) refuse("nonfinite/empty geometry, scroll or frame")
      const finalMatches = document.querySelectorAll(selector)
      if (finalMatches.length !== 1 || finalMatches[0] !== targetElement || !targetElement.isConnected || targetElement.getAttribute("data-conversation-id") !== targetKey || !targetScroller.isConnected || targetElement.closest(".scroll-fade-scroller") !== targetScroller) refuse("intended row/scroller identity changed during readiness observation")
      // Choose from settled geometry first; after hover, the hit is the final DOM observation before press.
      const hit = choosing ? null : document.elementFromPoint(point.x, point.y), contains = choosing ? null : targetElement.contains(hit)
      const stable = previousInput && lease.frame > previousInput.frame && position.every((value, index) => value === previousInput.position[index])
      const ready = Boolean(stable && settled && (choosing || contains))
      if (entry) Object.assign(entry, { count: matches.length, sameNode: true, currentGeometry: geometry, scroll, animations: animationFacts, animationCounts: counts, hit: node(hit), targetContainsHit: contains, stable: Boolean(stable), ready })
      if (choosing && ready) {
        targetPoint = { x: Math.round(geometry.x + geometry.width / 2), y: Math.round(geometry.y + geometry.height / 2) }
        inputState = "chosen"
        previousInput = undefined
        if (entry) entry.point = targetPoint
      } else {
        previousInput = { position, frame: lease.frame }
        if (ready) inputState = "ready"
      }
      return { ready, point: targetPoint ?? null, key: targetKey, owner: id }
    },
    finish() {
      if (closed) throw new Error("Inbox boundary evidence already finished")
      if (!["ready", "refused"].includes(inputState)) {
        unavailable++
        record("input-precondition-UNKNOWN", { inputState, reason: "preparation/capture did not settle; no readiness claim" })
      }
      record("boundary-finished")
      closed = true
      clearTimeout(timer)
      const cleanupFailures = []
      const attempt = (stage, work) => { try { work() } catch { cleanupFailures.push(stage) } }
      for (const release of releases) attempt("store subscription", release)
      for (const restore of restores) attempt("method ownership/restore", restore)
      for (const kind of ["mousedown", "mouseup", "click"]) attempt("DOM listener", () => document.removeEventListener(kind, listener, true))
      if (window.inboxBoundaryProbe === probe) delete window.inboxBoundaryProbe
      else cleanupFailures.push("probe ownership changed; foreign value retained")
      return { events, dropped, unavailable, bounds, complete: dropped === 0 && unavailable === 0 && cleanupFailures.length === 0 && bounds.truncatedStrings === 0 && bounds.truncatedCollectionItems === 0, cleanupFailures,
        rowHandlerEntry: "unobserved directly; DOM capture and downstream actual acp/route entries distinguished" }
    },
  }
  window.inboxBoundaryProbe = probe
  try {
    wrap(acp, "open", "acp.open")
    wrap(acp, "activate", "acp.activate")
    const routes = windowRoutesStore.get().routes
    if (routes) wrap(routes, "open", "routes.open")
    for (const source of [acpStore, store, viewerStore, threadGroupsStore, threadsStore, windowRoutesStore, tabsStore])
      releases.push(source.subscribe(() => record("store-change")))
    for (const kind of ["mousedown", "mouseup", "click"]) document.addEventListener(kind, listener, true)
    record("row-exists-before-original-click", { count: document.querySelectorAll(selector).length })
    if (deadline !== undefined) timer = setTimeout(() => { if (!closed) probe.finish() }, Math.max(0, deadline - Date.now()))
  } catch (error) {
    const evidence = probe.finish()
    if (evidence.cleanupFailures.length) throw new AggregateError([error, new Error(evidence.cleanupFailures.join(", "))], "Inbox boundary setup and cleanup failed", { cause: error })
    throw error
  }
}

/** The imports may settle late; the page must refuse installation after its setup lease. */
export function prepareInboxBoundaryProbe(modules, lease) {
  if (Date.now() >= lease.setupDeadline || Date.now() >= lease.deadline) throw new Error("Inbox probe setup lease expired; no installation")
  installInboxBoundaryProbe(modules, lease)
  return { installed: true, id: lease.id }
}

/** Diagnostic waits consume the existing overall clock, never extend the original predicate/guard. */
export async function withInboxBoundaryEvidence(evaluate, record, operation, deadline) {
  if (!Number.isFinite(deadline)) throw new Error("Inbox diagnostics require the original overall deadline")
  // Leave an explicit cooperative turn for primary propagation before the unchanged hard guard.
  const diagnosticCutoff = deadline - 100
  const id = crypto.randomUUID(), failures = [], stages = []
  const bounded = async (stage, work) => {
    const end = Math.min(diagnosticCutoff, Date.now() + 500), controller = new AbortController()
    const status = { stage, outcome: "pending" }; stages.push(status)
    if (end <= Date.now()) {
      status.outcome = "not-started: original clock reserve reached; outcome/cleanup UNKNOWN"
      throw new Error("Inbox " + stage + " not attempted: original clock reserve reached; outcome and cleanup UNKNOWN")
    }
    let timer, timeoutError
    try {
      return await Promise.race([
        Promise.resolve().then(() => work({ signal: controller.signal, deadline: end })).then(value => {
          if (timeoutError) { timeoutError.lateOutcome = "fulfilled"; return }
          status.outcome = "fulfilled"; return value
        }, error => {
          if (timeoutError) { timeoutError.lateOutcome = "rejected"; timeoutError.lateFailure = error; return }
          status.outcome = "rejected"; throw error
        }),
        new Promise((_, reject) => { timer = setTimeout(() => {
          status.outcome = "timed-out: outcome unknown"
          timeoutError = new Error("Inbox " + stage + " exceeded diagnostic/original deadline; outcome and cleanup UNKNOWN")
          timeoutError.lateOutcome = "pending"; reject(timeoutError); controller.abort(timeoutError)
        }, Math.max(0, end - Date.now())) }),
      ])
    } finally { clearTimeout(timer) }
  }
  let primary = { kind: "returned" }
  try {
    await bounded("setup", async ({ deadline: setupDeadline }) => {
      const lease = JSON.stringify({ id, deadline, setupDeadline })
      const result = await evaluate(`Promise.all([import('/src/state/acp.ts'), import('/src/state/session.ts'), import('/src/state/viewer.ts'), import('/src/state/thread-groups.ts'), import('/src/state/thread-store.ts'), import('/src/state/window-routes.ts'), import('/src/state/tabs.ts'), import('/scripts/lib/inbox-boundary-evidence.mjs')]).then(([{acp,acpStore},{store},{viewerStore},{threadGroupsStore,rowThread},{threadsStore},{windowRoutesStore},{tabsStore},{prepareInboxBoundaryProbe}]) => prepareInboxBoundaryProbe({acp,acpStore,store,viewerStore,threadGroupsStore,threadsStore,windowRoutesStore,tabsStore,rowThread}, ${lease}))`)
      if (!z.object({ installed: z.literal(true), id: z.literal(id) }).strict().safeParse(result).success) throw new Error("Inbox probe installation receipt missing or foreign")
    })
    try { await operation() } catch (value) { primary = { kind: "threw", value } }
  } catch (error) { failures.push(error) }
  let evidence
  try {
    evidence = BoundaryEvidence.parse(await bounded("finish", ({ deadline: finishDeadline }) => evaluate(`(() => { if (Date.now() >= ${finishDeadline}) throw new Error('Inbox finish lease expired; cleanup UNKNOWN'); const probe = window.inboxBoundaryProbe; if (probe?.id !== ${JSON.stringify(id)}) throw new Error('Inbox probe missing/foreign; cleanup UNKNOWN'); return probe.finish() })()`)))
  } catch (error) { failures.push(error) }
  if (evidence && !evidence.complete) failures.push(new Error("Inbox boundary evidence is incomplete; inspect bounds/dropped/unavailable/cleanup"))
  // Even a failed/unknown finish gets one independent bounded publication attempt. Never retry a write.
  const payload = { capture: evidence ?? null, complete: evidence?.complete === true && failures.length === 0,
    boundaryOutcome: primary.kind, diagnosticStages: stages, captureOutcome: evidence ? "observed" : "UNKNOWN", cleanupOutcome: evidence ? "observed" : "UNKNOWN" }
  try { await bounded("record", options => record(payload, options)) } catch (error) { failures.push(error) }
  const errors = primary.kind === "threw" ? [primary.value, ...failures] : failures
  if (errors.length === 1) throw errors[0]
  if (errors.length > 1) throw new AggregateError(errors, "Inbox boundary and evidence capture failed", { cause: errors[0] })
}
