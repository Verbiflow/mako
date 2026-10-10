import { join } from "node:path"
import { buildIdentity, cloudUrl } from "../build-identity.js"
import type { TelemetryApp } from "../contracts/telemetry.js"
import { crashIdAt, crashesAfter } from "../crash.js"
import { packagedDistribution } from "../distribution.js"
import { hostLog } from "../host-log.js"
import { HostTelemetry, type HostTelemetrySources } from "../host-telemetry.js"
import { unknownKinds } from "../native-unknown.js"
import { Telemetry, telemetryOff } from "../telemetry.js"
import { telemetryMachineId } from "../machine-id.js"
import type { MethodTable } from "../host-methods.js"
import { hostEnvironment } from "../host-environment.js"
import { systemName, systemVersion } from "../platform.js"

/**
 * Telemetry for this host's profile, and Settings → Privacy's two channels.
 * A fixture desk sends only with `MAKO_TELEMETRY=on`, and then keeps its install ID in memory, as it writes nothing.
 */
export async function installTelemetry(methods: MethodTable, {
  fixture,
  token,
  ...sources
}: {
  fixture: boolean
  /** A connection token while this Mac is signed in to Mako. */
  token: () => Promise<string | undefined>
} & Pick<HostTelemetrySources, "attended" | "inventory" | "account">): Promise<HostTelemetry> {
  const telemetry = await Telemetry.open({
    ...(!fixture && { file: join(hostEnvironment().dataRoot, "telemetry.json") }),
    cloud: cloudUrl(),
    app: describeApp(),
    off: telemetryOff(process.env, fixture),
    token,
    machine: () => telemetryMachineId(),
    log: (message, fields) => hostLog("telemetry", message, fields),
  })
  methods.handle("mako:telemetry", () => telemetry.state())
  methods.handle("mako:telemetry-choose", (choice) => telemetry.choose(choice))
  return new HostTelemetry(telemetry, { ...sources, crashesAfter, crashIdAt, unknownKinds })
}

function describeApp(): TelemetryApp {
  const version = hostEnvironment().version
  const build = buildIdentity()?.id
  const osVersion = systemVersion().match(/^[\w.]{1,24}/)?.[0]
  return {
    version: /^[\w.+-]{1,40}$/.test(version) ? version : "unknown",
    ...(build && { build }),
    distribution: hostEnvironment().packaged ? packagedDistribution(hostEnvironment().appRoot) : "development",
    os: systemName(),
    ...(osVersion && { osVersion }),
    arch: process.arch === "arm64" || process.arch === "x64" ? process.arch : "other",
  }
}
