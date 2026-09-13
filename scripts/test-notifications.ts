import assert from "node:assert/strict"
import {
  attentionLabel,
  excerpt,
  plainText,
  summaryNotification,
} from "../src/lib/notification-text.ts"
import {
  BURST_SETTLE_MS,
  BURST_SUMMARY_FROM,
  SUMMARY_SUBJECT,
  decideDelivery,
  flushNotificationBursts,
  installNotificationEnvironment,
  markAllSeen,
  nextUnseen,
  noteOutcome,
  notificationsStore,
  reconcileVisible,
  retireSubject,
  subjectId,
  unseenCounts,
  unseenItems,
  unseenSubjects,
  type NotificationEnvironment,
  type NotificationItem,
  type NotificationSubject,
} from "../src/state/notifications.ts"
import { lastReplyText, syncThreadStatus } from "../src/state/acp-live.ts"
import type { LiveAcpConversation } from "../src/state/acp-state.ts"
import { prefsStore, setPref } from "../src/state/prefs.ts"
import { applyThreadActivity, threadsStore } from "../src/state/threads.ts"
import {
  DELIVERY_GRACE_MS,
  badgeLabel,
  createDesktopNotifier,
  type NativeNotificationHandle,
} from "../electron/desktop-notifications.ts"
import { parseAuthorizationReadout } from "../electron/notification-authorization.ts"

/* ------------------------------------------------------------------ */
/* Copy                                                                 */
/* ------------------------------------------------------------------ */

assert.equal(
  plainText("## Done\n\n- **Fixed** the `parser` in [reconcile](x.ts)\n> quoted"),
  "Done\n\nFixed the parser in reconcile\nquoted"
)
assert.equal(
  excerpt("```ts\nconst a = 1\n```\n\nSecond paragraph"),
  "const a = 1",
  "the first paragraph keeps code contents and drops the fence"
)
assert.equal(excerpt("   \n\nOnly   spaced\ttext here\n\nmore"), "Only spaced text here")
const long = `${"word ".repeat(60)}end`
const cut = excerpt(long)
assert.ok(cut.length <= 201 && cut.endsWith("…") && !cut.includes("  "))
assert.equal(excerpt(""), "")
assert.equal(attentionLabel({ ask: 1, failed: 0, ready: 3 }), "1 thread needs you")
assert.equal(attentionLabel({ ask: 1, failed: 1, ready: 0 }), "2 threads need you")
assert.equal(attentionLabel({ ask: 0, failed: 0, ready: 1 }), "1 answer ready")
assert.equal(attentionLabel({ ask: 0, failed: 0, ready: 4 }), "4 answers ready")
assert.deepEqual(
  summaryNotification([
    { kind: "ready", title: "a" },
    { kind: "ready", title: "b" },
    { kind: "ready", title: "c" },
    { kind: "ready", title: "d" },
    { kind: "ready", title: "e" },
  ]),
  { title: "5 answers ready", body: "a, b, c, d and 1 more" }
)
assert.equal(
  summaryNotification([
    { kind: "ask", title: "a" },
    { kind: "ready", title: "b" },
  ]).title,
  "2 threads need you"
)

/* ------------------------------------------------------------------ */
/* Policy                                                               */
/* ------------------------------------------------------------------ */

const allOn = { notifyDesktop: true, notifyReady: true, notifyAsk: true, notifyFailed: true }
assert.deepEqual(
  decideDelivery({ kind: "ready", visible: true, focused: true, quiet: false, prefs: allOn }),
  { seen: true, channels: ["cue"] },
  "watching the thread: seen, one cue"
)
assert.deepEqual(
  decideDelivery({ kind: "ready", visible: false, focused: true, quiet: false, prefs: allOn }),
  { seen: false, channels: ["toast", "cue"] },
  "another thread on screen: a toast, never a banner"
)
assert.deepEqual(
  decideDelivery({ kind: "ready", visible: true, focused: false, quiet: false, prefs: allOn }),
  { seen: false, channels: ["desktop"] },
  "the thread is on screen but the window is not in front: a banner"
)
assert.deepEqual(
  decideDelivery({ kind: "ask", visible: false, focused: false, quiet: false, prefs: allOn }),
  { seen: false, channels: ["desktop"] }
)
assert.deepEqual(
  decideDelivery({
    kind: "ready",
    visible: false,
    focused: false,
    quiet: false,
    prefs: { ...allOn, notifyDesktop: false },
  }),
  { seen: false, channels: ["toast"] },
  "banners off: the toast waits for your return"
)
assert.deepEqual(
  decideDelivery({ kind: "failed", visible: false, focused: true, quiet: false, prefs: allOn }),
  { seen: false, channels: [] },
  "a failure is never toasted here; the run's own error toast already spoke"
)
assert.deepEqual(
  decideDelivery({ kind: "ready", visible: false, focused: false, quiet: true, prefs: allOn }),
  { seen: false, channels: [] },
  "a hydration replay is recorded, never announced"
)
assert.deepEqual(
  decideDelivery({
    kind: "ask",
    visible: false,
    focused: false,
    quiet: false,
    prefs: { ...allOn, notifyAsk: false },
  }),
  { seen: false, channels: [] },
  "a muted kind still counts, silently"
)

