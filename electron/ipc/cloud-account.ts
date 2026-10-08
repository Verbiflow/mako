import { app, powerMonitor, shell } from "electron"
import { execFile } from "node:child_process"
import { hostname } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { cloudUrl } from "../build-identity.js"
import { CloudAccounts } from "../cloud-account.js"
import { hostLog } from "../host-log.js"
import { electronSecretEncryption } from "../secure-storage.js"
import type { HostEvent } from "../shared.js"
import { registerIpc } from "./register.js"

let accounts: CloudAccounts | undefined

export function stopCloudAccountIpc(): void {
  powerMonitor.removeListener("resume", wake)
  powerMonitor.removeListener("unlock-screen", wake)
  accounts?.close()
  accounts = undefined
}

/** A connection token while this Mac is signed in to Mako. */
export function cloudConnectionToken(): Promise<string | undefined> {
  return accounts?.optionalConnectionToken() ?? Promise.resolve(undefined)
}

export async function cloudSignedIn(): Promise<boolean> {
  return (await accounts?.ready())?.state.status === "signed-in"
}

/**
 * The Mako account, against the cloud `cloudUrl()` names; a build without one says so and offers nothing.
 * A fixture desk signs in only to a cloud on this Mac and keeps the sign-in in memory, so its profile isn't written.
 */
export function installCloudAccountIpc({ emit, fixture, signedIn }: { emit: (event: HostEvent) => void; fixture: boolean; signedIn?: () => void }): void {
  let status: string | undefined
  const cloud = new CloudAccounts({
    url: cloudUrl(),
    storePath: join(app.getPath("userData"), "cloud-account"),
    encryption: fixture ? memoryOnly : electronSecretEncryption(),
    openExternal: (url) => shell.openExternal(url),
    device: describeThisMac,
    fixture,
    onChange: (account) => {
      if (status === "signing-in" && account.state.status === "signed-in") signedIn?.()
      status = account.state.status
      emit({ type: "cloud-account", account })
    },
    log: (message, fields) => hostLog("cloud", message, fields),
  })
  accounts = cloud
  powerMonitor.on("resume", wake)
  powerMonitor.on("unlock-screen", wake)

  registerIpc("mako:cloud-account", () => cloud.ready())
  registerIpc("mako:cloud-sign-in", () => cloud.signIn())
  registerIpc("mako:cloud-sign-in-cancel", () => cloud.cancelSignIn())
  registerIpc("mako:cloud-devices", () => cloud.devices())
  registerIpc("mako:cloud-device-remove", (_event, id: string) => cloud.removeDevice(id))
  registerIpc("mako:cloud-sign-out", () => cloud.signOut())
}

function wake(): void {
  accounts?.wake()
}

const memoryOnly = {
  available: async () => false,
  encrypt: async () => {
    throw new Error("unreachable")
  },
  decrypt: async () => {
    throw new Error("unreachable")
  },
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
    return { name, platform: `${system} ${process.getSystemVersion()}`.trim(), appVersion: app.getVersion() }
  })()
  return described
}
