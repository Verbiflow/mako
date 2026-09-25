import { PREVIEW_MEDIA_TYPE, collectPreviewMedia } from "@mako/control-runtime/contracts"
import {
  createMakoBridge,
  RuntimeInfoSchema,
  type RuntimeInfo,
  type HostEvent,
  type TerminalEvent,
} from "../../electron/shared.ts"
import { hostCallInputs } from "../../electron/contracts/host-call-inputs.ts"
import { invokeWithRecovery } from "../../electron/runtime-retry.ts"
import { hostCallReplay } from "../../electron/contracts/host-call-policy.ts"
import { RuntimeDisconnectedError, HOST_CLOSED_CODE, HOST_OUTAGE_MESSAGE, HOST_RESTARTING_CODE } from "../../electron/contracts/host-connection.ts"
import { setClientStorageScope } from "../lib/client-storage-scope"
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
  /**
   * What a non-OK proxy reply means. The dev proxy answers 403 itself when it
   * does not trust this page's origin and 502–504 when it could not reach the
   * host's socket; only the second is the host being away, and telling the
   * user to start a host that is running sent them in circles.
   */
  const refusal = (response: Response): Error => {
    if (response.status === 403)
      return new Error(
        `Mako refused this page's origin (${location.origin}). Open the URL provided by the Mako web server.`
      )
    if (response.status >= 502 && response.status <= 504)
      return new Error("The Mako host is unavailable. Open Mako on the computer running this web server.")
    return new Error(`The Mako host answered ${response.status} ${response.statusText}`.trimEnd())
  }
  // The reply body is the host's JSON answer, typed by the channel's contract
  // in `createMakoBridge`, the same way Electron's `ipcRenderer.invoke` is.
  const post = async (channel: string, args: unknown[], attempt: number) => {
    if (!connected) throw new RuntimeDisconnectedError(false)
    let reply: Response
    try {
      reply = await fetch("/__mako/rpc", {
        method: "POST",
        signal: AbortSignal.timeout(5 * 60_000),
        headers: { "content-type": "application/json", "x-mako-client": "web", "x-mako-window": clientId, "x-mako-history": "1", ...(channel === "mako:control-preview" ? { accept: PREVIEW_MEDIA_TYPE } : {}) },
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
      throw new RuntimeDisconnectedError(true)
    }
    if (reply.status === 502 || reply.status === 503 || reply.status === 504) throw new RuntimeDisconnectedError(true)
    if (!reply.ok) throw refusal(reply)
    if (channel === "mako:control-preview" && reply.headers.get("content-type") === PREVIEW_MEDIA_TYPE) {
      if (!reply.body) throw new Error("Missing preview response")
      const reader = reply.body.getReader()
      async function* chunks() {
        try { for (;;) { const next = await reader.read(); if (next.done) return; yield next.value } }
        finally { await reader.cancel(); reader.releaseLock() }
      }
      return (await collectPreviewMedia(chunks())).preview
    }
    // This transport shares createMakoBridge's result contract with Electron IPC.
    let result
    try { result = await reply.json() }
    catch {
      if (hostCallReplay(channel) === "read")
        throw new Error("Mako could not read the host response. The response was incomplete or invalid.")
      throw new RuntimeDisconnectedError(true)
    }
    if (!result.ok) {
      if (result.code === "owner-unavailable") throw new RuntimeDisconnectedError(result.unconfirmed ?? true, result.conversationId)
      if (result.code === HOST_RESTARTING_CODE) throw new RuntimeDisconnectedError(true)
      if (result.code === HOST_CLOSED_CODE) throw new RuntimeDisconnectedError(false)
      throw new Error(result.error)
    }
    if (channel === "mako:control-preview") throw new Error("Preview delivery requires a matching Mako client and host.")
    return result.value
  }
  /**
   * The same rule the desktop client applies: a read or an id-settled
   * mutation that the host dropped runs once more when the host is back; any
   * other mutation is told its outcome is unknown.
   */
  const invokeHost = (channel: string, args: unknown[]) => invokeWithRecovery(
    channel, (attempt) => post(channel, args, attempt),
    { lost() { /* The independent event stream owns connection status. */ }, whenConnected }
  )
  const response = await fetch("/__mako/events", {
    method: "POST",
    headers: { "x-mako-client": "web", "x-mako-window": clientId, "x-mako-history": "1" },
  })
  if (!response.ok) throw refusal(response)
  if (!response.body)
    throw new Error("The Mako host is unavailable. Open Mako on the computer running this web server.")
  let reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
  const dispatch = (line: string) => {
    if (!line.trim()) return
    // Same typed producer as Electron IPC; only the authenticated local host writes this stream.
    const event: WebEvent = JSON.parse(line)
    if (event.channel === "ready") {
      if (event.runtime || import.meta.env.MAKO_SHARED_RUNTIME === true) supported = new Set(RuntimeInfoSchema.parse(event.runtime).methods)
      if (event.runtime?.storageScope) {
        try { setClientStorageScope(event.runtime.storageScope) }
        catch (error) {
          stopped = true
          connected = false
          settle(false)
          for (const listener of events) listener({ type: "host-disconnected", message: error instanceof Error ? error.message : "The Mako host changed. Reload this page." })
          void reader.cancel().catch(() => {})
          return
        }
      }
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
  window.addEventListener("pagehide", (event) => {
    // A cached page is suspended, not disposed. The existing reader/reconnect
    // loop resumes with it; canceling it and permanently stopping loses the tab.
    if (event.persisted) return
    stopped = true
    settle(false)
    void reader.cancel().catch(() => {})
  })
  window.addEventListener("pageshow", (event) => {
    if (!event.persisted || stopped) return
    // Force a fresh subscription and authoritative hydration after suspension.
    connected = false
    void reader.cancel().catch(() => {})
  })
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
          const next = await fetch("/__mako/events", { method: "POST", headers: { "x-mako-client": "web", "x-mako-window": clientId, "x-mako-history": "1" } })
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
