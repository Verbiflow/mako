import type { HostArguments, HostChannel } from "./host-call-inputs.js"
import type { NotificationDelivery, NotificationPermission } from "./notifications.js"
import type { AppshotShortcutState } from "./appshot-shortcut.js"

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
  "mako:surface-window",
  "mako:appshot-shortcut",
  "mako:appshot-feedback",
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
  "mako:surface-window": void
  "mako:appshot-shortcut": AppshotShortcutState
  "mako:appshot-feedback": void
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
  // SAFETY: the caller parsed `args` with `call`'s schema, which is `HostArguments<typeof call>`; indexing the table by a union key loses that correlation.
  const answer = answers[call] as (context: Context, ...args: HostArguments<ClientCall>) => ClientCallResult | Promise<ClientCallResult>
  return answer(context, ...args)
}

export const CLIENT_CALL_ON_SOCKET =
  "The client answers this itself, on its own machine. Update the Mako client."

/** Why a client didn't open a link, in the words it throws. */
export const UNOPENABLE_LINK = "Mako opens only web links, and links that open a cloud Thread in your editor"

/** The editors a cloud Thread opens in, on the viewer's own computer, over SSH. */
export const REMOTE_EDITORS = ["cursor", "vscode", "zed", "jetbrains"] as const

export type RemoteEditor = (typeof REMOTE_EDITORS)[number]

/**
 * A cloud machine's name in the person's SSH config, which reaches it through
 * Mako's relay, never a server's address: an editor link names no other host.
 */
const REMOTE_HOST = /^mako-[A-Za-z0-9-]{1,64}$/

const VSCODE_REMOTE = /^\/ssh-remote\+([^/]+)\/./

/** Each editor's link, and whether a parsed link is exactly that shape; one table, so the two can't drift. */
type EditorLink = {
  build(host: string, folder: string, encoded: string): string
  matches(parsed: URL): boolean
}

const vscodeRemote = (scheme: string): EditorLink => ({
  build: (host, _folder, encoded) => `${scheme}://vscode-remote/ssh-remote+${host}${encoded}`,
  matches: (parsed) => {
    const remote = VSCODE_REMOTE.exec(parsed.pathname)
    return parsed.host === "vscode-remote" && !parsed.search && remote !== null && REMOTE_HOST.test(remote[1] ?? "")
  },
})

const EDITOR_LINKS = {
  cursor: vscodeRemote("cursor"),
  vscode: vscodeRemote("vscode"),
  zed: {
    build: (host, _folder, encoded) => `zed://ssh/${host}${encoded}`,
    matches: (parsed) => {
      const [, host, ...rest] = parsed.pathname.split("/")
      return parsed.host === "ssh" && !parsed.search && rest.some(Boolean) && REMOTE_HOST.test(host ?? "")
    },
  },
  jetbrains: {
    build: (host, folder) => `jetbrains://gateway/ssh/environment?${new URLSearchParams({ h: host, projectHint: folder })}`,
    matches: (parsed) => {
      const keys = [...parsed.searchParams.keys()].sort()
      return parsed.host === "gateway" && parsed.pathname === "/ssh/environment" && keys.join() === "h,projectHint"
        && REMOTE_HOST.test(parsed.searchParams.get("h") ?? "") && (parsed.searchParams.get("projectHint") ?? "").startsWith("/")
    },
  },
} satisfies Record<RemoteEditor, EditorLink>

const EDITOR_BY_SCHEME: ReadonlyMap<string, EditorLink> = new Map(REMOTE_EDITORS.map((editor) => [`${editor}:`, EDITOR_LINKS[editor]]))

/**
 * The link that opens `folder` on the machine SSH knows as `host` in
 * `editor`. Throws for a host that isn't one of Mako's or a relative folder,
 * which no caller should build.
 */
export function remoteEditorLink(editor: RemoteEditor, host: string, folder: string): string {
  if (!REMOTE_HOST.test(host)) throw new Error(`${JSON.stringify(host)} isn't a Mako machine's SSH name`)
  if (!folder.startsWith("/")) throw new Error(`${JSON.stringify(folder)} isn't an absolute path`)
  return EDITOR_LINKS[editor].build(host, folder, folder.split("/").map(encodeURIComponent).join("/"))
}

/** Whether `parsed` is exactly one of {@link remoteEditorLink}'s shapes. */
function isRemoteEditorLink(parsed: URL): boolean {
  if (parsed.username || parsed.password || parsed.port || parsed.hash) return false
  return EDITOR_BY_SCHEME.get(parsed.protocol)?.matches(parsed) ?? false
}

/**
 * The link a client may open, or `null`: http(s), and an editor opening a
 * cloud Thread's folder over SSH ({@link remoteEditorLink}). `open` and
 * `shell.openExternal` will run a `file:` URL or any custom scheme, and links
 * reach here from pages and data the app did not author.
 */
export function openableLink(url: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol === "http:" || parsed.protocol === "https:") return parsed.href
  return isRemoteEditorLink(parsed) ? parsed.href : null
}
