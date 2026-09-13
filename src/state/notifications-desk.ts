import { acpStore } from "@/state/acp-state"
import { interfacePreview } from "@/state/development"
import {
  bindStageReaders,
  deskNotificationEnvironment,
  flushNotificationBursts,
  installNotificationEnvironment,
  notificationsStore,
  reconcileVisible,
  refreshNotificationPermission,
  type NotificationItem,
  type NotificationSubject,
} from "@/state/notifications"
import { tabsStore } from "@/state/tabs"
import { threadsStore } from "@/state/thread-store"

/**
 * Wire the attention centre to this window: what is on screen, whether the
 * window is in front, and how to open a thread from a banner. The stage
 * stores are read through readers and the openers are imported lazily, so
 * this module sits beside `session.ts` without importing it at load.
 */
async function openSubject(subject: NotificationSubject): Promise<void> {
  const target = subject.target
  switch (target.kind) {
    case "thread": {
      const ref = threadsStore.get().threads.find((entry) => entry.path === target.path)
      if (!ref) return
      const { threads } = await import("@/state/threads")
      await threads.view(ref)
      return
    }
    case "live": {
      const { acp } = await import("@/state/acp")
      acp.activate(target.key)
      return
    }
    case "tab": {
      const { actions } = await import("@/state/session")
      await actions.switchTab(target.id)
    }
  }
}

export function bindNotifications(options: {
  /** Renders the in-app card; the component layer owns what a toast looks like. */
  toast?: (item: NotificationItem, open: () => void) => void
} = {}): () => void {
  bindStageReaders({
    acp: () => acpStore.get(),
    viewingPath: () => threadsStore.get().viewing?.ref.path ?? null,
    activeTab: () => tabsStore.get().activeId || null,
  })
  const uninstall = installNotificationEnvironment(
    deskNotificationEnvironment({
      announces: !interfacePreview,
      open: (subject) => void openSubject(subject).catch(() => {}),
      toast: options.toast,
    })
  )
  const focused = () => document.visibilityState === "visible" && document.hasFocus()
  const sync = () => {
    const next = focused()
    if (notificationsStore.get().focused !== next) notificationsStore.set({ focused: next })
    if (next) reconcileVisible()
  }
  window.addEventListener("focus", sync)
  window.addEventListener("blur", sync)
  document.addEventListener("visibilitychange", sync)
  sync()

  // Each store wakes on every token; comparing one string keeps that free.
  let stage = ""
  const watch = () => {
    const acp = acpStore.get()
    const live = acp.activeKey ? acp.conversations[acp.activeKey] : undefined
    const next = [
      acp.activeKey ?? "",
      live?.threadPath ?? "",
      threadsStore.get().viewing?.ref.path ?? "",
      tabsStore.get().activeId,
    ].join("\u0000")
    if (next === stage) return
    stage = next
    reconcileVisible()
  }
  const unsubscribe = [acpStore, threadsStore, tabsStore].map((store) => store.subscribe(watch))
  watch()
  void refreshNotificationPermission()

  return () => {
    flushNotificationBursts()
    window.removeEventListener("focus", sync)
    window.removeEventListener("blur", sync)
    document.removeEventListener("visibilitychange", sync)
    for (const off of unsubscribe) off()
    uninstall()
  }
}
