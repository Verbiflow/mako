import { useEffect, useMemo } from "react"
import { apexDigest, parsePlan, routeFor, type ApexDigest, type ApexEntry, type ApexPlanReading, type RouteCandidate } from "@mako/host/contracts/apexes"
import type { NativeAgent } from "@mako/host/contracts/native-agents"
import type { ListedApex, ListedSession } from "@mako/protocol/thread-listing"
import { apexesStore, type ApexElsewhere } from "@/state/apexes"
import { createHook, createStore } from "@/state/store"
import { accountListStore, type AccountListState } from "./account-list"
import type { WebClient } from "./client"
import type { WebThread } from "./threads"
import { macCall } from "./start"

/**
 * A deliberate Apex as the account lists it (`ListedApex` on the row of its own conversation): what its owner said of
 * it last, pushed by the owner each time it changes, and kept by the account while the owner is off. `quietSince`: its
 * owner is quiet, so this is the last known state.
 */
export interface ListedWebApex extends ListedApex {
  deviceId: string
  thread: string
  conversation: string
  harness: string
  folder?: string
  createdAt: number
  quietSince?: string
}

/**
 * The person's deliberate Apexes as each Mac keeps them (`mako:apexes`), and each one's plan, read through the Mac
 * that holds its Thread as its own window reads them; and as the account lists them (`listed`), which every surface
 * here reads first: the owner says each change there, and the account keeps it while the owner is off. `plansAt`: the
 * listed Apex's `at` a plan here was read or saved at, so it stands only until the account says a newer one.
 */
interface WebApexesState {
  byDevice: Readonly<Record<string, readonly ApexEntry[]>>
  plans: Readonly<Record<string, string>>
  plansAt: Readonly<Record<string, number | undefined>>
  listed: Readonly<Record<string, ListedWebApex>>
}

export const webApexesStore = createStore<WebApexesState>({ byDevice: {}, plans: {}, plansAt: {}, listed: {} })
export const useWebApexes = createHook(webApexesStore)

/**
 * Every deliberate Apex the account's rows list, by Thread, on devices only: one whose owner is quiet carries since
 * when. A Thread listed by two rows (it moved, both still listed) is the newer `at`.
 */
export function listedWebApexes(rows: readonly ListedSession[], quiet: ReadonlyMap<string, string>) {
  const byThread: Record<string, ListedWebApex> = {}
  for (const row of rows) {
    if (!row.apex || row.runsOn.kind !== "device") continue
    const held = byThread[row.thread]
    if (held && held.at >= row.apex.at) continue
    const since = quiet.get(row.runsOn.deviceId)
    const folder = row.project?.folder ?? row.folder
    byThread[row.thread] = {
      ...row.apex,
      deviceId: row.runsOn.deviceId,
      thread: row.thread,
      conversation: row.conversation,
      harness: row.harness,
      createdAt: Date.parse(row.createdAt),
      ...(folder && { folder }),
      ...(since && { quietSince: since }),
    }
  }
  return byThread
}

/**
 * An Apex's plan as this page shows it: the one it read or saved from its owner while that's as new as what the account
 * lists (a line checked here, before its row says so; or the whole of a plan the row cut), else the account's.
 */
export function webPlanOf(state: Pick<WebApexesState, "plans" | "plansAt" | "listed">, thread: string): string | undefined {
  const listed = state.listed[thread]
  const read = state.plans[thread]
  if (!listed) return read
  if (read !== undefined && state.plansAt[thread] === listed.at) return read
  return listed.plan ?? (listed.planCut ? read : "")
}

/** An Apex's profile as this page shows it: its owner's own entry, with what the account lists of it since. */
export function webApexOf(state: Pick<WebApexesState, "byDevice" | "listed">, deviceId: string | undefined, thread: string): ApexEntry | undefined {
  const live = deviceId ? state.byDevice[deviceId]?.find((apex) => apex.thread === thread) : undefined
  const listed = state.listed[thread]
  if (!listed || (deviceId && listed.deviceId !== deviceId)) return live
  return entryOf(listed, live)
}

function entryOf(listed: ListedWebApex, live: ApexEntry | undefined): ApexEntry {
  const entry: ApexEntry = {
    ...live,
    thread: listed.thread,
    handle: live?.handle ?? "",
    name: listed.name,
    createdAt: live?.createdAt ?? listed.createdAt,
    from: live?.from ?? "thread",
    by: live?.by ?? "person",
    conversation: listed.conversation,
    harness: listed.harness,
  }
  delete entry.purpose
  delete entry.seenAt
  if (listed.purpose) entry.purpose = listed.purpose
  if (listed.seenAt !== undefined) entry.seenAt = listed.seenAt
  if (listed.folder) entry.folder = listed.folder
  return entry
}

