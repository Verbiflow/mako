import { useEffect } from "react"
import type { ThreadAppView } from "@mako/host/contracts/thread-app"
import { createHook, createStore } from "@/state/store"
import type { WebClient } from "./client"
import { GatewayError } from "./gateway"
import { ownerCall, previewAddress, type Owner } from "./start"

/**
 * A Thread's app as a phone shows it: one server per process of it that listens on a port, each Ready, Starting… or
 * Stopped, read from its owner (`mako:thread-app`, the call the desk's app strip makes) while the Thread is on screen
 * and the page is in front, closely while something starts and now and then once it settles, never while the page is
 * hidden. The address each opens at is a grant of the gateway's (`previewAddress`), kept for its life so opening it
 * again is instant.
 */

export type ServerState = "ready" | "starting" | "stopped"

export interface PreviewServer {
  /** The recipe's name for the process: `web`, `api`. */
  name: string
  port: number
  state: ServerState
}

/** A Thread's app as last read: its servers, and whether it can be run from here. */
export interface ThreadApp {
  servers: PreviewServer[]
  /** The app is set up and stopped: Run starts it. */
  runnable: boolean
  /** What stands in the way, in a sentence, when it isn't set up or can't be read. */
  reason?: string
  at: number
}

export const appsStore = createStore<{ apps: ReadonlyMap<string, ThreadApp>; conversations: ReadonlyMap<string, string> }>({ apps: new Map(), conversations: new Map() })
export const useApps = createHook(appsStore)

/**
 * How a conversation's app stands, for its capsule: `running` once a server of it is ready, `starting` while one is on
 * its way up, nothing otherwise.
 */
export function useAppStanding(conversation: string): "running" | "starting" | undefined {
  return useApps((state) => {
    const key = state.conversations.get(conversation)
    const servers = key ? state.apps.get(key)?.servers : undefined
    if (servers?.some((server) => server.state === "ready")) return "running"
    if (servers?.some((server) => server.state === "starting")) return "starting"
    return undefined
  })
}

/** Where a Thread's app is kept: its owner and its folder. */
export function appKey(owner: Owner, folder: string): string {
  return `${owner.kind === "cloud" ? owner.threadId : owner.deviceId}:${folder}`
}

/** An app's view as servers: every process with a port, the web one first as the host orders them. */
export function serversOf(view: ThreadAppView): Omit<ThreadApp, "at"> {
  if (view.kind === "none") return { servers: [], runnable: false, reason: "This project's app isn't set up yet. Set it up from a Mac, and it opens here after." }
  if (view.kind === "invalid") return { servers: [], runnable: false, reason: view.message }
  if (view.kind === "setting-up") return { servers: [], runnable: false, reason: "Its app is being set up. It opens here once it runs." }
  // A cloud machine asleep: running the app wakes it.
  if (view.kind === "asleep") return { servers: [], runnable: true }
  const appUp = view.phase === "running" || view.phase === "starting" || view.phase === "preparing"
  const servers: PreviewServer[] = []
  for (const process of view.processes) {
    if (process.port === undefined) continue
    const state: ServerState = !appUp || process.state === "exited" || process.state === "stopped" ? "stopped" : process.state === "running" && view.phase === "running" ? "ready" : "starting"
    servers.push({ name: process.name, port: process.port, state })
  }
  // The address the host names first leads.
  const lead = view.address?.port
  servers.sort((left, right) => Number(right.port === lead) - Number(left.port === lead))
  return { servers, runnable: !appUp && view.phase !== "waiting" }
}

/** Whether anything of an app is on its way up: it's read again closely until it settles. */
export function settling(app: ThreadApp | undefined): boolean {
  return app?.servers.some((server) => server.state === "starting") ?? false
}

/** How soon an app is read again: closely while it starts, now and then once it settles. */
export const APP_STARTING_MS = 1_500
export const APP_SETTLED_MS = 10_000

/** Reads a Thread's app now, keeping what it says; a failure keeps what was there, with why. */
export async function readApp(client: WebClient, owner: Owner, folder: string): Promise<ThreadApp | undefined> {
  const key = appKey(owner, folder)
  let app: ThreadApp
  try {
    app = { ...serversOf(await ownerCall<ThreadAppView>(client.gateway, client.deviceId, owner, "mako:thread-app", [folder])), at: Date.now() }
  } catch (error) {
    const held = appsStore.get().apps.get(key)
    app = { servers: held?.servers ?? [], runnable: false, reason: error instanceof Error ? error.message : String(error), at: Date.now() }
  }
  const apps = new Map(appsStore.get().apps)
  apps.set(key, app)
  appsStore.set({ apps })
  return app
}