/* ------------------------------------------------------------------ */
/* The centre, against a fake platform                                  */
/* ------------------------------------------------------------------ */

interface FakeDesktop {
  id: string
  subject: string
  title: string
  subtitle: string
  body: string
}

interface FakeLog {
  cues: number
  toasts: NotificationItem[]
  dismissedToasts: string[]
  desktop: FakeDesktop[]
  dismissedDesktop: string[]
  badges: number[]
  opened: NotificationSubject[]
}

function fakeEnvironment() {
  const visible = new Set<string>()
  let focused = true
  let now = 1_000
  const log: FakeLog = {
    cues: 0,
    toasts: [],
    dismissedToasts: [],
    desktop: [],
    dismissedDesktop: [],
    badges: [],
    opened: [],
  }
  let deliver = true
  const timers: Array<{ at: number; run: () => void; cancelled: boolean }> = []
  const env: NotificationEnvironment = {
    visibleSubjects: () => visible,
    focused: () => focused,
    now: () => now,
    cue: () => {
      log.cues += 1
    },
    toast: (item) => {
      log.toasts.push(item)
    },
    dismissToast: (id) => {
      log.dismissedToasts.push(id)
    },
    desktop: async (notification) => {
      log.desktop.push(notification)
      return deliver
    },
    dismissDesktop: (subject) => {
      log.dismissedDesktop.push(subject)
    },
    badge: (count) => {
      log.badges.push(count)
    },
    schedule: (run, ms) => {
      const timer = { at: now + ms, run, cancelled: false }
      timers.push(timer)
      return () => {
        timer.cancelled = true
      }
    },
    open: (subject) => {
      log.opened.push(subject)
    },
    announces: () => true,
  }
  return {
    env,
    log,
    visible,
    setFocused: (next: boolean) => {
      focused = next
    },
    setDeliver: (next: boolean) => {
      deliver = next
    },
    advance: async (ms: number) => {
      now += ms
      for (const timer of timers.splice(0)) if (!timer.cancelled && timer.at <= now) timer.run()
      await new Promise((resolve) => setImmediate(resolve))
    },
  }
}

function subjectFor(path: string, title = path): NotificationSubject {
  return {
    id: subjectId({ kind: "thread", path }),
    target: { kind: "thread", path },
    title,
    agent: "Claude Code",
    workspace: "pi-ui",
  }
}

function reset() {
  notificationsStore.set({ items: [], permission: "default", focused: true })
}

