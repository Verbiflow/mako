import type {
  DesktopNotification,
  HostEvent,
  NotificationDelivery,
  NotificationPermission,
} from "../../electron/shared.ts"

/**
 * The browser's answer to the desktop client's notification channels. A web
 * desk has no dock, so the badge goes into the tab title (and the app badge
 * where the browser offers one); banners use the page Notification API and
 * a click focuses the tab and replays the same `notification-activated`
 * event the desktop client sends.
 */
export interface WebNotificationChannels {
  notify(notification: DesktopNotification): NotificationDelivery
  dismiss(subject: string): void
  badge(count: number): void
  permission(): NotificationPermission
  requestPermission(): Promise<NotificationPermission>
}

export function createWebNotificationChannels(
  emit: (event: HostEvent) => void
): WebNotificationChannels {
  const shown = new Map<string, Notification>()
  const baseTitle = document.title
  // Absent in insecure contexts and some embedded views; the DOM lib does not say so.
  const api: typeof Notification | undefined = globalThis.Notification

  const permission = (): NotificationPermission => (api ? api.permission : "unsupported")

  return {
    notify(notification) {
      if (!api) return { delivered: false, reason: "unsupported" }
      if (api.permission !== "granted") return { delivered: false, reason: "denied" }
      shown.get(notification.subject)?.close()
      try {
        const native = new api(notification.title, {
          body: notification.subtitle
            ? `${notification.subtitle}\n${notification.body}`
            : notification.body,
          tag: notification.subject,
          silent: notification.silent,
        })
        shown.set(notification.subject, native)
        native.onclick = () => {
          shown.delete(notification.subject)
          window.focus()
          native.close()
          emit({
            type: "notification-activated",
            id: notification.id,
            subject: notification.subject,
          })
        }
        native.onclose = () => {
          if (shown.get(notification.subject) === native) shown.delete(notification.subject)
        }
        return { delivered: true }
      } catch {
        return { delivered: false, reason: "failed" }
      }
    },
    dismiss(subject) {
      shown.get(subject)?.close()
      shown.delete(subject)
    },
    badge(count) {
      document.title = count > 0 ? `(${count > 99 ? "99+" : count}) ${baseTitle}` : baseTitle
      if ("setAppBadge" in navigator && "clearAppBadge" in navigator) {
        if (count > 0) void navigator.setAppBadge(count).catch(() => {})
        else void navigator.clearAppBadge().catch(() => {})
      }
    },
    permission,
    async requestPermission() {
      if (api && api.permission === "default") await api.requestPermission()
      return permission()
    },
  }
}
