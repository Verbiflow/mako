import type { ConversationRoutingResult } from "../shared-conversations.js"
import { ipcMain } from "electron"
import { withHostClient, hostHistoryPaging } from "../host-client.js"
import { breadcrumb } from "../crash.js"
import { hostCallInputs } from "../contracts/host-call-inputs.js"
import { HostCallLifetime } from "../host-call-lifetime.js"
import { ControlPreviewSchema } from "@mako/control-runtime/contracts"

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

const calls = new Map<string, (args: unknown[]) => Promise<unknown>>()
const lifetime = new HostCallLifetime()
export const stopHostCalls = () => lifetime.close()

/** Web replies are encoded here so Electron keeps its original structured values. */
export async function invokeHost(channel: string, args: unknown[], client = "web", history = hostHistoryPaging()): Promise<string> {
  if (channel === "mako:control-preview") throw new Error("Preview delivery requires a matching binary-capable client. Update the Mako client and host.")
  const call = calls.get(channel)
  if (!call) throw new Error("Unknown Mako host method")
  return JSON.stringify({ ok: true, value: await withHostClient(client, () => call(args), history) })
}

/** The same validated handler and client authority, without serializing pixels. */
export async function invokeHostPreview(args: unknown[], client = "web") {
  const call = calls.get("mako:control-preview")
  if (!call) throw new Error("Preview delivery is unavailable")
  return ControlPreviewSchema.nullable().parse(await withHostClient(client, () => call(args), false))
}

/** Both transports validate arguments against the generated handler contract. */
export function registerIpc<Channel extends HostChannel, Result>(
  channel: Channel,
  listener: (_event: undefined, ...args: HostArguments<Channel>) => Result
): void {
  const call = (args: unknown[]) => lifetime.run(async () => {
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
  calls.set(channel, call)
  ipcMain.handle(channel, (event, ...args) => withHostClient(`renderer:${event.sender.id}`, () => call(args), true))
}
