import { z } from "zod"
import { CONTROL_VIDEO_BATCH_TYPE, PREVIEW_MEDIA_TYPE, collectPreviewMedia, decodeControlVideoBatch } from "@mako/control-runtime/contracts"
import { createMakoBridge } from "@mako/host/contracts/renderer-bridge"
import { RuntimeInfoSchema, type RuntimeInfo, CORRELATION_HEADER, RuntimeReplySchema, encodeRuntimeCall, runtimeReplyValue } from "@mako/host/contracts/runtime"
import { type HostEvent } from "@mako/host/contracts/host-events-boot"
import { type TerminalEvent } from "@mako/host/contracts/terminal"
import { HostCallInputs } from "@mako/host/contracts/host-call-inputs"
import { answerClientCall, isClientCall, openableLink, type ClientAnswers } from "@mako/host/contracts/client-calls"
import { invokeWithRecovery } from "@mako/host/contracts/host-call-recovery"
import { hostCallReplay } from "@mako/host/contracts/host-call-policy"
import { HostCallTimeoutError, RuntimeDisconnectedError, HOST_OUTAGE_MESSAGE } from "@mako/host/contracts/host-connection"
import { HostLiveness } from "@mako/host/contracts/host-liveness"
import { setClientStorageScope } from "../lib/client-storage-scope"
import { createWebNotificationChannels } from "./web-notifications.ts"

type WebEvent =
  | { channel: "ready"; runtime?: RuntimeInfo }
  | { channel: "event"; payload: HostEvent }
  | { channel: "terminal"; payload: TerminalEvent }

