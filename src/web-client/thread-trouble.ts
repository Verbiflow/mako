import { useMemo } from "react"
import { activeLiveAcp, useAcp } from "@/state/acp"
import { useAccountList } from "./account-list"
import { useWebClient, type WebClient } from "./client"
import { diagnose, type Diagnosis, type HopState, type ReachInput } from "./diagnosis"
import { webHarnessLabel } from "./labels"
import { CLOUD, macPlace, threadPlace, unanswered, useReach, within, type Reached } from "./reach"
import { macCall } from "./start"
import type { WebSession } from "./threads"
import { baseFacts, checkList, cloudReach, hereOf, useNow, useOnline } from "./trouble-state"
import { useForm } from "./route"

/** A Mac asked whether it's there gets this long to answer before it's said not to. */
export const MAC_ANSWER_MS = 8_000

/** A place as its last call left it: answered, not connected (or never answering), or not asked yet. */
function placeState(reached: Reached | undefined): HopState {
  if (!reached) return "unknown"
  return reached.ok ? "ok" : "failed"
}

/**
 * A Session's reach, from this phone to its harness: the network, Mako Cloud, its Mac (or its cloud Thread's machine)
 * and the harness, as each was last heard. Undefined while nothing failed.
 */
export function useSessionDiagnosis(session: WebSession): Diagnosis | undefined {
  const client = useWebClient()
  const online = useOnline()
  const list = useAccountList((state) => state)
  const places = useReach((state) => state.places)
  const conversation = session.row.conversation
  const failedStart = useAcp((state) => {
    const live = activeLiveAcp(state)
    if (live?.key !== conversation || live.session.status !== "failed" || live.session.connection === "connected") return undefined
    return live.session.error ?? "It stopped as it started."
  })
  const now = useNow()
  const here = hereOf(useForm())
  return useMemo(() => {
    const device = session.owner.kind === "device" ? list.devices.get(session.owner.deviceId) : undefined
    const place = session.owner.kind === "device" ? places.get(macPlace(session.owner.deviceId)) : places.get(threadPlace(session.owner.threadId))
    const cloud = cloudReach(list, places.get(CLOUD))
    const failure = place && !place.ok ? place : cloud.failure
    const input: ReachInput = {
      now,
      here,
      online,
      cloud: cloud.state,
      harness: { name: webHarnessLabel(session.row.harness), state: failedStart ? "failed" : "unknown", ...(failedStart && { reason: failedStart }) },
      facts: baseFacts(client, list, now),
    }
    if (session.owner.kind === "device") {
      input.mac = { name: session.where, link: session.quietSince ? "failed" : placeState(place) }
      if (session.quietSince) input.mac.quietSince = session.quietSince
      if (device?.appVersion) input.mac.version = device.appVersion
    } else {
      // A cloud machine that doesn't answer a look is asleep, not off: it wakes when it's written to.
      input.machine = { state: place && !place.ok && place.outcome !== "owner-unavailable" ? "failed" : place?.ok ? "ok" : "unknown", ...(place?.message && !place.ok && { reason: place.message }) }
    }
    if (failure) input.failure = { message: failure.message ?? "No answer", at: failure.at, ...(failure.correlationId && { correlationId: failure.correlationId }), ...(failure.outcome && { outcome: failure.outcome }) }
    return diagnose(input)
  }, [client, online, list, places, session, failedStart, now, here])
}

/**
 * Asks every hop again, now: the network's word, the account's list read afresh (Mako Cloud), and the Mac asked
 * whether it's there, given `MAC_ANSWER_MS` to answer. A read the network failed is asked once more on its own; a
 * Mac that doesn't answer in time is said not to. Nothing here wakes a cloud machine.
 */
export async function checkReach(client: WebClient, mac: string | undefined): Promise<void> {
  await checkList(client)
  if (mac) {
    const answer = await within(macCall<unknown>(client.gateway, client.deviceId, mac, "mako:harness-order-saved", []).then(() => true, () => false), MAC_ANSWER_MS)
    if (!answer) unanswered(macPlace(mac), { outcome: "timeout", message: `It didn't answer within ${MAC_ANSWER_MS / 1000} seconds.` })
  }
}