/** Since when an Apex's owner is quiet, its state here the last it said; undefined while its owner answers. */
export function useWebLastKnown(thread: string | undefined): string | undefined {
  return useWebApexes((state) => (thread ? state.listed[thread]?.quietSince : undefined))
}

/** A plan read or saved from its owner just now: it stands until the account lists a newer one. */
export function heardWebPlan(thread: string, text: string): void {
  webApexesStore.set((state) => ({ ...state, plans: { ...state.plans, [thread]: text }, plansAt: { ...state.plansAt, [thread]: state.listed[thread]?.at } }))
}

/**
 * Follows the account's list for the Apexes it lists, into this page's stores: the phone's digest and Inbox read them
 * here, and the desk's Overview (`state/apexes`) reads them as a Mac's window reads its own, each marked as another
 * device's (`elsewhere`) and, while that device is quiet, as last known. A Mac that comes back is read again.
 */
function followListed(): void {
  let rows: AccountListState["rows"] | undefined
  let quiet: AccountListState["quiet"] | undefined
  const heard = () => {
    const list = accountListStore.get()
    if (list.rows === rows && list.quiet === quiet) return
    const back = quiet ? [...quiet.keys()].filter((mac) => !list.quiet.has(mac)) : []
    rows = list.rows
    quiet = list.quiet
    const listed = listedWebApexes(list.rows, list.quiet)
    webApexesStore.set((state) => ({ ...state, listed }))
    for (const mac of back) asked.delete(mac)
  }
  heard()
  accountListStore.subscribe(heard)
  webApexesStore.subscribe(() => toDesk(webApexesStore.get(), accountListStore.get().devices))
  toDesk(webApexesStore.get(), accountListStore.get().devices)
}

/** The listed Apexes as the desk's own store holds a Mac's: their entries, plans, and whose they are. */
function toDesk(state: WebApexesState, devices: AccountListState["devices"]): void {
  const byThread: Record<string, ApexEntry> = {}
  const plans: Record<string, string> = {}
  const elsewhere: Record<string, ApexElsewhere> = {}
  for (const listed of Object.values(state.listed)) {
    const live = state.byDevice[listed.deviceId]?.find((apex) => apex.thread === listed.thread)
    byThread[listed.thread] = entryOf(listed, live)
    const plan = webPlanOf(state, listed.thread)
    if (plan !== undefined) plans[listed.thread] = plan
    elsewhere[listed.thread] = { device: devices.get(listed.deviceId)?.name ?? "its Mac", ...(listed.quietSince && { quietSince: listed.quietSince }), ...(listed.planCut && { planCut: true }) }
  }
  const desk = apexesStore.get()
  if (sameKeys(desk.byThread, byThread) && sameKeys(desk.plans, plans) && sameKeys(desk.elsewhere, elsewhere)) return
  apexesStore.set((held) => ({ ...held, byThread, plans, elsewhere, loaded: true }))
}

function sameKeys<Value>(left: Readonly<Record<string, Value>>, right: Readonly<Record<string, Value>>): boolean {
  const keys = Object.keys(left)
  return keys.length === Object.keys(right).length && keys.every((key) => JSON.stringify(left[key]) === JSON.stringify(right[key]))
}

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
    heardWebPlan(thread, read.text)
  } catch {
    // A Mac that's off keeps its plan to itself: what this page read last stays, and the next screen asks again.
  }
}

/** A plan line the person did, from the phone: the Mac keeps it, and it leaves the digest on every device. */
export async function checkWebPlan(client: WebClient, deviceId: string, thread: string, section: string, item: number): Promise<boolean> {
  try {
    const saved = await macCall<ApexPlanReading | { refused: string; why: string }>(client.gateway, client.deviceId, deviceId, "mako:apex-plan-check", [thread, section, item, true])
    if ("refused" in saved) return false
    heardWebPlan(thread, saved.text)
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
    heardWebPlan(thread, saved.text)
    return true
  } catch {
    return false
  }
}

export function markWebSeen(client: WebClient, deviceId: string, thread: string): void {
  void macCall(client.gateway, client.deviceId, deviceId, "mako:apex-seen", [thread], { passive: true }).catch(() => undefined)
}

/**
 * Reads the Apexes of every Mac these Threads are on, once each: the list and the Inbox ask as they show, so an Apex's
 * digest is there with its conversation when it opens rather than arriving after, moving it down a line.
 */
