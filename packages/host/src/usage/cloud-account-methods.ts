import { execFile } from "node:child_process"
import { hostname } from "node:os"
import { promisify } from "node:util"
import type { ClientSessionOverSockets } from "@mako/protocol"
import { cloudUrl } from "../base/build-identity.js"
import { CloudAccounts, cloudLegacyFiles, cloudSignInName } from "./cloud-account.js"
import type { DiagnosticEvents } from "../contracts/telemetry.js"
import type { HostEnvironment } from "../base/host-environment.js"
import { hostLog } from "../base/host-log.js"
import type { DomainSecrets } from "../base/host-secrets.js"
import type { HostEvent } from "../contracts/host-events-boot.js"
import type { MethodTable } from "../base/methods.js"
import { type HostMethods, serveHostThroughGateway } from "../transport/index.js"
import { presentMachine, type MachineCapability } from "../base/machine.js"
import { onMac, systemName, systemVersion } from "../base/platform.js"

/** The Mako account this host is signed in to, for the services that act as it. */
export interface CloudAccount {
  /** A connection token while this Mac is signed in to Mako. */
  token(): Promise<string | undefined>
  /** The signed-in Mako account's ID, or undefined while signed out. */
  id(): Promise<string | undefined>
  /**
   * Calls through the cloud as this Mac, to a Thread, another device's runtime or the account, for
   * `gatewayHostCalls`; throws in a build without a cloud. Signing out closes it.
   */
  session(): ClientSessionOverSockets
  /** After the machine slept or the host was paused: the sign-in may have lapsed meanwhile. */
  wake(): void
  stop(): void
}

/**
 * The Mako account, against the cloud `cloudUrl` names; a build without one says so and offers nothing.
 * A fixture desk signs in only to a cloud on this Mac, and is given secrets kept in memory, so its profile isn't written.
 */
export function declareCloudAccountMethods(methods: MethodTable & Pick<HostMethods, "invoke">, {
  environment,
  secrets,
  machine,
  emit,
  fixture,
  signedIn,
  request,
}: {
  environment: Pick<HostEnvironment, "dataRoot" | "version" | "build">
  secrets: DomainSecrets
  machine: MachineCapability
  emit: (event: HostEvent) => void
  fixture: boolean
  signedIn?: () => void
  request?: (call: DiagnosticEvents["cloud.request"]) => void
}): CloudAccount {
  let status: string | undefined
  let described: Promise<{ name: string; platform: string; appVersion: string }> | undefined
  const { dataRoot } = environment
  secrets.adoptLegacy(cloudLegacyFiles(dataRoot))
  const cloud = new CloudAccounts({
    url: cloudUrl(environment),
    secrets: secrets.secrets,
    secretName: cloudSignInName(dataRoot),
    openExternal: (url) => presentMachine(machine).openUrl(url),
    device: () => (described ??= describeThisMac(environment.version)),
    fixture,
    onChange: (account) => {
      if (status === "signing-in" && account.state.status === "signed-in") signedIn?.()
      status = account.state.status
      emit({ type: "cloud-account", account })
    },
    log: (message, fields) => hostLog("cloud", message, fields),
    onRequest: request,
    // With the cloud entitlement, this Mac answers its account's other devices and the cloud through the same
    // dispatcher as its own windows: the same schemas, the same refusals, the same logs.
    runtime: {
      serve: (link, { runtimeId, credential, threads }) =>
        serveHostThroughGateway(link, {
          runtimeId,
          build: environment.build.makoBuild ? `${environment.version}+${environment.build.makoBuild.id.slice(0, 12)}` : environment.version,
          credential,
          threads,
          invoke: (channel, args, client, history, correlationId) => methods.invoke(channel, args, client, history, correlationId),
        }),
    },
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
    session: () => cloud.session(),
    wake: () => cloud.wake(),
    stop: () => cloud.close(),
  }
}

/** The name people gave this Mac in System Settings, as the account's device list shows it. */
async function describeThisMac(appVersion: string) {
  const fallback = hostname().replace(/\.local$/, "")
  const name =
    onMac()
      ? await promisify(execFile)("/usr/sbin/scutil", ["--get", "ComputerName"], { timeout: 2_000 }).then(
          ({ stdout }) => stdout.trim() || fallback,
          () => fallback
        )
      : fallback
  return { name, platform: `${systemName()} ${systemVersion()}`.trim(), appVersion }
}
