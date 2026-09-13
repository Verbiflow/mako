import {
  createMakoBridge,
  RuntimeInfoSchema,
  type RuntimeInfo,
  type HostEvent,
  type TerminalEvent,
} from "../../electron/shared.ts"
import { hostCallInputs } from "../../electron/contracts/host-call-inputs.ts"
import { HOST_CALL_REPLAY_WAIT_MS, hostCallReplay } from "../../electron/contracts/host-call-policy.ts"
import { HOST_CALL_UNCONFIRMED_MESSAGE, HOST_CLOSED_CODE, HOST_OUTAGE_MESSAGE, HOST_RECONNECTING_MESSAGE, HOST_RESTARTING_CODE } from "../../electron/contracts/host-connection.ts"
import { createWebNotificationChannels } from "./web-notifications.ts"

type WebEvent =
  | { channel: "ready"; runtime?: RuntimeInfo }
  | { channel: "event"; payload: HostEvent }
  | { channel: "terminal"; payload: TerminalEvent }

/** Vite forwards only same-origin requests to the actual host's private socket. */
export async function installWebBridge(): Promise<void> {
  if (import.meta.env.MAKO_SHARED_RUNTIME === true) {
    const url = new URL(location.href)
    url.searchParams.set("runtime", "shared")
    if (import.meta.env.MAKO_CLIENT_PROFILE) url.searchParams.set("profile", import.meta.env.MAKO_CLIENT_PROFILE)
    history.replaceState(null, "", url)
  }
  const events = new Set<(event: HostEvent) => void>()
  const terminals = new Set<(event: TerminalEvent) => void>()
  let connected = false
  let seen = false
  let stopped = false
  let supported: ReadonlySet<string> | null = null
  const clientId = crypto.randomUUID()
  const waiters = new Set<(connected: boolean) => void>()
  const settle = (value: boolean) => {
    for (const waiter of waiters) waiter(value)
    waiters.clear()
  }
  const whenConnected = (timeoutMs: number) =>
    new Promise<boolean>((resolve) => {
      if (connected) { resolve(true); return }
      if (stopped) { resolve(false); return }
      const deadline = setTimeout(() => { waiters.delete(waiter); resolve(false) }, timeoutMs)
      const waiter = (value: boolean) => { clearTimeout(deadline); resolve(value) }
      waiters.add(waiter)
    })
  /** The host went away under a call; `unconfirmed` when it may have run first. */
  class Disconnected extends Error {
    readonly unconfirmed: boolean
    constructor(unconfirmed: boolean) {
      super(unconfirmed ? HOST_CALL_UNCONFIRMED_MESSAGE : HOST_RECONNECTING_MESSAGE)
      this.unconfirmed = unconfirmed
    }
  }
  // The reply body is the host's JSON answer, typed by the channel's contract
  // in `createMakoBridge`, the same way Electron's `ipcRenderer.invoke` is.
  const post = async (channel: string, args: unknown[], attempt: number) => {
    if (!connected) throw new Disconnected(false)
    let reply: Response
    try {
      reply = await fetch("/__mako/rpc", {
        method: "POST",
        headers: { "content-type": "application/json", "x-mako-client": "web", "x-mako-window": clientId },
        body: JSON.stringify({
          channel,
          args: args.map((value) =>
            value === undefined ? { kind: "absent" } : { kind: "value", value }
          ),
          attempt: attempt > 1 ? attempt : undefined,
        }),
      })
    } catch {
      // The proxy could not reach the socket or the connection reset: the
      // request may have been read before the host left.
      throw new Disconnected(true)
    }
    if (reply.status === 502 || reply.status === 503 || reply.status === 504) throw new Disconnected(false)
    if (!reply.ok) throw new Error("The Mako host is unavailable")
    // This transport shares createMakoBridge's result contract with Electron IPC.
    const result = await reply.json()
    if (!result.ok) {
      if (result.code === HOST_RESTARTING_CODE) throw new Disconnected(true)
      if (result.code === HOST_CLOSED_CODE) throw new Disconnected(false)
      throw new Error(result.error)
    }
    return result.value
  }
  /**
   * The same rule the desktop client applies: a read or an id-settled
   * mutation that the host dropped runs once more when the host is back; any
   * other mutation is told its outcome is unknown.
   */
  const invokeHost = async (channel: string, args: unknown[]) => {
    try {
      return await post(channel, args, 1)
    } catch (error) {
      if (!(error instanceof Disconnected)) throw error
      if (hostCallReplay(channel) === "never") throw error
      if (!(await whenConnected(HOST_CALL_REPLAY_WAIT_MS))) throw error
      return post(channel, args, 2)
    }
  }
  const response = await fetch("/__mako/events", {
    method: "POST",
    headers: { "x-mako-client": "web", "x-mako-window": clientId },
  })
  if (!response.ok || !response.body)
    throw new Error(
      "The real Mako host is unavailable. Start it with npm run web."
    )
  let reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
  const dispatch = (line: string) => {
    if (!line.trim()) return
    // Same typed producer as Electron IPC; only the authenticated local host writes this stream.
    const event: WebEvent = JSON.parse(line)
    if (event.channel === "ready") {
      if (event.runtime || import.meta.env.MAKO_SHARED_RUNTIME === true) supported = new Set(RuntimeInfoSchema.parse(event.runtime).methods)
      connected = true
      settle(true)
      if (seen) for (const listener of events) listener({ type: "host-reconnected" })
      seen = true
    } else if (event.channel === "event") {
      for (const listener of events) listener(event.payload)
    } else {
      for (const listener of terminals) listener(event.payload)
    }
  }
  // Each chunk is scanned once; pieces of an unfinished line are joined only
  // when its newline arrives, so a multi-megabyte packet is not re-searched
  // for every chunk that carries part of it.
  const parts: string[] = []
  let pendingLength = 0
  const consume = (chunk: string) => {
    let text = chunk
    let newline = text.indexOf("\n")
    while (newline >= 0) {
      const head = text.slice(0, newline)
      if (parts.length) {
        parts.push(head)
        dispatch(parts.join(""))
        parts.length = 0
      } else dispatch(head)
      pendingLength = 0
      text = text.slice(newline + 1)
      newline = text.indexOf("\n")
    }
    if (text) {
      parts.push(text)
      pendingLength += text.length
      if (pendingLength > 32 * 1024 * 1024)
        throw new Error("Mako host event exceeds the web transport limit")
    }
  }
  while (!connected) {
    const chunk = await reader.read()
    if (chunk.done)
      throw new Error("Mako host closed before the web desk was ready")
    consume(chunk.value)
  }
  // Banners and the badge are this page's, not the host's: the same split the
  // desktop client makes, answered with the browser's own APIs.
  const notifications = createWebNotificationChannels((event) => {
    for (const listener of events) listener(event)
  })
  window.mako = createMakoBridge({
    async invoke(channel, ...args) {
      if (channel === "mako:open-preview-window") {
        const url = new URL(location.href)
        url.searchParams.set("preview", crypto.randomUUID())
        window.open(url.href, "_blank", "noopener")
        return
      }
      if (channel === "mako:notify")
        return notifications.notify(hostCallInputs["mako:notify"].parse(args)[0])
      if (channel === "mako:notify-dismiss") {
        notifications.dismiss(hostCallInputs["mako:notify-dismiss"].parse(args)[0])
        return
      }
      if (channel === "mako:set-badge-count") {
        notifications.badge(hostCallInputs["mako:set-badge-count"].parse(args)[0])
        return
      }
      if (channel === "mako:notification-permission") return notifications.permission()
      if (channel === "mako:request-notification-permission")
        return notifications.requestPermission()
      if (supported && !supported.has(channel)) throw new Error("This action requires a newer shared host. Existing agents have not been restarted.")
      const value = await invokeHost(channel, args)
      if (channel === "mako:boot" && import.meta.env.MAKO_SOURCE_ROOT) return { ...value, sourceRoot: import.meta.env.MAKO_SOURCE_ROOT }
      return value
    },
    onEvent: (listener) => {
      events.add(listener)
      return () => {
        events.delete(listener)
      }
    },
    onTerminalEvent: (listener) => {
      terminals.add(listener)
      return () => {
        terminals.delete(listener)
      }
    },
    pathForFile: () => null,
    resolveFileUrl: (url) => {
      if (!url.startsWith("mako-file:")) return url
      const target = new URL(url)
      target.searchParams.set("client", clientId)
      return target.href.replace(/^mako-file:\/\/(asset|workspace)\//, "/__mako/file/$1/")
    },
  })
  window.addEventListener("pagehide", () => { stopped = true; settle(false); void reader.cancel().catch(() => {}) }, { once: true })
  void (async () => {
    while (!stopped) {
      try {
        for (;;) {
          const chunk = await reader.read()
          if (chunk.done) break
          consume(chunk.value)
        }
      } catch {
        connected = false
      } finally {
        connected = false
        reader.releaseLock()
      }
      if (stopped) return
      for (const listener of events) listener({ type: "host-disconnected", message: HOST_OUTAGE_MESSAGE })
      for (let attempt = 0; !stopped; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, Math.min(4_000, 500 * (attempt + 1))))
        try {
          const next = await fetch("/__mako/events", { method: "POST", headers: { "x-mako-client": "web", "x-mako-window": clientId } })
          if (!next.ok || !next.body) continue
          reader = next.body.pipeThrough(new TextDecoderStream()).getReader()
          parts.length = 0
          pendingLength = 0
          break
        } catch { connected = false }
      }
    }
  })()
}