/** Vite forwards only same-origin requests to the actual host's private socket. */
export async function installWebBridge(): Promise<void> {
  if (import.meta.env.MAKO_SHARED_RUNTIME === true && import.meta.env.MAKO_CLIENT_PROFILE) {
    const url = new URL(location.href)
    url.searchParams.set("profile", import.meta.env.MAKO_CLIENT_PROFILE)
    history.replaceState(null, "", url)
  }
  const events = new Set<(event: HostEvent) => void>()
  const terminals = new Set<(event: TerminalEvent) => void>()
  let stopped = false
  let supported: ReadonlySet<string> | null = null
  const clientId = crypto.randomUUID()
  // The same rule as the desktop's windows (`host-liveness.ts`): the event stream says whether the host is there, and
  // a dropped call raises nothing by itself. The dev proxy forwards only calls and the stream, so the stream's
  // heartbeat is this page's only proof.
  const link = new HostLiveness({
    message: HOST_OUTAGE_MESSAGE,
    announce: (event) => { for (const listener of events) listener(event) },
    probe: async () => "unknown",
  })
  let stream = link.stream()
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
  const post = async (channel: string, args: unknown[], attempt: number, correlationId: string) => {
    if (!link.connected) throw new RuntimeDisconnectedError(false)
    const headers = new Headers({ "content-type": "application/json", "x-mako-client": "web", "x-mako-window": clientId, "x-mako-history": "1", [CORRELATION_HEADER]: correlationId })
    if (channel === "mako:control-preview") headers.set("accept", PREVIEW_MEDIA_TYPE)
    if (channel === "mako:control-video") headers.set("accept", CONTROL_VIDEO_BATCH_TYPE)
    const body = encodeRuntimeCall(channel, args, attempt)
    let reply: Response
    try {
      reply = await fetch("/__mako/rpc", {
        method: "POST",
        signal: AbortSignal.timeout(5 * 60_000),
        headers,
        body,
      })
    } catch (error) {
      // No answer in five minutes: the host is slow, not gone.
      if (error instanceof DOMException && error.name === "TimeoutError")
        throw new HostCallTimeoutError(hostCallReplay(channel) !== "read")
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
    if (channel === "mako:control-video" && reply.headers.get("content-type") === CONTROL_VIDEO_BATCH_TYPE) {
      const bytes = new Uint8Array(await reply.arrayBuffer())
      decodeControlVideoBatch(bytes)
      return bytes
    }
    // This transport shares createMakoBridge's result contract with Electron IPC.
    const result = RuntimeReplySchema.safeParse(await reply.json().catch(() => undefined))
    if (!result.success) {
      if (hostCallReplay(channel) === "read")
        throw new Error("Mako could not read the host response. The response was incomplete or invalid.")
      throw new RuntimeDisconnectedError(true)
    }
    const value = runtimeReplyValue(result.data)
    if (channel === "mako:control-preview" || channel === "mako:control-video") throw new Error("Preview delivery requires a matching Mako client and host.")
    return value
  }
  /**
   * The same rule the desktop client applies: a read or an id-settled
   * mutation that the host dropped runs once more when the host is back; any
   * other mutation is told its outcome is unknown.
   */
  const invokeHost = (channel: string, args: unknown[]) => {
    const correlationId = crypto.randomUUID()
    return invokeWithRecovery(channel, (attempt) => post(channel, args, attempt, correlationId), link)
  }
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
          link.dispose()
          for (const listener of events) listener({ type: "host-disconnected", message: error instanceof Error ? error.message : "The Mako host changed. Reload this page." })
          void reader.cancel().catch(() => {})
          return
        }
      }
      stream.ready()
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
    // Any bytes, the host's heartbeat included, show the host is there.
    stream.heard()
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
  while (!link.connected) {
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
  // Links, the clipboard and the preview window are this browser's too: the
  // host may be another machine, or have no screen (`contracts/client-calls.ts`).
  const clientAnswers: ClientAnswers<undefined> = {
    "mako:open-url": (_page, url) => {
      const link = openableLink(url)
      if (!link) throw new Error("Mako opens only http and https links")
      window.open(link, "_blank", "noopener,noreferrer")
    },
    "mako:copy": (_page, text) => navigator.clipboard.writeText(text),
    "mako:notify": (_page, notification) => notifications.notify(notification),
    "mako:notify-dismiss": (_page, subject) => { notifications.dismiss(subject) },
    "mako:set-badge-count": (_page, count) => { notifications.badge(count) },
    "mako:notification-permission": () => notifications.permission(),
    "mako:request-notification-permission": () => notifications.requestPermission(),
    "mako:open-preview-window": () => {
      const url = new URL(location.href)
      url.searchParams.set("preview", crypto.randomUUID())
      window.open(url.href, "_blank", "noopener")
    },
    // A tab cannot close itself, and the host's quit-client hides the desktop
    // windows. After a host restart this page reconnects on its own.
    "mako:quit-client": () => {},
    // A page can only ask; the browser decides whether its tab comes forward.
    "mako:surface-window": () => { window.focus() },
    // A browser tab can't hold a key for the whole Mac or draw outside itself.
    "mako:appshot-shortcut": () => ({ state: "unavailable", reason: "The capture shortcut works in the Mako desktop app." }),
    "mako:appshot-feedback": () => {},
  }
  const inputs = new HostCallInputs()
  const answer = async (channel: string, args: unknown[]) => {
    if (isClientCall(channel)) return answerClientCall(clientAnswers, channel, undefined, inputs.of(channel).parse(args))
    if (supported && !supported.has(channel)) throw new Error("This action requires a newer shared host. Existing agents have not been restarted.")
    const value = await invokeHost(channel, args)
    if (channel === "mako:boot" && import.meta.env.MAKO_SOURCE_ROOT) return { ...z.record(z.string(), z.json()).parse(value), sourceRoot: import.meta.env.MAKO_SOURCE_ROOT }
    return value
  }
  window.mako = createMakoBridge({
    // SAFETY: as with Electron's ipcRenderer.invoke, the answer is the channel handler's own result, and createMakoBridge names its type per channel.
    invoke: async <Result>(channel: string, ...args: unknown[]) => (await answer(channel, args)) as Result,
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
    link.dispose()
    void reader.cancel().catch(() => {})
  })
  window.addEventListener("pageshow", (event) => {
    if (!event.persisted || stopped) return
    // Force a fresh subscription and authoritative hydration after suspension.
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
        // An unreadable stream ends like a closed one.
      } finally {
        reader.releaseLock()
      }
      if (stopped) return
      stream.ended()
      for (let attempt = 0; !stopped; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, Math.min(4_000, 500 * (attempt + 1))))
        try {
          const next = await fetch("/__mako/events", { method: "POST", headers: { "x-mako-client": "web", "x-mako-window": clientId, "x-mako-history": "1" } })
          if (!next.ok || !next.body) continue
          reader = next.body.pipeThrough(new TextDecoderStream()).getReader()
          stream = link.stream()
          parts.length = 0
          pendingLength = 0
          break
        } catch { /* Not back yet. */ }
      }
    }
  })()
}