export function useWebApexesOf(client: WebClient, threads: readonly WebThread[]): void {
  const macs = useMemo(() => [...new Set(threads.flatMap((thread) => thread.sessions.flatMap((session) => (session.owner.kind === "device" ? [session.owner.deviceId] : []))))].sort().join("\n"), [threads])
  useEffect(() => {
    for (const mac of macs.split("\n")) if (mac) void loadWebApexes(client, mac)
  }, [client, macs])
}

/**
 * One Thread's deliberate Apex profile: as the account lists it, its owner off or not, and its Mac's own entry once
 * read. Its Mac is asked once it's shown, unless it's quiet.
 */
export function useWebApex(client: WebClient, deviceId: string | undefined, thread: string): ApexEntry | undefined {
  const quiet = useWebApexes((state) => state.listed[thread]?.quietSince !== undefined)
  useEffect(() => {
    if (deviceId && !quiet) void loadWebApexes(client, deviceId)
  }, [client, deviceId, quiet])
  const byDevice = useWebApexes((state) => state.byDevice)
  const listed = useWebApexes((state) => state.listed[thread])
  return useMemo(() => webApexOf({ byDevice, listed: listed ? { [thread]: listed } : {} }, deviceId, thread), [byDevice, listed, deviceId, thread])
}

/** Every Apex on every Mac this page has read, and every one the account lists. */
export function useEveryWebApex(): readonly (ApexEntry & { deviceId: string })[] {
  const byDevice = useWebApexes((state) => state.byDevice)
  const listed = useWebApexes((state) => state.listed)
  return useMemo(() => {
    const read = Object.entries(byDevice).flatMap(([deviceId, apexes]) => apexes.filter((apex) => !listed[apex.thread]).map((apex) => ({ ...apex, deviceId })))
    const fromList = Object.values(listed).map((each) => ({ ...webApexOf({ byDevice, listed }, each.deviceId, each.thread)!, deviceId: each.deviceId }))
    return [...read, ...fromList]
  }, [byDevice, listed])
}

/** An Apex's plan as this page shows it (`webPlanOf`). */
export function useWebPlan(thread: string | undefined): string | undefined {
  return useWebApexes((state) => (thread ? webPlanOf(state, thread) : undefined))
}

/**
 * The digest the Mac's note gives the Apex, from the same roster and plan: the same function, so they can't differ.
 * Its plan is the account's while it lists one whole; one it doesn't (an older Mac, or a plan cut to fit a row) is
 * read from the Mac while it answers.
 */
export function useWebDigest(client: WebClient, deviceId: string | undefined, apex: ApexEntry | undefined, fins: readonly NativeAgent[], seenAt = apex?.seenAt): ApexDigest {
  const plan = useWebPlan(apex?.thread)
  const ask = useWebApexes((state) => {
    if (!apex) return false
    const listed = state.listed[apex.thread]
    if (!listed) return state.plans[apex.thread] === undefined
    return listed.planCut === true && !listed.quietSince && state.plansAt[apex.thread] !== listed.at
  })
  useEffect(() => {
    if (apex && deviceId && ask) void loadWebPlan(client, deviceId, apex.thread)
  }, [client, deviceId, apex, ask])
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
  const state = useWebApexes((each) => each)
  useEffect(() => {
    for (const apex of apexes) if (!state.listed[apex.thread] && state.plans[apex.thread] === undefined) void loadWebPlan(client, apex.deviceId, apex.thread)
  }, [client, apexes, state])
  return useMemo(() => apexes.flatMap((apex) => {
    // A quiet owner's to-dos can't be checked off or answered until it's back: its Apex's digest shows them, as last known.
    if (state.listed[apex.thread]?.quietSince) return []
    const plan = webPlanOf(state, apex.thread)
    if (!plan) return []
    return parsePlan(plan).sections.filter((section) => /^waiting on\b/i.test(section.name)).flatMap((section) =>
      section.items.flatMap((item, index) => (item.done ? [] : [{ apex, section: section.name, index, text: item.text }])))
  }), [apexes, state])
}

followListed()

/** The Apex a new message most likely is for, on the Mac it starts on and in its folder: one, two to choose from, or none. */
export function webRoute(text: string, deviceId: string | undefined, folder: string | undefined, apexes: readonly (ApexEntry & { deviceId: string })[]) {
  const candidates: RouteCandidate[] = apexes
    .filter((apex) => apex.conversation && (!deviceId || apex.deviceId === deviceId))
    .map((apex) => ({ thread: apex.thread, name: apex.name, ...(apex.purpose && { purpose: apex.purpose }), ...(apex.folder && { folder: apex.folder }) }))
  return routeFor(text, folder, candidates)
}
