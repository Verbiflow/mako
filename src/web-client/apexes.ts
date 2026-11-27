import { useEffect, useMemo } from "react"
import { apexDigest, parsePlan, routeFor, type ApexDigest, type ApexEntry, type ApexPlanReading, type RouteCandidate } from "@mako/host/contracts/apexes"
import type { NativeAgent } from "@mako/host/contracts/native-agents"
import { createHook, createStore } from "@/state/store"
import type { WebClient } from "./client"
import { macCall } from "./start"

/**
 * The person's deliberate Apexes as each Mac keeps them (`mako:apexes`), and each one's plan, read through the Mac
 * that holds its Thread as its own window reads them. What a Mac that's off last said stays.
 */
interface WebApexesState {
  byDevice: Readonly<Record<string, readonly ApexEntry[]>>
  plans: Readonly<Record<string, string>>
}

export const webApexesStore = createStore<WebApexesState>({ byDevice: {}, plans: {} })
export const useWebApexes = createHook(webApexesStore)

const asked = new Set<string>()

/** Reads a Mac's Apexes once a screen asks for them, and again when `again` (a pull to refresh, a plan checked). */
export async function loadWebApexes(client: WebClient, deviceId: string, again = false): Promise<void> {
  if (asked.has(deviceId) && !again) return
  asked.add(deviceId)
  try {
    const apexes = await macCall<ApexEntry[]>(client.gateway, client.deviceId, deviceId, "mako:apexes", [], { passive: true })
    webApexesStore.set((state) => ({ ...state, byDevice: { ...state.byDevice, [deviceId]: apexes } }))
  } catch {
    asked.delete(deviceId)
  }
}

export async function loadWebPlan(client: WebClient, deviceId: string, thread: string): Promise<void> {
  try {
    const read = await macCall<ApexPlanReading>(client.gateway, client.deviceId, deviceId, "mako:apex-plan-read", [thread], { passive: true })
    webApexesStore.set((state) => ({ ...state, plans: { ...state.plans, [thread]: read.text } }))
  } catch {
    // A Mac that's off keeps its plan to itself: what this page read last stays, and the next screen asks again.
  }
}

/** A plan line the person did, from the phone: the Mac keeps it, and it leaves the digest on every device. */
export async function checkWebPlan(client: WebClient, deviceId: string, thread: string, section: string, item: number): Promise<boolean> {
  try {
    const saved = await macCall<ApexPlanReading | { refused: string; why: string }>(client.gateway, client.deviceId, deviceId, "mako:apex-plan-check", [thread, section, item, true])
    if ("refused" in saved) return false
    webApexesStore.set((state) => ({ ...state, plans: { ...state.plans, [thread]: saved.text } }))
    return true
  } catch {
    return false
  }
}

/** The person answers a question the Apex's plan asks, from the phone: the Mac sends their words to the Apex. */
export async function checkWebAnswer(client: WebClient, deviceId: string, thread: string, section: string, item: number, answer: string): Promise<boolean> {
  try {
    const saved = await macCall<ApexPlanReading | { refused: string; why: string }>(client.gateway, client.deviceId, deviceId, "mako:apex-plan-answer", [thread, section, item, answer])
    if ("refused" in saved) return false
    webApexesStore.set((state) => ({ ...state, plans: { ...state.plans, [thread]: saved.text } }))
    return true
  } catch {
    return false
  }
}

export function markWebSeen(client: WebClient, deviceId: string, thread: string): void {
  void macCall(client.gateway, client.deviceId, deviceId, "mako:apex-seen", [thread], { passive: true }).catch(() => undefined)
}

/** One Thread's deliberate Apex profile on its Mac, read once it's shown. */
export function useWebApex(client: WebClient, deviceId: string | undefined, thread: string): ApexEntry | undefined {
  useEffect(() => {
    if (deviceId) void loadWebApexes(client, deviceId)
  }, [client, deviceId])
  return useWebApexes((state) => (deviceId ? state.byDevice[deviceId]?.find((apex) => apex.thread === thread) : undefined))
}

/** Every Apex on every Mac this page has read. */
export function useEveryWebApex(): readonly (ApexEntry & { deviceId: string })[] {
  const byDevice = useWebApexes((state) => state.byDevice)
  return useMemo(() => Object.entries(byDevice).flatMap(([deviceId, apexes]) => apexes.map((apex) => ({ ...apex, deviceId }))), [byDevice])
}

/** The digest the Mac's note gives the Apex, from the same roster and plan: the same function, so they can't differ. */
export function useWebDigest(client: WebClient, deviceId: string | undefined, apex: ApexEntry | undefined, fins: readonly NativeAgent[], seenAt = apex?.seenAt): ApexDigest {
  const plan = useWebApexes((state) => (apex ? state.plans[apex.thread] : undefined))
  useEffect(() => {
    if (apex && deviceId && plan === undefined) void loadWebPlan(client, deviceId, apex.thread)
  }, [client, deviceId, apex, plan])
  return useMemo(() => apexDigest(fins, plan, seenAt), [fins, plan, seenAt])
}

/** A plan line that waits on the person, with where it is in its plan, to check it off. */
export interface WebPlanAsk {
  apex: ApexEntry & { deviceId: string }
  section: string
  index: number
  text: string
}

/** Every read Apex's plan lines that wait on the person, for the phone's Inbox. */
export function useWebPlanAsks(client: WebClient): WebPlanAsk[] {
  const apexes = useEveryWebApex()
  const plans = useWebApexes((state) => state.plans)
  useEffect(() => {
    for (const apex of apexes) if (plans[apex.thread] === undefined) void loadWebPlan(client, apex.deviceId, apex.thread)
  }, [client, apexes, plans])
  return useMemo(() => apexes.flatMap((apex) => {
    const plan = plans[apex.thread]
    if (!plan) return []
    return parsePlan(plan).sections.filter((section) => /^waiting on\b/i.test(section.name)).flatMap((section) =>
      section.items.flatMap((item, index) => (item.done ? [] : [{ apex, section: section.name, index, text: item.text }])))
  }), [apexes, plans])
}

/** The Apex a new message most likely is for, on the Mac it starts on and in its folder: one, two to choose from, or none. */
export function webRoute(text: string, deviceId: string | undefined, folder: string | undefined, apexes: readonly (ApexEntry & { deviceId: string })[]) {
  const candidates: RouteCandidate[] = apexes
    .filter((apex) => apex.conversation && (!deviceId || apex.deviceId === deviceId))
    .map((apex) => ({ thread: apex.thread, name: apex.name, ...(apex.purpose && { purpose: apex.purpose }), ...(apex.folder && { folder: apex.folder }) }))
  return routeFor(text, folder, candidates)
}
