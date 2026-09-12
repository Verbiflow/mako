import type {
  DesktopNotification,
  NotificationDelivery,
  NotificationPermission,
} from "./contracts/notifications.js"

/**
 * Delivers the renderer's notifications through the platform and keeps the
 * app-icon badge honest. Electron-free so the retention and replacement rules
 * can be tested with a fake notification class; `client-main.ts` and the
 * standalone host supply the real one.
 *
 * Three rules the platform does not enforce for us:
 *
 * - A live `Notification` and its click listener are garbage-collected unless
 *   something holds them, so every shown notification is retained until it
 *   reports click, close, or failure.
 * - One banner per subject. A thread that finishes, then asks a question,
 *   replaces its banner rather than stacking two; dismissing the subject closes
 *   whatever is still on screen.
 * - `show()` returns before macOS decides. A refused banner reports `failed`
 *   about ten milliseconds later (`UNErrorDomain error 1`, verified on macOS
 *   26 with an ad-hoc binary), so delivery waits for `show` or `failed` and
 *   only then answers; a platform that says nothing within the grace is taken
 *   at its word.
 */
export interface NativeNotificationHandle {
  show(): void
  close(): void
  on(event: "click" | "close" | "failed" | "show", listener: () => void): void
}

export interface NativeNotificationOptions {
  title: string
  subtitle?: string
  body: string
  silent: boolean
}

export interface DesktopNotifierPlatform {
  platform: NodeJS.Platform
  /** A packaged, signed app. Unsigned macOS builds cannot notify at all. */
  signed: boolean
  supported(): boolean
  create(options: NativeNotificationOptions): NativeNotificationHandle
  /** Bring the asking window forward and tell it which subject to open. */
  activate(windowId: number, activation: { id: string; subject: string }): void
  /** Paint the app icon. `label` is already capped; empty clears. */
  setBadge(count: number, label: string): void
  /** The system's own authorization readout, when a helper can ask it; null otherwise. */
  authorization(): Promise<NotificationPermission | null>
  schedule(run: () => void, ms: number): () => void
}

export interface DesktopNotifier {
  notify(windowId: number, notification: DesktopNotification): Promise<NotificationDelivery>
  dismiss(subject: string): void
  setBadgeCount(count: number): void
  permission(): Promise<NotificationPermission>
  /** Close every banner and clear the badge; a client that exits leaves nothing behind. */
  dispose(): void
}

interface RetainedNotification {
  id: string
  windowId: number
  handle: NativeNotificationHandle
}

/** "99+" keeps the dock tile legible; the count itself is still exact. */
export function badgeLabel(count: number): string {
  if (!Number.isSafeInteger(count) || count <= 0) return ""
  return count > 99 ? "99+" : String(count)
}

/** How long a shown banner may stay silent before it counts as delivered. */
export const DELIVERY_GRACE_MS = 1_500

export function createDesktopNotifier(
  platform: DesktopNotifierPlatform
): DesktopNotifier {
  const retained = new Map<string, RetainedNotification>()
  let lastBadge = -1
  // Delivery evidence, for platforms without an authorization readout.
  let lastOutcome: "shown" | "refused" | null = null

  const release = (subject: string, id: string) => {
    const current = retained.get(subject)
    if (current?.id === id) retained.delete(subject)
  }

  return {
    notify(windowId, notification) {
      if (!platform.supported()) return Promise.resolve({ delivered: false, reason: "unsupported" })
      if (platform.platform === "darwin" && !platform.signed)
        return Promise.resolve({ delivered: false, reason: "unsigned" })
      const previous = retained.get(notification.subject)
      if (previous) {
        retained.delete(notification.subject)
        previous.handle.close()
      }
      let handle: NativeNotificationHandle
      try {
        handle = platform.create({
          title: notification.title,
          subtitle: notification.subtitle,
          body:
            platform.platform === "darwin" || !notification.subtitle
              ? notification.body
              : `${notification.subtitle}\n${notification.body}`,
          silent: notification.silent,
        })
      } catch {
        return Promise.resolve({ delivered: false, reason: "failed" })
      }
      const entry: RetainedNotification = { id: notification.id, windowId, handle }
      retained.set(notification.subject, entry)
      return new Promise<NotificationDelivery>((resolve) => {
        let settled = false
        let cancelGrace: (() => void) | null = null
        const settle = (delivery: NotificationDelivery) => {
          if (settled) return
          settled = true
          cancelGrace?.()
          resolve(delivery)
        }
        handle.on("show", () => {
          lastOutcome = "shown"
          settle({ delivered: true })
        })
        handle.on("click", () => {
          release(notification.subject, notification.id)
          settle({ delivered: true })
          platform.activate(windowId, { id: notification.id, subject: notification.subject })
        })
        handle.on("close", () => {
          release(notification.subject, notification.id)
          settle({ delivered: true })
        })
        handle.on("failed", () => {
          lastOutcome = "refused"
          release(notification.subject, notification.id)
          settle({ delivered: false, reason: "denied" })
        })
        try {
          handle.show()
        } catch {
          release(notification.subject, notification.id)
          settle({ delivered: false, reason: "failed" })
          return
        }
        cancelGrace = platform.schedule(() => settle({ delivered: true }), DELIVERY_GRACE_MS)
      })
    },

    dismiss(subject) {
      const current = retained.get(subject)
      if (!current) return
      retained.delete(subject)
      current.handle.close()
    },

    setBadgeCount(count) {
      const next = Number.isSafeInteger(count) && count > 0 ? count : 0
      if (next === lastBadge) return
      lastBadge = next
      try {
        platform.setBadge(next, badgeLabel(next))
      } catch {
        // Badges are chrome: a desktop without one must not fail the call.
      }
    },

    async permission() {
      if (!platform.supported()) return "unsupported"
      if (platform.platform === "darwin" && !platform.signed) return "unsigned"
      const readout = await platform.authorization().catch(() => null)
      if (readout) return readout
      if (lastOutcome === "refused") return "denied"
      if (lastOutcome === "shown") return "granted"
      return "default"
    },

    dispose() {
      for (const entry of retained.values()) entry.handle.close()
      retained.clear()
      if (lastBadge !== 0) {
        lastBadge = 0
        try {
          platform.setBadge(0, "")
        } catch {
          // See setBadgeCount.
        }
      }
    },
  }
}
