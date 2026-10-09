import { execFile } from "node:child_process"
import { hostname } from "node:os"
import { promisify } from "node:util"
import { cloudUrl } from "../build-identity.js"
import { CloudAccounts, cloudLegacyFiles, cloudSignInName } from "../cloud-account.js"
import type { DiagnosticEvents } from "../contracts/telemetry.js"
import { hostEnvironment } from "../host-environment.js"
import { hostLog } from "../host-log.js"
import { adoptLegacySecrets, hostSecrets } from "../host-secrets.js"
import { memorySecrets } from "../secrets.js"
import type { HostEvent } from "../shared.js"
import { registerIpc } from "./register.js"
import { presentMachine } from "../machine.js"

let accounts: CloudAccounts | undefined

export function stopCloudAccountIpc(): void {
  accounts?.close()
  accounts = undefined
}

/** A connection token while this Mac is signed in to Mako. */
export function cloudConnectionToken(): Promise<string | undefined> {
  return accounts?.optionalConnectionToken() ?? Promise.resolve(undefined)
}

/** The signed-in Mako account's ID, or undefined while signed out. */
export async function cloudAccountId(): Promise<string | undefined> {
  const state = (await accounts?.ready())?.state
  return state?.status === "signed-in" ? state.account.id : undefined
}

/**
 * The Mako account, against the cloud `cloudUrl()` names; a build without one says so and offers nothing.
 * A fixture desk signs in only to a cloud on this Mac and keeps the sign-in in memory, so its profile isn't written.
 */
export function installCloudAccountIpc({
  emit,
  fixture,
  signedIn,
  request,
}: {
  emit: (event: HostEvent) => void
  fixture: boolean
  signedIn?: () => void
  request?: (call: DiagnosticEvents["cloud.request"]) => void
}): void {
  let status: string | undefined
  const { dataRoot } = hostEnvironment()
  if (!fixture) adoptLegacySecrets(cloudLegacyFiles(dataRoot))
  const cloud = new CloudAccounts({
    url: cloudUrl(),
    secrets: fixture ? memorySecrets({ durable: false }) : hostSecrets(),
    secretName: cloudSignInName(dataRoot),
    openExternal: (url) => presentMachine().openUrl(url),
    device: describeThisMac,
    fixture,
    onChange: (account) => {
      if (status === "signing-in" && account.state.status === "signed-in") signedIn?.()
      status = account.state.status
      emit({ type: "cloud-account", account })
    },
    log: (message, fields) => hostLog("cloud", message, fields),
    onRequest: request,
  })
  accounts = cloud

  registerIpc("mako:cloud-account", () => cloud.ready())
  registerIpc("mako:cloud-sign-in", () => cloud.signIn())
  registerIpc("mako:cloud-sign-in-cancel", () => cloud.cancelSignIn())
  registerIpc("mako:cloud-devices", () => cloud.devices())
  registerIpc("mako:cloud-device-remove", (_event, id: string) => cloud.removeDevice(id))
  registerIpc("mako:cloud-sign-out", () => cloud.signOut())
}

/** After the machine slept or the host was paused: the sign-in may have lapsed meanwhile. */
export function wakeCloudAccount(): void {
  accounts?.wake()
}

let described: Promise<{ name: string; platform: string; appVersion: string }> | undefined

/** The name people gave this Mac in System Settings, as the account's device list shows it. */
function describeThisMac() {
  described ??= (async () => {
    const fallback = hostname().replace(/\.local$/, "")
    const name =
      process.platform === "darwin"
        ? await promisify(execFile)("/usr/sbin/scutil", ["--get", "ComputerName"], { timeout: 2_000 }).then(
            ({ stdout }) => stdout.trim() || fallback,
            () => fallback
          )
        : fallback
    const system =
      process.platform === "darwin" ? "macOS" : process.platform === "win32" ? "Windows" : process.platform === "linux" ? "Linux" : process.platform
    return { name, platform: `${system} ${process.getSystemVersion()}`.trim(), appVersion: hostEnvironment().version }
  })()
  return described
}
