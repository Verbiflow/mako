import type { ConversationRoutingResult } from "../shared-conversations.js"
import { ipcMain } from "electron"
import { withHostClient } from "../host-client.js"
import { breadcrumb } from "../crash.js"
import { hostCallInputs } from "../contracts/host-call-inputs.js"

type HostChannel = keyof typeof hostCallInputs
type HostArguments<Channel extends HostChannel> =
  (typeof hostCallInputs)[Channel]["_output"]
let routeConversation: ((channel: string, args: unknown[]) => Promise<ConversationRoutingResult>) | undefined

export function installConversationRouting(route: NonNullable<typeof routeConversation>): void {
  routeConversation = route
}

const calls = new Map<string, (args: unknown[]) => Promise<string>>()

/** Web replies are encoded here so Electron keeps its original structured values. */
export function invokeHost(channel: string, args: unknown[], client = "web"): Promise<string> {
  const call = calls.get(channel)
  if (!call) throw new Error("Unknown Mako host method")
  return withHostClient(client, () => call(args))
}

/** Both transports validate arguments against the generated handler contract. */
export function registerIpc<Channel extends HostChannel, Result>(
  channel: Channel,
  listener: (_event: undefined, ...args: HostArguments<Channel>) => Result
): void {
  const call = async (args: unknown[]) => {
    // SAFETY: the schema is selected by this exact Channel and parses every argument; TypeScript loses that key/output correlation when indexing the heterogeneous table.
    const parsed = hostCallInputs[channel].parse(args) as HostArguments<Channel>
    breadcrumb(channel)
    // A refused call is returned to the renderer. Recording it as a crash
    // filled the local store with expected validation errors and hid the
    // failures that actually killed a process.
    const routed = await routeConversation?.(channel, parsed)
    if (routed?.handled) return routed.value
    return await listener(undefined, ...parsed)
  }
  calls.set(channel, async (args) =>
    JSON.stringify({ ok: true, value: await call(args) })
  )
  ipcMain.handle(channel, (event, ...args) => withHostClient(`renderer:${event.sender.id}`, () => call(args)))
}
