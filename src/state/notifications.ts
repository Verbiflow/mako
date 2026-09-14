import { toast } from "sonner"
import { getMako, hasBridge } from "@/lib/bridge"
import { ACTION_TOAST_MS } from "@/lib/toast-duration"
import type { NotificationPermission } from "@/lib/types"
import {
  excerpt,
  notificationFallbackBody,
  notificationHeadline,
  summaryNotification,
  type NotificationKind,
} from "@/lib/notification-text"
import { workspaceName } from "@/lib/format"
import { playFeedback } from "@/state/feedback"
import { prefsStore, type Prefs } from "@/state/prefs"
import { createHook, createStore } from "@/state/store"

/**
 * The attention centre: what happened while you were not looking.
 *
 * Every provider's outcomes arrive here as one of three kinds — an answer is
 * ready, the agent needs you, the run failed — keyed by the thread they are
 * about. The centre decides, per outcome, whether you already saw it and
 * which channel reaches you: a cue when the thread is in front of you, an
 * in-app card when Mako is in front but the thread is not, a desktop banner
 * when Mako is not. The unseen items are the badge on the app icon and the
 * "2 threads need you" pill in the titlebar; opening the thread clears them.
 *
 * Rules that keep this quiet:
 *
 * - Outcomes are transitions, never states. A permission carries its id, a
 *   turn its end; the same fact twice is one item.
 * - A thread that starts working again retires its unseen items: the reply
 *   you did not read is the one you just answered.
 * - Hydration replays are recorded, never announced. A reconnect must not
 *   re-ring every banner you already lived through.
 * - Banners in a burst are one banner. Four threads finishing together are
 *   one fact with four names.
 * - Everything counts threads, not events.
 */
export type NotificationTarget =
  | { kind: "thread"; path: string }
  | { kind: "live"; key: string }
  | { kind: "tab"; id: string }

export interface NotificationSubject {
  /** `thread:<path>`, `live:<key>`, or `tab:<id>`. */
  id: string
  target: NotificationTarget
  title: string
  /** The provider's display name. */
  agent: string
  workspace?: string
}

export interface AttentionOutcome {
  kind: NotificationKind
  subject: NotificationSubject
  /** What makes this outcome distinct from the last: a permission id, a turn end. */
  marker: string
  /** The reply, the question, or the error, in markdown; excerpted here. */
  detail?: string
  /** Record without announcing: a replay of state the user already lived through. */
  quiet?: boolean
}

export interface NotificationItem {
  id: string
  kind: NotificationKind
  subject: NotificationSubject
  body: string
  at: number
  seen: boolean
}

export interface NotificationsState {
  /** Newest first, bounded. */
  items: NotificationItem[]
  permission: NotificationPermission
  /** This window has keyboard focus and is visible. */
  focused: boolean
}

export type NotificationChannel = "cue" | "toast" | "desktop"

export interface DeliveryDecision {
  seen: boolean
  channels: NotificationChannel[]
}

export const NOTIFICATION_LIMIT = 200
/** How long a burst of desktop banners waits to become one. */
export const BURST_SETTLE_MS = 600
/** More than this many banners in a burst collapse into a summary. */
export const BURST_SUMMARY_FROM = 4
export const SUMMARY_SUBJECT = "mako:summary"

export function subjectId(target: NotificationTarget): string {
  switch (target.kind) {
    case "thread":
      return `thread:${target.path}`
    case "live":
      return `live:${target.key}`
    case "tab":
      return `tab:${target.id}`
  }
}

export const notificationsStore = createStore<NotificationsState>({
  items: [],
  permission: "default",
  focused: true,
})
export const useNotifications = createHook(notificationsStore)

/** Distinct threads with something unseen — what the badge counts. */
export function unseenSubjects(items: readonly NotificationItem[]): string[] {
  const subjects: string[] = []
  for (const item of items)
    if (!item.seen && !subjects.includes(item.subject.id)) subjects.push(item.subject.id)
  return subjects
}

/** Newest unseen item per thread, most urgent first: asks, failures, answers. */
export function unseenItems(items: readonly NotificationItem[]): NotificationItem[] {
  const latest = new Map<string, NotificationItem>()
  for (const item of items)
    if (!item.seen && !latest.has(item.subject.id)) latest.set(item.subject.id, item)
  const rank = { ask: 0, failed: 1, ready: 2 } satisfies Record<NotificationKind, number>
  return [...latest.values()].sort(
    (left, right) => rank[left.kind] - rank[right.kind] || right.at - left.at
  )
}

type NotifyPrefs = Pick<Prefs, "notifyDesktop" | "notifyReady" | "notifyAsk" | "notifyFailed">

