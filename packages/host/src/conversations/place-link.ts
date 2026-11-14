import type { Actor, ClientSessionOverSockets } from "@mako/protocol"
import { hostLog, hostWarn } from "../base/host-log.js"
import { sendWithRepeats, type GatewayCallLog } from "../contracts/gateway-host-calls.js"
import { decodeRuntimeValue } from "../contracts/runtime-value.js"
import { gatewayHostCalls } from "../transport/index.js"
import type { CloudAccount } from "../usage/index.js"
import type { PlaceLink } from "./agent-places.js"

const CALL_LOG: GatewayCallLog = { warn: (message, fields) => hostWarn("agent-places", message, fields), info: (message, fields) => hostLog("agent-places", message, fields) }

/** The kinds of device that run Threads: a browser or a command line is a client, never a place. */
const RUNS_THREADS: ReadonlySet<string> = new Set(["desktop", "runtime"])

/**
 * `PlaceLink` through the Mako account this host is signed in to: the account's devices that run Threads, and a host
 * call to one's runtime (`d-<device>`) or to a cloud Thread's machine, as this device, the way its windows' calls to
 * another device's conversations go. One connection is kept, and made again when this device signs in anew.
 */
export function placeLink(account: () => Pick<CloudAccount, "deviceId" | "devices" | "session"> | undefined): PlaceLink & { close(): void } {
  let held: { deviceId: string; session: ClientSessionOverSockets } | undefined
  const connected = async () => {
    const cloud = account()
    const deviceId = await cloud?.deviceId()
    if (!cloud || !deviceId) throw new Error("This device isn't signed in to Mako.")
    if (held?.deviceId !== deviceId) {
      held?.session.close()
      held = { deviceId, session: cloud.session() }
    }
    return held
  }
  return {
    self: async () => account()?.deviceId(),
    devices: async () => {
      const listed = await account()?.devices?.()
      return (listed?.devices ?? []).filter((device) => device.kind === undefined || RUNS_THREADS.has(device.kind)).map((device) => ({ id: device.id, name: device.name, ...(device.platform && { platform: device.platform }) }))
    },
    call: async (target, channel, args) => {
      const { session, deviceId } = await connected()
      const actor: Actor = { kind: "client", client: "desktop", deviceId }
      const runtime = target.kind === "device" ? `d-${target.device}` : undefined
      const send = gatewayHostCalls(session, runtime ? { runtimeId: runtime, actor } : { threadId: target.kind === "cloud" ? target.thread : "", actor }).call(channel, args)
      return decodeRuntimeValue(await sendWithRepeats(channel, send, { ...(runtime ? { runtime } : target.kind === "cloud" && { threadId: target.thread }), log: CALL_LOG }))
    },
    close: () => {
      held?.session.close()
      held = undefined
    },
  }
}
