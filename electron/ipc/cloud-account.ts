import { execFile } from "node:child_process"
import { hostname } from "node:os"
import { promisify } from "node:util"
import { cloudUrl } from "@mako/host/base/build-identity"
import { CloudAccounts, cloudLegacyFiles, cloudSignInName } from "../cloud-account.js"
import type { DiagnosticEvents } from "@mako/host/contracts/telemetry"
import { hostEnvironment } from "@mako/host/base/host-environment"
import { hostLog } from "@mako/host/base/host-log"
import { adoptLegacySecrets, hostSecrets } from "@mako/host/base/host-secrets"
import { memorySecrets } from "@mako/host/base/secrets"
import type { HostEvent } from "@mako/host/contracts/host-events-boot"
import type { MethodTable } from "@mako/host/base/methods"
import { presentMachine } from "@mako/host/base/machine"
import { onMac, systemName, systemVersion } from "@mako/host/base/platform"

/** The Mako account this host is signed in to, for the services that act as it. */
export interface CloudAccount {
  /** A connection token while this Mac is signed in to Mako. */
  token(): Promise<string | undefined>
  /** The signed-in Mako account's ID, or undefined while signed out. */
  id(): Promise<string | undefined>
  /** After the machine slept or the host was paused: the sign-in may have lapsed meanwhile. */
  wake(): void
  stop(): void
}

/**
 * The Mako account, against the cloud `cloudUrl()` names; a build without one says so and offers nothing.
 * A fixture desk signs in only to a cloud on this Mac and keeps the sign-in in memory, so its profile isn't written.
 */
export function installCloudAccountIpc(methods: MethodTable, {
  emit,
  fixture,
  signedIn,
  request,
}: {
  emit: (event: HostEvent) => void
  fixture: boolean
  signedIn?: () => void
  request?: (call: DiagnosticEvents["cloud.request"]) => void
}): CloudAccount {
  let status: string | undefined
  let described: Promise<{ name: string; platform: string; appVersion: string }> | undefined
  const { dataRoot } = hostEnvironment()
  if (!fixture) adoptLegacySecrets(cloudLegacyFiles(dataRoot))
  const cloud = new CloudAccounts({
    url: cloudUrl(),
    secrets: fixture ? memorySecrets({ durable: false }) : hostSecrets(),
    secretName: cloudSignInName(dataRoot),
    openExternal: (url) => presentMachine().openUrl(url),
    device: () => (described ??= describeThisMac()),
    fixture,
    onChange: (account) => {
      if (status === "signing-in" && account.state.status === "signed-in") signedIn?.()
      status = account.state.status
      emit({ type: "cloud-account", account })
    },
    log: (message, fields) => hostLog("cloud", message, fields),
    onRequest: request,
  })

  methods.handle("mako:cloud-account", () => cloud.ready())
  methods.handle("mako:cloud-sign-in", () => cloud.signIn())
  methods.handle("mako:cloud-sign-in-cancel", () => cloud.cancelSignIn())
  methods.handle("mako:cloud-devices", () => cloud.devices())
  methods.handle("mako:cloud-device-remove", (id: string) => cloud.removeDevice(id))
  methods.handle("mako:cloud-sign-out", () => cloud.signOut())
  return {
    token: () => cloud.optionalConnectionToken(),
    id: async () => {
      const { state } = await cloud.ready()
      return state.status === "signed-in" ? state.account.id : undefined
    },
    wake: () => cloud.wake(),
    stop: () => cloud.close(),
  }
}

/** The name people gave this Mac in System Settings, as the account's device list shows it. */
async function describeThisMac() {
  const fallback = hostname().replace(/\.local$/, "")
  const name =
    onMac()
      ? await promisify(execFile)("/usr/sbin/scutil", ["--get", "ComputerName"], { timeout: 2_000 }).then(
          ({ stdout }) => stdout.trim() || fallback,
          () => fallback
        )
      : fallback
  return { name, platform: `${systemName()} ${systemVersion()}`.trim(), appVersion: hostEnvironment().version }
}