/**
 * Follows a Thread's app while `on` (the Thread on screen) and the page is in front: read at once, again closely while
 * a server starts, and every ten seconds once it's settled; nothing while hidden, read again the moment it's back.
 */
export function useThreadApp(client: WebClient, conversation: string, owner: Owner, folder: string | undefined, on: boolean): void {
  const ownerId = owner.kind === "cloud" ? owner.threadId : owner.deviceId
  const ownerKind = owner.kind
  useEffect(() => {
    if (!on || !folder) return
    const asked: Owner = ownerKind === "cloud" ? { kind: "cloud", threadId: ownerId } : { kind: "mac", deviceId: ownerId }
    const conversations = new Map(appsStore.get().conversations)
    conversations.set(conversation, appKey(asked, folder))
    appsStore.set({ conversations })
    let timer: ReturnType<typeof setTimeout> | undefined
    let stopped = false
    const look = async () => {
      clearTimeout(timer)
      if (stopped || document.visibilityState !== "visible") return
      const app = await readApp(client, asked, folder)
      if (stopped || document.visibilityState !== "visible") return
      timer = setTimeout(() => void look(), settling(app) ? APP_STARTING_MS : APP_SETTLED_MS)
    }
    const shown = () => void look()
    void look()
    document.addEventListener("visibilitychange", shown)
    return () => {
      stopped = true
      clearTimeout(timer)
      document.removeEventListener("visibilitychange", shown)
    }
  }, [client, conversation, ownerKind, ownerId, folder, on])
}

/** A grant's address, kept until a few minutes before it ends: opening the app again doesn't ask for another. */
const grants = new Map<string, { url: string; until: number }>()
const GRANT_MARGIN_MS = 5 * 60_000

/** Why a preview can't open, in a sentence; the gateway's refusal for too many says so in the card's own words. */
export class PreviewRefused extends Error {
  readonly tooMany: boolean
  constructor(message: string, tooMany: boolean) {
    super(message)
    this.name = "PreviewRefused"
    this.tooMany = tooMany
  }
}

/**
 * The address a Thread's server opens at on this phone: a grant of the gateway's on an origin of its own, kept while it
 * lasts. Refused, it says why; one on Mako's own origin is never opened (an agent's page would act as the person).
 */
export async function serverAddress(client: WebClient, owner: Owner, port: number): Promise<string> {
  const key = `${owner.kind === "cloud" ? owner.threadId : owner.deviceId}:${port}`
  const kept = grants.get(key)
  if (kept && kept.until > Date.now()) return kept.url
  let granted: { url: string; expiresAt: number }
  try {
    granted = await previewAddress(client.gateway, owner, port)
  } catch (error) {
    if (error instanceof GatewayError && error.status === 429) throw new PreviewRefused("Too many previews open", true)
    throw new PreviewRefused(error instanceof Error ? error.message : String(error), false)
  }
  if (new URL(granted.url).origin === location.origin) throw new PreviewRefused("The gateway offered this app on Mako's own address, so it isn't opened here.", false)
  grants.set(key, { url: granted.url, until: granted.expiresAt - GRANT_MARGIN_MS })
  return granted.url
}

/** A link's address on a computer's own loopback (`localhost:5173/login`): its port and path, or nothing for any other. */
export function loopbackTarget(href: string): { port: number; path: string } | undefined {
  let url: URL
  try {
    url = new URL(href)
  } catch {
    return undefined
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined
  const host = url.hostname.replace(/^\[|\]$/g, "")
  if (host !== "localhost" && host !== "127.0.0.1" && host !== "0.0.0.0" && host !== "::1" && !host.endsWith(".localhost")) return undefined
  const port = Number(url.port || (url.protocol === "https:" ? 443 : 80))
  return { port, path: `${url.pathname}${url.search}${url.hash}` }
}

/** A grant's address with a page's own path on it: the gateway serves every path of the port it grants. */
export function withPath(address: string, path: string): string {
  if (!path || path === "/") return address
  const url = new URL(address)
  const target = new URL(path, url)
  return target.origin === url.origin ? target.href : address
}

/**
 * What the Thread on screen asks to preview: its app (a server, or the first), or a link from its transcript. Opened
 * from the capsule, the cards or a link, and closed by the sheet.
 */
export type PreviewAsk = { port?: number; path?: string; at: number }
export const previewAskStore = createStore<{ conversation?: string; ask?: PreviewAsk }>({})
export const usePreviewAsk = createHook(previewAskStore)

/** Opens the preview of the conversation on screen, at a server or a path. */
export function askPreview(conversation: string, ask: Omit<PreviewAsk, "at"> = {}): void {
  previewAskStore.set({ conversation, ask: { ...ask, at: Date.now() } })
}

export function closePreview(): void {
  previewAskStore.set({ conversation: undefined, ask: undefined })
}
