import type { ConversationRoutingResult } from "../shared-conversations.js"
import { ipcMain } from "electron"
import { withHostClient, hostHistoryPaging } from "../host-client.js"
import { breadcrumb } from "../crash.js"
import { hostCallInputs } from "../contracts/host-call-inputs.js"
import { FixtureDeskRefusedError, fixtureDeskRefusal } from "../contracts/fixture-desk-policy.js"
import { HostCallLifetime } from "../host-call-lifetime.js"
import { ControlPreviewSchema, type ControlPreview } from "@mako/control-runtime/contracts"

type HostChannel = keyof typeof hostCallInputs
type HostArguments<Channel extends HostChannel> =
  (typeof hostCallInputs)[Channel]["_output"]
let routeConversation: ((channel: string, args: unknown[]) => Promise<ConversationRoutingResult>) | undefined
let presentHistory: (<Result>(value: Result) => Result) | undefined

export function installHistoryPresentation(present: NonNullable<typeof presentHistory>): void {
  presentHistory = present
}

export function installConversationRouting(route: NonNullable<typeof routeConversation>): void {
  routeConversation = route
}

const calls = new Map<string, (args: unknown[], transport: "page" | "socket") => Promise<string>>()
let previewCall: ((args: unknown[]) => Promise<ControlPreview | null>) | undefined
const lifetime = new HostCallLifetime()
export const stopHostCalls = () => lifetime.close()
let fixtureDesk = false

/**
 * From now on every transport refuses calls outside the fixture allowlist
 * before their arguments are parsed. There is no way back for this process.
 */
export function enforceFixtureDesk(): void {
  fixtureDesk = true
}

function refuseOutsideFixture(channel: string, transport: "page" | "socket" = "page"): void {
  const refusal = fixtureDesk ? fixtureDeskRefusal(channel, transport) : undefined
  if (refusal) throw new FixtureDeskRefusedError(refusal)
}

/** Web replies are encoded here so Electron keeps its original structured values. */
export async function invokeHost(channel: string, args: unknown[], client = "web", history = hostHistoryPaging()): Promise<string> {
  refuseOutsideFixture(channel, "socket")
  if (channel === "mako:control-preview") throw new Error("Preview delivery requires a matching binary-capable client. Update the Mako client and host.")
  const call = calls.get(channel)
  if (!call) throw new Error("Unknown Mako host method")
  return withHostClient(client, () => call(args, "socket"), history)
}

/** The same validated handler and client authority, without serializing pixels. */
export async function invokeHostPreview(args: unknown[], client = "web") {
  refuseOutsideFixture("mako:control-preview")
  const call = previewCall
  if (!call) throw new Error("Preview delivery is unavailable")
  return withHostClient(client, () => call(args), false)
}

/** Both transports validate arguments against the generated handler contract. */
export function registerIpc<Channel extends HostChannel, Result>(
  channel: Channel,
  listener: (_event: undefined, ...args: HostArguments<Channel>) => Result
): void {
  const call = (args: unknown[], transport: "page" | "socket" = "page") => lifetime.run(async () => {
    refuseOutsideFixture(channel, transport)
    // SAFETY: the schema is selected by this exact Channel and parses every argument; TypeScript loses that key/output correlation when indexing the heterogeneous table.
    const parsed = hostCallInputs[channel].parse(args) as HostArguments<Channel>
    breadcrumb(channel)
    // A refused call is returned to the renderer. Recording it as a crash
    // filled the local store with expected validation errors and hid the
    // failures that actually killed a process.
    const routed = await routeConversation?.(channel, parsed)
    const value = routed?.handled ? routed.value : await listener(undefined, ...parsed)
    return hostHistoryPaging() && presentHistory ? presentHistory(value) : value
  })
  calls.set(channel, async (args, transport) => JSON.stringify({ ok: true, value: await call(args, transport) }))
  if (channel === "mako:control-preview")
    previewCall = async (args) => ControlPreviewSchema.nullable().parse(await call(args))
  ipcMain.handle(channel, (event, ...args) => withHostClient(`renderer:${event.sender.id}`, () => call(args), true))
}