function kindEnabled(prefs: NotifyPrefs, kind: NotificationKind): boolean {
  switch (kind) {
    case "ready":
      return prefs.notifyReady
    case "ask":
      return prefs.notifyAsk
    case "failed":
      return prefs.notifyFailed
  }
}

/**
 * The policy, as a pure function. `visible` is the thread on screen; `focused`
 * is the window in front. Both true means you watched it happen. A failure is
 * never toasted here: the run's own error toast already says what broke.
 */
export function decideDelivery(input: {
  kind: NotificationKind
  visible: boolean
  focused: boolean
  quiet: boolean
  prefs: NotifyPrefs
}): DeliveryDecision {
  const watched = input.visible && input.focused
  if (input.quiet) return { seen: watched, channels: [] }
  if (!kindEnabled(input.prefs, input.kind)) {
    return { seen: watched, channels: watched && input.kind !== "failed" ? ["cue"] : [] }
  }
  if (watched) return { seen: true, channels: input.kind === "failed" ? [] : ["cue"] }
  if (input.focused) {
    return { seen: false, channels: input.kind === "failed" ? [] : ["toast", "cue"] }
  }
  if (input.prefs.notifyDesktop) return { seen: false, channels: ["desktop"] }
  return { seen: false, channels: input.kind === "failed" ? [] : ["toast"] }
}

/* ------------------------------------------------------------------ */
/* Environment: what is on screen, and what the platform offers         */
/* ------------------------------------------------------------------ */

export interface NotificationEnvironment {
  /** Subject ids the user can see right now, on the conversation stage. */
  visibleSubjects(): ReadonlySet<string>
  focused(): boolean
  now(): number
  cue(): void
  toast(item: NotificationItem, open: () => void): void
  dismissToast(subjectId: string): void
  desktop(notification: {
    id: string
    subject: string
    title: string
    subtitle: string
    body: string
  }): Promise<boolean>
  dismissDesktop(subject: string): void
  badge(count: number): void
  schedule(run: () => void, ms: number): () => void
  open(subject: NotificationSubject): void
  /** Previews and side windows observe; only the desk announces. */
  announces(): boolean
}

let environment: NotificationEnvironment | null = null

/** Bind a platform; tests bind a fake one. Returns the unbind. */
export function installNotificationEnvironment(next: NotificationEnvironment): () => void {
  environment = next
  syncBadge()
  return () => {
    if (environment === next) environment = null
  }
}

/* ------------------------------------------------------------------ */
/* Outcomes in                                                          */
/* ------------------------------------------------------------------ */

interface PendingBanner {
  item: NotificationItem
}
let burst: PendingBanner[] = []
let cancelBurst: (() => void) | null = null

export function noteOutcome(outcome: AttentionOutcome): NotificationItem | null {
  const env = environment
  const id = `${outcome.subject.id}:${outcome.kind}:${outcome.marker}`
  const state = notificationsStore.get()
  if (state.items.some((item) => item.id === id)) return null
  const prefs = prefsStore.get()
  const decision = decideDelivery({
    kind: outcome.kind,
    visible: env?.visibleSubjects().has(outcome.subject.id) ?? false,
    focused: env?.focused() ?? state.focused,
    quiet: outcome.quiet === true || !env?.announces(),
    prefs,
  })
  const body =
    (outcome.detail ? excerpt(outcome.detail) : "") ||
    notificationFallbackBody(outcome.kind)
  const item: NotificationItem = {
    id,
    kind: outcome.kind,
    subject: outcome.subject,
    body,
    at: env?.now() ?? Date.now(),
    seen: decision.seen,
  }
  // One item per thread and kind on the unseen list; an older unseen item of
  // the same kind is superseded, not stacked.
  const kept = state.items.filter(
    (existing) =>
      existing.seen || existing.subject.id !== item.subject.id || existing.kind !== item.kind
  )
  notificationsStore.set({ items: [item, ...kept].slice(0, NOTIFICATION_LIMIT) })
  if (!env) return item
  for (const channel of decision.channels) {
    if (channel === "cue") env.cue()
    else if (channel === "toast") env.toast(item, () => openItem(item))
    else queueBanner(item)
  }
  return item
}

function queueBanner(item: NotificationItem) {
  const env = environment
  if (!env) return
  burst = [...burst.filter((pending) => pending.item.subject.id !== item.subject.id), { item }]
  cancelBurst?.()
  cancelBurst = env.schedule(flushBanners, BURST_SETTLE_MS)
}

