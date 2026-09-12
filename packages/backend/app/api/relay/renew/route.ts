import { z } from "zod"
import {
  relayAuth,
  relayDeviceAuthorized,
  relayUnauthorized,
} from "../../../../src/relay/auth"
import { azureRelayStore } from "../../../../src/relay/azure-store"
import { RelayRenewalSchema } from "../../../../src/relay/types"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

export async function POST(request: Request): Promise<Response> {
  const auth = relayAuth(request)
  if (!auth) return relayUnauthorized()
  const renewal = RelayRenewalSchema.parse(z.json().parse(await request.json()))
  if (!relayDeviceAuthorized(auth, renewal.deviceId)) return relayUnauthorized()
  // A busy worker sends no lease requests; its renewals keep it online.
  if (renewal.heartbeat && renewal.heartbeat.deviceId === renewal.deviceId)
    await azureRelayStore.heartbeat(auth.tenantId, renewal.heartbeat)
  return Response.json({
    popReceipt: await azureRelayStore.renew(renewal),
  })
}