{
  reset()
  const fake = fakeEnvironment()
  const uninstall = installNotificationEnvironment(fake.env)
  assert.deepEqual(fake.log.badges, [0], "binding paints the badge once, at zero")

  // Watching the thread: seen at once, one cue, no badge.
  fake.visible.add("thread:/a")
  noteOutcome({ kind: "ready", subject: subjectFor("/a"), marker: "t1", detail: "**Done.**\n\nMore" })
  assert.equal(fake.log.cues, 1)
  assert.equal(unseenSubjects(notificationsStore.get().items).length, 0)
  assert.equal(notificationsStore.get().items[0]?.body, "Done.")
  assert.deepEqual(fake.log.badges, [0])

  // Same fact twice is one item.
  noteOutcome({ kind: "ready", subject: subjectFor("/a"), marker: "t1" })
  assert.equal(notificationsStore.get().items.length, 1)

  // Another thread while Mako is in front: a toast, and the badge counts it.
  noteOutcome({ kind: "ready", subject: subjectFor("/b", "Rail ranks"), marker: "t1" })
  assert.equal(fake.log.toasts.length, 1)
  assert.equal(fake.log.cues, 2)
  assert.deepEqual(fake.log.badges, [0, 1])
  assert.equal(attentionLabel(unseenCounts(notificationsStore.get().items)), "1 answer ready")

  // Away from the window: a banner, after the burst settles.
  fake.setFocused(false)
  noteOutcome({ kind: "ask", subject: subjectFor("/c", "Migrate schema"), marker: "perm-1", detail: "Run npm test?" })
  assert.equal(fake.log.desktop.length, 0, "banners wait for the burst window")
  await fake.advance(BURST_SETTLE_MS)
  assert.equal(fake.log.desktop.length, 1)
  assert.deepEqual(fake.log.desktop[0], {
    id: "thread:/c:ask:perm-1",
    subject: "thread:/c",
    title: "Migrate schema",
    subtitle: "Claude Code needs you · pi-ui",
    body: "Run npm test?",
  })
  assert.equal(attentionLabel(unseenCounts(notificationsStore.get().items)), "1 thread needs you")
  assert.deepEqual(fake.log.badges, [0, 1, 2])
  assert.equal(nextUnseen()?.subject.id, "thread:/c", "asks come first")

  // A burst of many becomes one banner naming them.
  for (let index = 0; index < BURST_SUMMARY_FROM; index += 1)
    noteOutcome({ kind: "ready", subject: subjectFor(`/burst-${index}`, `Burst ${index}`), marker: "t1" })
  await fake.advance(BURST_SETTLE_MS)
  assert.equal(fake.log.desktop.length, 2)
  assert.equal(fake.log.desktop[1]?.subject, SUMMARY_SUBJECT)
  assert.equal(fake.log.desktop[1]?.title, `${BURST_SUMMARY_FROM} answers ready`)
  assert.equal(unseenSubjects(notificationsStore.get().items).length, 2 + BURST_SUMMARY_FROM)

  // Coming back to the thread with the ask on screen clears it, and its banner.
  fake.visible.clear()
  fake.visible.add("thread:/c")
  fake.setFocused(true)
  reconcileVisible()
  assert.equal(notificationsStore.get().items.find((item) => item.subject.id === "thread:/c")?.seen, true)
  assert.ok(fake.log.dismissedDesktop.includes("thread:/c"))
  assert.ok(fake.log.dismissedToasts.includes("thread:/c"))

  // A thread that starts again retires what it had waiting.
  retireSubject("thread:/b")
  assert.equal(notificationsStore.get().items.some((item) => item.subject.id === "thread:/b"), false)
  assert.ok(fake.log.dismissedToasts.includes("thread:/b"))

  // Opening from the list marks it seen and jumps.
  const next = unseenItems(notificationsStore.get().items)[0]!
  assert.equal(next.kind, "ready")
  markAllSeen()
  assert.equal(unseenSubjects(notificationsStore.get().items).length, 0)
  assert.equal(fake.log.badges.at(-1), 0)
  assert.ok(fake.log.dismissedDesktop.includes(SUMMARY_SUBJECT))

  // The badge preference turns the count off without losing the items.
  noteOutcome({ kind: "ready", subject: subjectFor("/d"), marker: "t1" })
  await fake.advance(BURST_SETTLE_MS)
  assert.equal(fake.log.badges.at(-1), 1)
  setPref("badgeCount", false)
  assert.equal(fake.log.badges.at(-1), 0)
  setPref("badgeCount", true)
  assert.equal(fake.log.badges.at(-1), 1)

  // A banner the platform refuses falls back to a toast.
  fake.setDeliver(false)
  const toastsBefore = fake.log.toasts.length
  noteOutcome({ kind: "ready", subject: subjectFor("/e"), marker: "t1" })
  await fake.advance(BURST_SETTLE_MS)
  assert.equal(fake.log.toasts.length, toastsBefore + 1)
  fake.setDeliver(true)

  // A retired kind leaves the thread's other items alone.
  noteOutcome({ kind: "ask", subject: subjectFor("/f"), marker: "perm-9" })
  noteOutcome({ kind: "ready", subject: subjectFor("/f"), marker: "t9" })
  const dismissedBefore = fake.log.dismissedDesktop.length
  retireSubject("thread:/f", "ask")
  const remaining = notificationsStore.get().items.filter((item) => item.subject.id === "thread:/f")
  assert.deepEqual(remaining.map((item) => item.kind), ["ready"])
  assert.equal(fake.log.dismissedDesktop.length, dismissedBefore, "a partial retire keeps the banner")

  flushNotificationBursts()
  uninstall()
}

/* ------------------------------------------------------------------ */
/* Live conversations: transitions, not states                          */
/* ------------------------------------------------------------------ */