function flushBanners() {
  const env = environment
  cancelBurst = null
  const pending = burst
  burst = []
  if (!env || pending.length === 0) return
  if (pending.length >= BURST_SUMMARY_FROM) {
    const summary = summaryNotification(
      pending.map(({ item }) => ({ kind: item.kind, title: item.subject.title }))
    )
    void env
      .desktop({
        id: `${SUMMARY_SUBJECT}:${pending[0]!.item.at}`,
        subject: SUMMARY_SUBJECT,
        title: summary.title,
        subtitle: "Mako",
        body: summary.body,
      })
      .then((delivered) => {
        if (!delivered) for (const { item } of pending) env.toast(item, () => openItem(item))
      })
    return
  }
  for (const { item } of pending) {
    void env
      .desktop({
        id: item.id,
        subject: item.subject.id,
        title: item.subject.title,
        subtitle: [notificationHeadline(item.kind, item.subject.agent), item.subject.workspace]
          .filter(Boolean)
          .join(" · "),
        body: item.body,
      })
      .then((delivered) => {
        if (!delivered && item.kind !== "failed") env.toast(item, () => openItem(item))
      })
  }
}

/** Flush a pending burst now; tests and shutdown use it. */
export function flushNotificationBursts(): void {
  cancelBurst?.()
  flushBanners()
}

/**
 * A thread started working again. Whatever it had waiting is stale: the user
 * (or another client) answered it. Announced banners go with it.
 */
export function retireSubject(id: string, kind?: NotificationKind): void {
  const env = environment
  const state = notificationsStore.get()
  const stale = (item: NotificationItem) =>
    item.subject.id === id && !item.seen && (kind === undefined || item.kind === kind)
  if (!state.items.some(stale)) return
  notificationsStore.set({ items: state.items.filter((item) => !stale(item)) })
  burst = burst.filter((pending) => !stale(pending.item))
  if (state.items.some((item) => item.subject.id === id && !item.seen && !stale(item))) return
  env?.dismissToast(id)
  env?.dismissDesktop(id)
}

/* ------------------------------------------------------------------ */
/* Seen                                                                 */
/* ------------------------------------------------------------------ */

export function markSeen(ids: Iterable<string>): void {
  const env = environment
  const wanted = new Set(ids)
  if (wanted.size === 0) return
  const state = notificationsStore.get()
  if (!state.items.some((item) => !item.seen && wanted.has(item.subject.id))) return
  notificationsStore.set({
    items: state.items.map((item) =>
      !item.seen && wanted.has(item.subject.id) ? { ...item, seen: true } : item
    ),
  })
  burst = burst.filter((pending) => !wanted.has(pending.item.subject.id))
  for (const id of wanted) {
    env?.dismissToast(id)
    env?.dismissDesktop(id)
  }
}

export function markAllSeen(): void {
  markSeen(notificationsStore.get().items.map((item) => item.subject.id))
  environment?.dismissDesktop(SUMMARY_SUBJECT)
}

/** What is on screen while the window is in front has been seen. */
export function reconcileVisible(): void {
  const env = environment
  if (!env || !env.focused()) return
  markSeen(env.visibleSubjects())
}

export function openItem(item: NotificationItem): void {
  markSeen([item.subject.id])
  environment?.open(item.subject)
}

export function openSubjectId(id: string): void {
  const item = notificationsStore.get().items.find((entry) => entry.subject.id === id)
  if (item) openItem(item)
}

/** The next thread needing you, most urgent first; null when there is none. */
export function nextUnseen(): NotificationItem | null {
  return unseenItems(notificationsStore.get().items)[0] ?? null
}

/* ------------------------------------------------------------------ */
/* Badge                                                                */
/* ------------------------------------------------------------------ */

let lastBadge = -1

export function syncBadge(): void {
  const env = environment
  if (!env) return
  const count = prefsStore.get().badgeCount
    ? unseenSubjects(notificationsStore.get().items).length
    : 0
  if (count === lastBadge) return
  lastBadge = count
  env.badge(count)
}

notificationsStore.subscribe(syncBadge)
prefsStore.subscribe(syncBadge)

/* ------------------------------------------------------------------ */
/* The desk environment                                                 */
/* ------------------------------------------------------------------ */

/** The subjects of a live conversation: its key, and its thread once bound. */
export function liveSubjectIds(key: string, threadPath?: string): string[] {
  const ids = [subjectId({ kind: "live", key })]
  if (threadPath) ids.push(subjectId({ kind: "thread", path: threadPath }))
  return ids
}

