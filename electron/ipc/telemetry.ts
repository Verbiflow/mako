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
import { cloudAccountId, cloudConnectionToken } from "./cloud-account.js"
import { registerIpc } from "./register.js"
import { hostEnvironment } from "../host-environment.js"

/**
 * Telemetry for this host's profile, and Settings → Privacy's two channels.
 * A fixture desk sends only with `MAKO_TELEMETRY=on`, and then keeps its install ID in memory, as it writes nothing.
 */
export async function installTelemetry({
  fixture,
  ...sources
}: { fixture: boolean } & Pick<HostTelemetrySources, "attended" | "inventory">): Promise<HostTelemetry> {
  const telemetry = await Telemetry.open({
    ...(!fixture && { file: join(hostEnvironment().dataRoot, "telemetry.json") }),
    cloud: cloudUrl(),
    app: describeApp(),
    off: telemetryOff(process.env, fixture),
    token: cloudConnectionToken,
    machine: () => telemetryMachineId(),
    log: (message, fields) => hostLog("telemetry", message, fields),
  })
  registerIpc("mako:telemetry", () => telemetry.state())
  registerIpc("mako:telemetry-choose", (_event, choice) => telemetry.choose(choice))
  return new HostTelemetry(telemetry, { ...sources, crashesAfter, crashIdAt, unknownKinds, account: cloudAccountId })
}

function describeApp(): TelemetryApp {
  const version = hostEnvironment().version
  const build = buildIdentity()?.id
  const osVersion = process.getSystemVersion?.().match(/^[\w.]{1,24}/)?.[0]
  return {
    version: /^[\w.+-]{1,40}$/.test(version) ? version : "unknown",
    ...(build && { build }),
    distribution: hostEnvironment().packaged ? packagedDistribution(hostEnvironment().appRoot) : "development",
    os: process.platform === "darwin" ? "macOS" : process.platform === "win32" ? "Windows" : process.platform === "linux" ? "Linux" : "other",
    ...(osVersion && { osVersion }),
    arch: process.arch === "arm64" || process.arch === "x64" ? process.arch : "other",
  }
}
