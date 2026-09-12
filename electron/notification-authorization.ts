import { execFile } from "node:child_process"
import { access } from "node:fs/promises"
import { dirname, join } from "node:path"
import { z } from "zod"
import type { NotificationPermission } from "./contracts/notifications.js"

/**
 * The truth about macOS notification authorization.
 *
 * Electron has no API for it: `Notification.isSupported()` is always true on
 * macOS, and a refused banner only reports `failed` after `show()`. The
 * packaged app therefore carries `mako-notification-status`, a Swift helper
 * built by `scripts/build-notification-status.mjs`, next to the Electron
 * executable in Contents/MacOS. It must live exactly there: NSBundle resolves
 * the bundle by walking up from the executable, and macOS 26 aborts
 * UNUserNotificationCenter for an executable outside a bundle (verified: exit
 * 134 from /tmp, a JSON answer from Contents/MacOS).
 *
 * Authorized but with no alert style is reported as denied: the user left
 * notifications on and picked "None", so nothing would show.
 */
export const HELPER_NAME = "mako-notification-status"
const HELPER_TIMEOUT_MS = 4_000

const ReadoutSchema = z.object({
  authorization: z.enum([
    "authorized",
    "provisional",
    "ephemeral",
    "denied",
    "not-determined",
    "timeout",
    "unknown",
  ]),
  alert: z.enum(["enabled", "disabled", "not-supported", "unknown"]),
  alertStyle: z.enum(["none", "banner", "alert", "unknown"]).optional(),
})
export type AuthorizationReadout = z.infer<typeof ReadoutSchema>

export function permissionFromReadout(readout: AuthorizationReadout): NotificationPermission | null {
  switch (readout.authorization) {
    case "authorized":
    case "provisional":
    case "ephemeral":
      return readout.alert === "disabled" || readout.alertStyle === "none" ? "denied" : "granted"
    case "denied":
      return "denied"
    case "not-determined":
      return "default"
    case "timeout":
    case "unknown":
      return null
  }
}

export function parseAuthorizationReadout(text: string): NotificationPermission | null {
  const parsed = ReadoutSchema.safeParse(JSON.parse(text))
  return parsed.success ? permissionFromReadout(parsed.data) : null
}

export function helperPathFor(executable: string): string {
  return join(dirname(executable), HELPER_NAME)
}

let helperPresent: Promise<string | null> | null = null
let inFlight: Promise<NotificationPermission | null> | null = null

/**
 * Ask the helper; null when it is absent (development, other platforms) or
 * unsure. Concurrent callers share one run: every finishing agent consults
 * the readout at once.
 */
export function readNotificationAuthorization(
  executable = process.execPath
): Promise<NotificationPermission | null> {
  if (process.platform !== "darwin") return Promise.resolve(null)
  helperPresent ??= access(helperPathFor(executable)).then(
    () => helperPathFor(executable),
    () => null
  )
  inFlight ??= helperPresent
    .then(
      (helper) =>
        new Promise<NotificationPermission | null>((resolve) => {
          if (!helper) {
            resolve(null)
            return
          }
          execFile(helper, [], { timeout: HELPER_TIMEOUT_MS, encoding: "utf8" }, (error, stdout) => {
            if (error) {
              resolve(null)
              return
            }
            try {
              resolve(parseAuthorizationReadout(stdout.trim()))
            } catch {
              resolve(null)
            }
          })
        })
    )
    .finally(() => {
      inFlight = null
    })
  return inFlight
}