function deskVisibleSubjects(): ReadonlySet<string> {
  const ids = new Set<string>()
  const acp = acpStateReader?.()
  if (acp?.activeKey) {
    const conversation = acp.conversations[acp.activeKey]
    for (const id of liveSubjectIds(acp.activeKey, conversation?.threadPath)) ids.add(id)
  }
  const viewing = threadsReader?.()
  if (viewing) ids.add(subjectId({ kind: "thread", path: viewing }))
  if (ids.size === 0) {
    const tab = tabsReader?.()
    if (tab) ids.add(subjectId({ kind: "tab", id: tab }))
  }
  return ids
}

type AcpReader = () => { activeKey: string | null; conversations: Record<string, { threadPath?: string }> }
let acpStateReader: AcpReader | null = null
let threadsReader: (() => string | null) | null = null
let tabsReader: (() => string | null) | null = null

/**
 * Tell the centre how to read what is on screen. Kept as readers rather than
 * imports: the stores that own the stage import this module, and a cycle
 * through `session.ts` is the kind that loads in one order and fails in
 * another.
 */
export function bindStageReaders(readers: {
  acp: AcpReader
  viewingPath: () => string | null
  activeTab: () => string | null
}): void {
  acpStateReader = readers.acp
  threadsReader = readers.viewingPath
  tabsReader = readers.activeTab
}

function headline(item: NotificationItem): string {
  return notificationHeadline(item.kind, item.subject.agent)
}

/**
 * The renderer's environment: sonner for toasts, the audio cue, and the
 * client's bridge for banners and the badge. Preview windows record but
 * never announce: one desk, one set of banners.
 */
export function deskNotificationEnvironment(options: {
  announces: boolean
  open: (subject: NotificationSubject) => void
  /**
   * The in-app card, supplied by the component layer because this module is
   * React-free. Without one (node, tests) the announcement is sonner's plain
   * text toast with the same identity, so `dismissToast` still finds it.
   */
  toast?: (item: NotificationItem, open: () => void) => void
}): NotificationEnvironment {
  return {
    visibleSubjects: deskVisibleSubjects,
    focused: () => {
      // Absent under node, where the state tests run this environment.
      const page: Document | undefined = globalThis.document
      return page ? page.visibilityState === "visible" && page.hasFocus() : true
    },
    now: () => Date.now(),
    cue: () => playFeedback("complete"),
    toast:
      options.toast ??
      ((item, open) => {
        toast(item.subject.title, {
          id: item.subject.id,
          description: `${headline(item)} · ${item.body}`,
          duration: ACTION_TOAST_MS,
          action: { label: "Open", onClick: open },
        })
      }),
    dismissToast: (id) => toast.dismiss(id),
    desktop: async (notification) => {
      if (!hasBridge()) return false
      try {
        const result = await getMako().notify({
          ...notification,
          silent: !prefsStore.get().soundEnabled,
        })
        if (!result.delivered && (result.reason === "denied" || result.reason === "unsigned"))
          notificationsStore.set({ permission: result.reason })
        return result.delivered
      } catch {
        return false
      }
    },
    dismissDesktop: (subject) => {
      if (hasBridge()) void getMako().dismissNotification(subject).catch(() => {})
    },
    badge: (count) => {
      if (hasBridge()) void getMako().setBadgeCount(count).catch(() => {})
    },
    schedule: (run, ms) => {
      const timer = setTimeout(run, ms)
      return () => clearTimeout(timer)
    },
    open: options.open,
    announces: () => options.announces,
  }
}

/** Refresh the platform's permission readout; Settings shows it. */
export async function refreshNotificationPermission(): Promise<NotificationPermission> {
  if (!hasBridge()) {
    notificationsStore.set({ permission: "unsupported" })
    return "unsupported"
  }
  const permission = await getMako()
    .notificationPermission()
    .catch((): NotificationPermission => "unsupported")
  notificationsStore.set({ permission })
  return permission
}

export async function requestNotificationPermission(): Promise<NotificationPermission> {
  if (!hasBridge()) return "unsupported"
  const permission = await getMako()
    .requestNotificationPermission()
    .catch((): NotificationPermission => "unsupported")
  notificationsStore.set({ permission })
  return permission
}

/** A banner on demand, so Settings can prove the path end to end. */
export async function sendTestNotification(): Promise<boolean> {
  const env = environment
  if (!env) return false
  return env.desktop({
    id: `mako:test:${env.now()}`,
    subject: "mako:test",
    title: "Mako",
    subtitle: "Notifications are on",
    body: "You will hear from your agents here when Mako is in the background.",
  })
}

/** Label a subject's workspace the way the rail does. */
export function subjectWorkspace(cwd?: string): string | undefined {
  return cwd ? workspaceName(cwd) : undefined
}
