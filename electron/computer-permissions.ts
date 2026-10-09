import { execFile } from "node:child_process"
import { unlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { systemPreferences } from "electron"
import { packagedDistribution } from "./distribution.js"
import { MAKO_BUNDLE_ID, type MAKO_GRANT_SERVICES } from "./local-update-installer.js"
import type { MakoComputerPermissions } from "./shared.js"
import { hostEnvironment } from "./host-environment.js"
import { presentMachine } from "./machine.js"

const execute = promisify(execFile)

export type TccService = (typeof MAKO_GRANT_SERVICES)[number]

export function computerPermissions(): MakoComputerPermissions {
  if (process.platform !== "darwin") {
    return {
      supported: false,
      persistentAcrossUpdates: false,
      accessibility: false,
      screenRecording: "unknown",
    }
  }
  return {
    supported: true,
    persistentAcrossUpdates:
      hostEnvironment().packaged && packagedDistribution(hostEnvironment().appRoot) !== "unsigned",
    accessibility: systemPreferences.isTrustedAccessibilityClient(false),
    screenRecording: systemPreferences.getMediaAccessStatus("screen"),
  }
}

async function openPrivacyPane(
  pane: "Privacy_Accessibility" | "Privacy_ScreenCapture"
): Promise<void> {
  await presentMachine().openUrl(`x-apple.systempreferences:com.apple.preference.security?${pane}`)
}

/**
 * A TCC row is bound to the code requirement the app had when the row was
 * written. Ad-hoc builds carry a per-build cdhash requirement, and the move to
 * a certificate changed the requirement again, so a row written under either
 * identity survives with its toggle shown on while tccd answers every request
 * with "failed to match existing code requirement" and never prompts. A grant
 * that is not currently honoured is therefore worth nothing, whatever the pane
 * shows; drop it before asking so the request gets a fresh decision.
 *
 * Only a packaged app resets: a checkout runs as Electron.app, whose bundle
 * identifier is shared with every other Electron checkout on the machine.
 */
type Run = (
  command: string,
  args: string[]
) => Promise<{ stdout: string; stderr: string }>

export async function resetMakoGrant(
  service: TccService,
  bundleId = MAKO_BUNDLE_ID,
  run: Run = (command, args) => execute(command, args, { timeout: 10_000 })
): Promise<boolean> {
  if (process.platform !== "darwin" || !hostEnvironment().packaged) return false
  try {
    await run("tccutil", ["reset", service, bundleId])
    return true
  } catch {
    return false
  }
}

/**
 * Electron's capturer on macOS 15+ goes through the ScreenCaptureKit picker,
 * which needs no Screen Recording grant and therefore never asks TCC: tccd
 * logs a preflight with "DB Action: None" and Mako never appears in the
 * Screen Recording list. `screencapture` makes a real request, and a child
 * of the host inherits the host's responsibility, so the row and the dialog
 * are attributed to Mako. With the grant already active it only writes a
 * throwaway image.
 */
async function requestScreenRecording(): Promise<void> {
  const file = join(tmpdir(), `mako-screen-recording-${process.pid}.png`)
  try {
    await execute("/usr/sbin/screencapture", ["-x", "-t", "png", file], {
      timeout: 15_000,
    })
  } catch {
    // The dialog is the point; a failed capture is the ungranted case.
  } finally {
    await unlink(file).catch(() => undefined)
  }
}

export async function requestComputerPermissions(
  focus: () => void
): Promise<MakoComputerPermissions> {
  if (process.platform !== "darwin") return computerPermissions()
  focus()
  if (!systemPreferences.isTrustedAccessibilityClient(false)) {
    await resetMakoGrant("Accessibility")
    systemPreferences.isTrustedAccessibilityClient(true)
    await new Promise((resolve) => setTimeout(resolve, 500))
    const permissions = computerPermissions()
    if (!permissions.accessibility)
      await openPrivacyPane("Privacy_Accessibility")
    return permissions
  }
  if (systemPreferences.getMediaAccessStatus("screen") !== "granted") {
    await resetMakoGrant("ScreenCapture")
    await requestScreenRecording()
    const permissions = computerPermissions()
    if (permissions.screenRecording !== "granted")
      await openPrivacyPane("Privacy_ScreenCapture")
    return permissions
  }
  return computerPermissions()
}