function liveConversation(overrides: Partial<LiveAcpConversation> = {}): LiveAcpConversation {
  return {
    kind: "live",
    key: "live-1",
    draftKey: "live-1",
    harness: "claude",
    cwd: "/Users/kashyab/pi-ui",
    title: "Notifications",
    threadPath: "/sessions/live-1.jsonl",
    blocks: [],
    queued: [],
    hiddenUserPrompt: null,
    createdAt: 1,
    updatedAt: 2,
    revision: 7,
    session: {
      connection: "connected",
      id: "live-1",
      harness: "claude",
      cwd: "/Users/kashyab/pi-ui",
      status: "ready",
      modes: [],
      currentMode: null,
      configOptions: [],
    },
    permission: null,
    sending: false,
    canceling: false,
    ...overrides,
  }
}

assert.equal(
  lastReplyText([
    { type: "user", text: "first" },
    { type: "text", text: "old" },
    { type: "user", text: "second" },
    { type: "thinking", text: "hmm" },
    { type: "text", text: "Part one." },
    { type: "tool", id: "t", title: "bash", status: "completed" },
    { type: "text", text: "Part two." },
  ]),
  "Part one.\n\nPart two.",
  "the reply is every text block since the last prompt"
)

{
  reset()
  const fake = fakeEnvironment()
  fake.setFocused(false)
  const uninstall = installNotificationEnvironment(fake.env)

  // running → ready with a reply: one "ready" for the bound thread.
  syncThreadStatus(
    liveConversation({ blocks: [{ type: "user", text: "go" }, { type: "text", text: "All green." }] }),
    "running"
  )
  const ready = notificationsStore.get().items
  assert.equal(ready.length, 1)
  assert.equal(ready[0]?.kind, "ready")
  assert.equal(ready[0]?.subject.id, "thread:/sessions/live-1.jsonl")
  assert.equal(ready[0]?.subject.agent, "Claude Code")
  assert.equal(ready[0]?.body, "All green.")

  // A stopped turn is not an answer.
  syncThreadStatus(
    liveConversation({ revision: 8, session: { ...liveConversation().session, lastStop: "cancelled" } }),
    "running"
  )
  assert.equal(notificationsStore.get().items.length, 1)

  // A new turn retires the unread answer; a permission mid-turn asks once.
  const running = liveConversation({
    revision: 9,
    session: { ...liveConversation().session, status: "running" },
  })
  syncThreadStatus(running, "ready")
  assert.equal(unseenSubjects(notificationsStore.get().items).length, 0)
  const asking = liveConversation({
    revision: 10,
    session: { ...liveConversation().session, status: "running" },
    permission: { id: "perm-1", sessionId: "live-1", title: "Run npm test", options: [] },
  })
  syncThreadStatus(asking, "running")
  syncThreadStatus(asking, "running")
  const asks = notificationsStore.get().items.filter((item) => item.kind === "ask")
  assert.equal(asks.length, 1)
  assert.equal(asks[0]?.body, "Run npm test")

  // Answering it retires the ask without touching anything else.
  syncThreadStatus(liveConversation({ revision: 11, session: { ...liveConversation().session, status: "running" } }), "running")
  assert.equal(notificationsStore.get().items.some((item) => item.kind === "ask" && !item.seen), false)

  // Hydration replays record without announcing.
  const before = fake.log.desktop.length
  syncThreadStatus(
    liveConversation({
      key: "live-2",
      threadPath: undefined,
      revision: 12,
      session: { ...liveConversation().session, id: "live-2", status: "running" },
      permission: { id: "perm-2", sessionId: "live-2", title: "Edit files?", options: [] },
    }),
    "starting",
    undefined,
    "hydrate"
  )
  await fake.advance(BURST_SETTLE_MS)
  assert.equal(fake.log.desktop.length, before, "no banner for a replay")
  const replayed = notificationsStore.get().items.find((item) => item.subject.id === "live:live-2")
  assert.equal(replayed?.kind, "ask")
  assert.equal(replayed?.seen, false, "but it still counts")

  // A failure while away is a banner.
  syncThreadStatus(
    liveConversation({ revision: 13, session: { ...liveConversation().session, status: "failed", error: "Provider exited" } }),
    "running"
  )
  await fake.advance(BURST_SETTLE_MS)
  assert.equal(fake.log.desktop.at(-1)?.subtitle, "Claude Code failed · pi-ui")
  assert.equal(fake.log.desktop.at(-1)?.body, "Provider exited")

  flushNotificationBursts()
  uninstall()
}

