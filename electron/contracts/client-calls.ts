import type { HostArguments, HostChannel } from "./host-call-inputs.js"
import type { NotificationDelivery, NotificationPermission } from "./notifications.js"

/**
 * Calls a client answers on its own machine, never through the shared host.
 * Each acts on the screen in front of the person: a link opens in their
 * browser, text lands on their clipboard, a banner shows on their desktop.
 * The host can be another machine (a cloud host) or one with no screen at
 * all, so it never answers them.
 *
 * The desktop client answers them with Electron, the browser client with the
 * browser's own APIs; each keeps a table typed by {@link ClientAnswers}, so a
 * call added here and missing from either client doesn't compile.
 */
export const CLIENT_CALLS = [
  "mako:open-url",
  "mako:copy",
  "mako:notify",
  "mako:notify-dismiss",
  "mako:set-badge-count",
  "mako:notification-permission",
  "mako:request-notification-permission",
  "mako:open-preview-window",
  "mako:quit-client",
] as const satisfies readonly HostChannel[]

export type ClientCall = (typeof CLIENT_CALLS)[number]

const clientCalls: ReadonlySet<string> = new Set(CLIENT_CALLS)

export function isClientCall(channel: string): channel is ClientCall {
  return clientCalls.has(channel)
}

/**
 * Calls that act on the host machine's own screen: Finder, the folder chooser,
 * an editor window, System Settings. A client on that machine may make them,
 * over the socket; a client through the gateway is on another device, and
 * would open a window nobody is looking at, so the gateway never carries them.
 * Clients hide them by the host's `MachineOffer`.
 */
export const HOST_SCREEN_CALLS = [
  "mako:reveal",
  "mako:reveal-plugins",
  "mako:pick-folder",
  "mako:open-in-editor",
  "mako:computer-permissions-request",
] as const satisfies readonly HostChannel[]

const hostScreenCalls: ReadonlySet<string> = new Set(HOST_SCREEN_CALLS)

export function isHostScreenCall(channel: string): channel is (typeof HOST_SCREEN_CALLS)[number] {
  return hostScreenCalls.has(channel)
}

/** What a host answers on its socket, and so advertises: every call but the client calls. */
export function socketCalls<Channel extends string>(channels: readonly Channel[]): Channel[] {
  return channels.filter((channel) => !isClientCall(channel))
}

/** What a host answers through the gateway: what its socket answers, less what acts on its screen. */
export function gatewayCalls<Channel extends string>(channels: readonly Channel[]): Channel[] {
  return socketCalls(channels).filter((channel) => !isHostScreenCall(channel))
}

/** What each client call answers, as the renderer bridge reads it. */
export interface ClientCallResults {
  "mako:open-url": void
  "mako:copy": void
  "mako:notify": NotificationDelivery
  "mako:notify-dismiss": void
  "mako:set-badge-count": void
  "mako:notification-permission": NotificationPermission
  "mako:request-notification-permission": NotificationPermission
  "mako:open-preview-window": void
  "mako:quit-client": void
}

export type ClientCallResult = ClientCallResults[ClientCall]

/** One client's answers, by call; `Context` is what the client knows about who asked, like the window. */
export type ClientAnswers<Context> = {
  [Call in ClientCall]: (context: Context, ...args: HostArguments<Call>) => ClientCallResults[Call] | Promise<ClientCallResults[Call]>
}

export async function answerClientCall<Context>(
  answers: ClientAnswers<Context>,
  call: ClientCall,
  context: Context,
  args: HostArguments<ClientCall>
): Promise<ClientCallResult> {
  // SAFETY: the caller parsed `args` with `hostCallInput(call)`, which is `HostArguments<typeof call>`; indexing the table by a union key loses that correlation.
  const answer = answers[call] as (context: Context, ...args: HostArguments<ClientCall>) => ClientCallResult | Promise<ClientCallResult>
  return answer(context, ...args)
}

export const CLIENT_CALL_ON_SOCKET =
  "The client answers this itself, on its own machine. Update the Mako client."

/**
 * The link a client may open, or `null`: only http(s). `open` and
 * `shell.openExternal` will run a `file:` URL or a custom scheme, and links
 * reach here from pages and data the app did not author.
 */
export function openableLink(url: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.href : null
}
