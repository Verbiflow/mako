import { app, BrowserWindow, Notification } from "electron"
import {
  createDesktopNotifier,
  type DesktopNotifier,
  type DesktopNotifierPlatform,
} from "./desktop-notifications.js"
import { readNotificationAuthorization } from "./notification-authorization.js"

/**
 * The real platform behind `createDesktopNotifier`, shared by the desktop
 * client and the standalone host. `idleBadge` is what the dock shows when
 * nothing needs you — the dev host wears "DEV" there.
 *
 * A checkout runs as the ad-hoc-signed Electron.app, and macOS refuses its
 * banners outright (`failed` within 10 ms, never a prompt); only the
 * packaged, signed app can notify. The packaged app also carries the
 * `mako-notification-status` helper beside its executable, which is the one
 * truthful readout of System Settings > Notifications.
 */
export function electronDesktopNotifier(options: {
  idleBadge: string
  activate: (windowId: number, activation: { id: string; subject: string }) => void
}): DesktopNotifier {
  const platform: DesktopNotifierPlatform = {
    platform: process.platform,
    signed: app.isPackaged,
    supported: () => Notification.isSupported(),
    create: (notification) => {
      const native = new Notification({
        title: notification.title,
        subtitle: notification.subtitle,
        body: notification.body,
        silent: notification.silent,
      })
      return {
        show: () => native.show(),
        close: () => native.close(),
        on: (event, listener) => {
          // Electron types each event name separately; the union needs a branch.
          if (event === "click") native.on("click", listener)
          else if (event === "close") native.on("close", listener)
          else if (event === "show") native.on("show", listener)
          else native.on("failed", listener)
        },
      }
    },
    activate: options.activate,
    setBadge: (count, label) => {
      if (process.platform === "darwin") app.dock?.setBadge(label || options.idleBadge)
      else app.setBadgeCount(count)
    },
    authorization: () => readNotificationAuthorization(),
    schedule: (run, ms) => {
      const timer = setTimeout(run, ms)
      return () => clearTimeout(timer)
    },
  }
  return createDesktopNotifier(platform)
}

/** Bring a window to the front the way a notification click expects. */
export function surfaceWindow(window: BrowserWindow): void {
  if (window.isDestroyed()) return
  if (window.isMinimized()) window.restore()
  window.show()
  if (process.platform === "darwin") app.focus({ steal: true })
  window.focus()
}