/* ------------------------------------------------------------------ */
/* Activity in another app is an outcome too                            */
/* ------------------------------------------------------------------ */

{
  reset()
  const fake = fakeEnvironment()
  fake.setFocused(false)
  const uninstall = installNotificationEnvironment(fake.env)
  threadsStore.set({
    threads: [{ harness: "claude", nativeId: "n1", path: "/ext/a.jsonl", title: "Terminal run", cwd: "/repo" }],
    externalActivity: {},
  })
  applyThreadActivity("/ext/a.jsonl", { provider: "claude", since: 10, status: "active" })
  assert.equal(notificationsStore.get().items.length, 0, "starting says nothing")
  applyThreadActivity("/ext/a.jsonl", {
    provider: "claude",
    since: 20,
    status: "needs-input",
    detail: "Allow Bash(npm test)?",
  })
  applyThreadActivity("/ext/a.jsonl", { provider: "claude", since: 20, status: "needs-input", detail: "Allow Bash(npm test)?" })
  const asks = notificationsStore.get().items.filter((item) => item.kind === "ask")
  assert.equal(asks.length, 1, "one ask per registry transition")
  assert.equal(asks[0]?.subject.title, "Terminal run")
  assert.equal(asks[0]?.subject.agent, "Claude Code")
  assert.equal(asks[0]?.body, "Allow Bash(npm test)?")
  applyThreadActivity("/ext/a.jsonl", { provider: "claude", since: 30, status: "active" })
  assert.equal(
    notificationsStore.get().items.some((item) => item.kind === "ask" && !item.seen),
    false,
    "answering in the terminal retires the ask"
  )
  applyThreadActivity("/ext/a.jsonl", { provider: "claude", since: 40, status: "open" })
  const ready = notificationsStore.get().items.filter((item) => item.kind === "ready")
  assert.equal(ready.length, 1, "working then open is a finished turn")
  assert.equal(ready[0]?.body, "Answer ready to read.")
  applyThreadActivity("/ext/a.jsonl", { provider: "claude", since: 50, status: "active" })
  applyThreadActivity("/ext/a.jsonl", null)
  assert.equal(
    notificationsStore.get().items.filter((item) => item.kind === "ready").length,
    0,
    "a process that vanished mid-turn is not an answer, and the new turn retired the old one"
  )
  flushNotificationBursts()
  uninstall()
  threadsStore.set({ threads: [], externalActivity: {} })
}

/* ------------------------------------------------------------------ */
/* The platform side: one banner per thread, retained until it reports  */
/* ------------------------------------------------------------------ */

assert.equal(badgeLabel(0), "")
assert.equal(badgeLabel(3), "3")
assert.equal(badgeLabel(140), "99+")
assert.equal(badgeLabel(-2), "")

assert.equal(parseAuthorizationReadout('{"authorization":"authorized","alert":"enabled","alertStyle":"banner"}'), "granted")
assert.equal(
  parseAuthorizationReadout('{"authorization":"authorized","alert":"enabled","alertStyle":"none"}'),
  "denied",
  "authorized with no alert style shows nothing"
)
assert.equal(parseAuthorizationReadout('{"authorization":"denied","alert":"disabled"}'), "denied")
assert.equal(parseAuthorizationReadout('{"authorization":"not-determined","alert":"not-supported","alertStyle":"banner"}'), "default")
assert.equal(parseAuthorizationReadout('{"authorization":"timeout","alert":"unknown"}'), null)
assert.equal(parseAuthorizationReadout('{"authorization":"weird","alert":"enabled"}'), null)

