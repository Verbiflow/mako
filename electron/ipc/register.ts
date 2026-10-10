import type { ConversationRoutingResult } from "../shared-conversations.js"
import { withHostClient, hostHistoryPaging } from "../host-client.js"
import { breadcrumb } from "../crash.js"
import { hostCallInput, type HostArguments, type HostChannel } from "../contracts/host-call-inputs.js"
import { FixtureDeskRefusedError, fixtureDeskRefusal } from "../contracts/fixture-desk-policy.js"
import { CLIENT_CALL_ON_SOCKET, isClientCall } from "../contracts/client-calls.js"
import { HostCallLifetime } from "../host-call-lifetime.js"
import { ControlPreviewSchema, type ControlPreview } from "@mako/control-runtime/contracts"

let routeConversation: ((channel: string, args: unknown[]) => Promise<ConversationRoutingResult>) | undefined
let presentHistory: (<Result>(value: Result) => Result) | undefined

export function installHistoryPresentation(present: NonNullable<typeof presentHistory>): void {
  presentHistory = present
}

export function installConversationRouting(route: NonNullable<typeof routeConversation>): void {
  routeConversation = route
}

const calls = new Map<string, (args: unknown[]) => Promise<string>>()
let previewCall: ((args: unknown[]) => Promise<ControlPreview | null>) | undefined
const lifetime = new HostCallLifetime()
export const stopHostCalls = () => lifetime.close()
let fixtureDesk = false

/**
 * From now on the socket refuses calls outside the fixture allowlist before
 * their arguments are parsed. There is no way back for this process.
 */
export function enforceFixtureDesk(): void {
  fixtureDesk = true
}

function refuseOutsideFixture(channel: string): void {
  const refusal = fixtureDesk ? fixtureDeskRefusal(channel, "socket") : undefined
  if (refusal) throw new FixtureDeskRefusedError(refusal)
}

/** Every reply is encoded here: the socket carries JSON to every client. */
export async function invokeHost(channel: string, args: unknown[], client = "web", history = hostHistoryPaging(), correlationId?: string): Promise<string> {
  if (isClientCall(channel)) throw new Error(CLIENT_CALL_ON_SOCKET)
  refuseOutsideFixture(channel)
  if (channel === "mako:control-preview") throw new Error("Preview delivery requires a matching binary-capable client. Update the Mako client and host.")
  const call = calls.get(channel)
  if (!call) throw new Error("Unknown Mako host method")
  return withHostClient(client, () => call(args), history, correlationId)
}

/** The same validated handler and client authority, without serializing pixels. */
export async function invokeHostPreview(args: unknown[], client = "web") {
  refuseOutsideFixture("mako:control-preview")
  const call = previewCall
  if (!call) throw new Error("Preview delivery is unavailable")
  return withHostClient(client, () => call(args), false)
}

/** Every call validates its arguments against the generated handler contract. */
export function registerIpc<Channel extends HostChannel, Result>(
  channel: Channel,
  listener: (_event: undefined, ...args: HostArguments<Channel>) => Result
): void {
  if (isClientCall(channel)) throw new Error(`${channel} is a client call; each client answers it itself`)
  const call = (args: unknown[]) => lifetime.run(async () => {
    refuseOutsideFixture(channel)
    // SAFETY: the schema is selected by this exact Channel and parses every argument; TypeScript loses that key/output correlation when indexing the heterogeneous table.
    const parsed = hostCallInput(channel).parse(args) as HostArguments<Channel>
    breadcrumb(channel)
    // A refused call is returned to the renderer. Recording it as a crash
    // filled the local store with expected validation errors and hid the
    // failures that actually killed a process.
    const routed = await routeConversation?.(channel, parsed)
    const value = routed?.handled ? routed.value : await listener(undefined, ...parsed)
    return hostHistoryPaging() && presentHistory ? presentHistory(value) : value
  })
  calls.set(channel, async (args) => JSON.stringify({ ok: true, value: await call(args) }))
  if (channel === "mako:control-preview")
    previewCall = async (args) => ControlPreviewSchema.nullable().parse(await call(args))
}