{
  interface FakeHandle extends NativeNotificationHandle {
    title: string
    body: string
    closed: boolean
    fire(event: "click" | "close" | "failed" | "show"): void
  }
  const handles: FakeHandle[] = []
  const badges: Array<[number, string]> = []
  const activations: Array<{ windowId: number; id: string; subject: string }> = []
  const timers: Array<{ ms: number; run: () => void; cancelled: boolean }> = []
  let supported = true
  let signed = true
  let readout: "granted" | "denied" | "default" | null = null
  const notifier = createDesktopNotifier({
    platform: "linux",
    get signed() {
      return signed
    },
    supported: () => supported,
    create: (options) => {
      const listeners = new Map<string, () => void>()
      const handle: FakeHandle = {
        title: options.title,
        body: options.body,
        closed: false,
        show: () => {},
        close: () => {
          handle.closed = true
        },
        on: (event, listener) => {
          listeners.set(event, listener)
        },
        fire: (event) => listeners.get(event)?.(),
      }
      handles.push(handle)
      return handle
    },
    activate: (windowId, activation) => {
      activations.push({ windowId, ...activation })
    },
    setBadge: (count, label) => {
      badges.push([count, label])
    },
    authorization: async () => readout,
    schedule: (run, ms) => {
      const timer = { ms, run, cancelled: false }
      timers.push(timer)
      return () => {
        timer.cancelled = true
      }
    },
  })
  const fireGrace = () => {
    for (const timer of timers.splice(0)) if (!timer.cancelled) timer.run()
  }

  const first = notifier.notify(7, {
    id: "n1",
    subject: "thread:/a",
    title: "Rail",
    subtitle: "Claude Code finished · pi-ui",
    body: "Done.",
    silent: true,
  })
  assert.equal(handles[0]?.body, "Claude Code finished · pi-ui\nDone.", "off macOS the subtitle folds into the body")
  handles[0]!.fire("show")
  assert.deepEqual(await first, { delivered: true }, "shown means delivered")

  const second = notifier.notify(7, { id: "n2", subject: "thread:/a", title: "Rail", body: "Question?", silent: true })
  assert.equal(handles[0]?.closed, true, "a new banner for the same thread replaces the old one")
  assert.equal(handles.length, 2)
  assert.equal(timers.length, 2, "an unanswered show waits on the grace timer")
  fireGrace()
  assert.deepEqual(await second, { delivered: true }, "a platform that says nothing within the grace is believed")

  handles[1]!.fire("click")
  assert.deepEqual(activations, [{ windowId: 7, id: "n2", subject: "thread:/a" }])
  notifier.dismiss("thread:/a")
  assert.equal(handles[1]?.closed, false, "a clicked banner is already released; dismiss finds nothing")

  const third = notifier.notify(7, { id: "n3", subject: "thread:/b", title: "B", body: "x", silent: false })
  notifier.dismiss("thread:/b")
  assert.equal(handles[2]?.closed, true)
  handles[2]!.fire("close")
  await third

  const refused = notifier.notify(7, { id: "n4", subject: "thread:/c", title: "C", body: "x", silent: false })
  handles[3]!.fire("failed")
  assert.deepEqual(await refused, { delivered: false, reason: "denied" }, "macOS refuses after show(); the answer waits for it")
  assert.equal(await notifier.permission(), "denied", "without a readout, the last delivery is the evidence")
  const shown = notifier.notify(7, { id: "n5", subject: "thread:/c", title: "C", body: "x", silent: false })
  handles[4]!.fire("show")
  await shown
  assert.equal(await notifier.permission(), "granted")
  readout = "default"
  assert.equal(await notifier.permission(), "default", "the helper's readout outranks delivery evidence")
  readout = null

  notifier.setBadgeCount(2)
  notifier.setBadgeCount(2)
  notifier.setBadgeCount(0)
  notifier.setBadgeCount(250)
  assert.deepEqual(badges, [[2, "2"], [0, ""], [250, "99+"]], "badge writes are deduplicated and capped")

  supported = false
  assert.deepEqual(
    await notifier.notify(7, { id: "n6", subject: "thread:/d", title: "D", body: "x", silent: false }),
    { delivered: false, reason: "unsupported" }
  )
  assert.equal(await notifier.permission(), "unsupported")
  supported = true

  notifier.dispose()
  assert.equal(handles[4]?.closed, true, "dispose closes what is still showing")
  assert.deepEqual(badges.at(-1), [0, ""])

  signed = false
  const mac = createDesktopNotifier({
    platform: "darwin",
    signed: false,
    supported: () => true,
    create: () => {
      throw new Error("must not be reached")
    },
    activate: () => {},
    setBadge: () => {},
    authorization: async () => null,
    schedule: () => () => {},
  })
  assert.deepEqual(
    await mac.notify(1, { id: "n7", subject: "thread:/e", title: "E", body: "x", silent: true }),
    { delivered: false, reason: "unsigned" },
    "an unsigned macOS checkout never reaches the platform"
  )
  assert.equal(await mac.permission(), "unsigned")
  assert.ok(timers.every((timer) => timer.cancelled), "every settled banner released its grace timer")
  assert.ok(DELIVERY_GRACE_MS > 0)
}

reset()
prefsStore.set({ badgeCount: true })
console.log(
  "Notifications: excerpts, policy by thread visibility, burst summaries, retire on restart, hydration replays, live and external transitions, the authorization readout, honest delivery, and one banner per thread verified"
)
