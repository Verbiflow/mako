import { toast } from "sonner"
import { useEffect, useMemo, useState } from "react"
import {
  apexDigest,
  parsePlan,
  routeFor,
  type ApexChange,
  type ApexCreateInput,
  type ApexDigest,
  type ApexEntry,
  type ApexGathered,
  type ApexRulesReading,
  type PersonLayers,
  type RouteCandidate,
  type RuleLayer,
} from "@mako/host/contracts/apexes"
import type { NativeAgent } from "@mako/host/contracts/native-agents"
import { getMako, hasBridge } from "@/lib/bridge"
import { threadChildren } from "@/state/acp-state"
import { useRailAcp } from "@/state/acp-state"
import { confirmAction } from "@/state/confirm"
import { createHook, createStore } from "@/state/store"

/**
 * Deliberate Apexes as the host keeps them (`contracts/apexes.ts`): every one's profile, each one's plan as last read,
 * and which reader's rules the Overview previews. The host tells every window `apexes`, `apex-plan` and `apex-rules`
 * as they change; what's shown here is what it said last.
 */
export interface ApexesState {
  byThread: Readonly<Record<string, ApexEntry>>
  loaded: boolean
  plans: Readonly<Record<string, string>>
  /** Rules changed since a preview was read: it reads them again. */
  rulesAt: number
  /** Apexes this window shows as another device lists them (a browser's), by Thread: none in a Mac's own window. */
  elsewhere: Readonly<Record<string, ApexElsewhere>>
}

/**
 * An Apex another device keeps, as this window shows it from the account's list: its profile and rules are that
 * device's to change, and while it's quiet (`quietSince`) what's shown is the last it said, read-only.
 */
export interface ApexElsewhere {
  /** The device's name, as the account lists it. */
  device: string
  quietSince?: string
  /** The list carries only the start of its plan. */
  planCut?: true
}

export const apexesStore = createStore<ApexesState>({ byThread: {}, loaded: false, plans: {}, rulesAt: 0, elsewhere: {} })
export const useApexes = createHook(apexesStore)

function keyed(apexes: readonly ApexEntry[]): Record<string, ApexEntry> {
  return Object.fromEntries(apexes.map((apex) => [apex.thread, apex]))
}

export function applyApexes(apexes: readonly ApexEntry[]): void {
  apexesStore.set((state) => ({ ...state, byThread: keyed(apexes), loaded: true }))
}

export function applyApexPlan(thread: string, plan: string): void {
  apexesStore.set((state) => (state.plans[thread] === plan ? state : { ...state, plans: { ...state.plans, [thread]: plan } }))
}

export function applyApexRules(): void {
  apexesStore.set((state) => ({ ...state, rulesAt: state.rulesAt + 1 }))
}

export async function loadApexes(): Promise<void> {
  if (!hasBridge()) return
  applyApexes(await getMako().apexes())
}

/** A Thread's deliberate Apex profile, or undefined for a Thread that isn't one. */
export function useApex(thread: string | undefined): ApexEntry | undefined {
  return useApexes((state) => (thread ? state.byThread[thread] : undefined))
}

/** Whose an Apex is when another device keeps it, and whether that device is quiet; undefined for one of this Mac's. */
export function useApexElsewhere(thread: string | undefined): ApexElsewhere | undefined {
  return useApexes((state) => (thread ? state.elsewhere[thread] : undefined))
}

/** Every deliberate Apex, by name. */
export function useApexList(): readonly ApexEntry[] {
  const byThread = useApexes((state) => state.byThread)
  return useMemo(() => Object.values(byThread).sort((a, b) => a.name.localeCompare(b.name)), [byThread])
}

export async function readPlan(thread: string): Promise<string> {
  const read = await getMako().apexPlan(thread)
  applyApexPlan(thread, read.text)
  return read.text
}

/** A plan saved whole: shown at once, put back with why if the host refuses it. */
export async function savePlan(thread: string, text: string): Promise<boolean> {
  const before = apexesStore.get().plans[thread]
  applyApexPlan(thread, text)
  const saved = await getMako().saveApexPlan(thread, text).catch((error: Error) => ({ refused: "failed" as const, why: error.message }))
  if ("refused" in saved) {
    if (before !== undefined) applyApexPlan(thread, before)
    toast.error("The plan wasn't saved", { description: saved.why })
    return false
  }
  applyApexPlan(thread, saved.text)
  return true
}

export async function checkPlan(thread: string, section: string, item: number, done: boolean): Promise<void> {
  const saved = await getMako().checkApexPlan(thread, section, item, done).catch((error: Error) => ({ refused: "failed" as const, why: error.message }))
  if ("refused" in saved) toast.error("The plan wasn't saved", { description: saved.why })
  else applyApexPlan(thread, saved.text)
}

export async function createApex(input: ApexCreateInput): Promise<{ thread: string; conversation: string } | undefined> {
  const created = await getMako().createApex(input).catch((error: Error) => ({ refused: "failed" as const, why: error.message }))
  if ("refused" in created) {
    toast.error(`${input.name} wasn't made`, { description: created.why })
    return undefined
  }
  return created
}

export async function promoteToApex(conversation: string, change: ApexChange): Promise<ApexEntry | undefined> {
  const made = await getMako().promoteApex(conversation, change).catch((error: Error) => ({ refused: "failed" as const, why: error.message }))
  if ("refused" in made) {
    toast.error("It's still a Thread", { description: made.why })
    return undefined
  }
  toast.success(`${made.apex.name} is an Apex`)
  return made.apex
}

export async function updateApex(thread: string, change: ApexChange): Promise<boolean> {
  const done = await getMako().updateApex(thread, change).catch((error: Error) => ({ refused: "failed" as const, why: error.message }))
  if ("refused" in done) {
    toast.error("Not saved", { description: done.why })
    return false
  }
  return true
}

export async function demoteApex(thread: string, name: string): Promise<void> {
  const done = await getMako().demoteApex(thread).catch((error: Error) => ({ refused: "failed" as const, why: error.message }))
  if ("refused" in done) toast.error(`${name} is still an Apex`, { description: done.why })
  else toast.success(`${name} is a Thread again`, { description: done.released.length ? `${done.released.length === 1 ? "1 Thread" : `${done.released.length} Threads`} moved in went back to the list.` : undefined })
}

/** Move into Apex. Refusals come back for the caller to say; one that only lowers access can be confirmed. */
export async function gatherIntoApex(apex: string, threads: readonly string[], confirm = false): Promise<ApexGathered | undefined> {
  const gathered = await getMako().gatherIntoApex(apex, [...threads], confirm).catch((error: Error) => ({ refused: "failed" as const, why: error.message }))
  if ("refused" in gathered) {
    toast.error("Nothing moved", { description: gathered.why })
    return undefined
  }
  return gathered
}

export function markSeen(thread: string): void {
  if (hasBridge()) void getMako().apexSeen(thread).catch(() => undefined)
}

export async function readRules(thread: string, as: "apex" | "fin"): Promise<ApexRulesReading | undefined> {
  const read = await getMako().apexRules(thread, as).catch(() => undefined)
  return read && !("refused" in read) ? read : undefined
}

export async function saveRule(layer: RuleLayer, text: string, at: { thread?: string; folder?: string }): Promise<boolean> {
  const saved = await getMako().saveRuleLayer(layer, text, at).catch((error: Error) => ({ refused: "failed" as const, why: error.message }))
  if ("refused" in saved) {
    toast.error("Your rules weren't saved", { description: saved.why })
    return false
  }
  applyApexRules()
  return true
}

export async function readPersonLayers(folder?: string): Promise<PersonLayers | undefined> {
  return getMako().ruleLayers(folder).catch(() => undefined)
}

export async function forgetMemory(id: string): Promise<void> {
  await getMako().forgetMemory(id).catch(() => undefined)
  applyApexRules()
}

/** An Apex's digest from its roster and plan, as the host builds its note: the same function, so they can't differ. */
export function useApexDigest(apex: ApexEntry | undefined, seenAt = apex?.seenAt): ApexDigest {
  const fins = useRailAcp((state) => (apex ? threadChildren(state, apex.thread) : NONE))
  const plan = useApexes((state) => (apex ? state.plans[apex.thread] : undefined))
  return useMemo(() => apexDigest(fins, plan, seenAt), [fins, plan, seenAt])
}

/** How long a digest is open before what's new in it counts as read. */
export const SEEN_AFTER_MS = 4_000

/**
 * What a digest on screen counts as new: what finished since the person last read it, as it stood when it opened, so
 * nothing leaves "New" under their eyes; once it has been open `SEEN_AFTER_MS`, it's read, for the next time.
 */
export function useSeenSince(thread: string | undefined, seenAt: number | undefined, seen: (thread: string) => void): number | undefined {
  const [since, setSince] = useState<{ thread?: string; at?: number }>({ thread, at: seenAt })
  if (since.thread !== thread) setSince({ thread, at: seenAt })
  useEffect(() => {
    if (!thread) return
    const timer = setTimeout(() => seen(thread), SEEN_AFTER_MS)
    return () => clearTimeout(timer)
  }, [thread, seen])
  return since.thread === thread ? since.at : seenAt
}

const NONE: readonly NativeAgent[] = []

/** Where a message with no clear owner most likely goes: one Apex, two to choose from, or none. */
export function routeSuggestion(text: string, folder: string | undefined, apexes: readonly ApexEntry[]) {
  const candidates: RouteCandidate[] = apexes.map((apex) => ({ thread: apex.thread, name: apex.name, ...(apex.purpose && { purpose: apex.purpose }), ...(apex.folder && { folder: apex.folder }) }))
  return routeFor(text, folder, candidates)
}

/** The New Apex form, or Make this an Apex for one conversation, while it's open. */
export type ApexDialog = { mode: "new"; folder?: string } | { mode: "promote"; conversation: string; name: string } | null
export const apexDialogStore = createStore<{ open: ApexDialog }>({ open: null })
export const useApexDialog = createHook(apexDialogStore)

export function openNewApex(folder?: string): void {
  apexDialogStore.set({ open: { mode: "new", ...(folder && { folder }) } })
}

export function openPromoteApex(conversation: string, name: string): void {
  apexDialogStore.set({ open: { mode: "promote", conversation, name } })
}

export function closeApexDialog(): void {
  apexDialogStore.set({ open: null })
}

/**
 * Move into Apex, from a menu or a drag: what moved is said in one line, what stayed out in Mako's words, and a
 * Thread that would only lose access asks once before it goes in at the Apex's.
 */
export async function moveIntoApex(apex: ApexEntry, threads: readonly string[], confirm: (why: string) => Promise<boolean>): Promise<void> {
  const first = await gatherIntoApex(apex.thread, threads)
  if (!first) return
  let moved = first.moved
  const confirmable = first.stayed.filter((each) => each.confirmable)
  const refused = first.stayed.filter((each) => !each.confirmable)
  if (confirmable.length && (await confirm(confirmable.map((each) => each.why).join(" ")))) {
    const again = await gatherIntoApex(apex.thread, confirmable.map((each) => each.thread), true)
    if (again) {
      moved = [...moved, ...again.moved]
      refused.push(...again.stayed)
    }
  }
  if (moved.length) toast.success(moved.length === 1 ? `Moved into ${apex.name}` : `${moved.length} Threads moved into ${apex.name}`, { description: moved.length === 1 ? moved[0]!.title : undefined })
  for (const each of refused) toast(`Stayed out of ${apex.name}`, { description: each.why })
}

/** Lowering a Thread's access to move it in is the person's to agree to, once, in the words the host gave. */
export function confirmLowered(why: string): Promise<boolean> {
  return confirmAction({ title: "Move it in at less access?", body: why, confirm: "Move it in" })
}

/**
 * A message the person addressed to an Apex from `@` in another composer, a new Thread's included: it goes to that
 * Apex's conversation as theirs, and the Apex opens. Kept by the composer's draft until sent or cleared.
 */
export interface ApexAddressee {
  thread: string
  name: string
  conversation: string
}
export const apexAddresseeStore = createStore<{ to: Readonly<Record<string, ApexAddressee>> }>({ to: {} })
export const useApexAddressee = createHook(apexAddresseeStore)

export function addressApex(draft: string, apex: ApexAddressee): void {
  apexAddresseeStore.set((state) => ({ to: { ...state.to, [draft]: apex } }))
}

export function unaddressApex(draft: string): void {
  if (!apexAddresseeStore.get().to[draft]) return
  apexAddresseeStore.set((state) => ({ to: Object.fromEntries(Object.entries(state.to).filter(([key]) => key !== draft)) }))
}

const APEX_PICK = "@mako-apex:"
export function apexPick(thread: string): string {
  return `${APEX_PICK}${thread}`
}
export function pickedApex(value: string): string | undefined {
  return value.startsWith(APEX_PICK) ? value.slice(APEX_PICK.length) : undefined
}

/** A plan line under "Waiting on you" (or "Waiting on <name>"): the person's to do, in the Inbox and the digest. */
export interface PlanAsk {
  apex: ApexEntry
  section: string
  index: number
  text: string
}

/** A plan line's key in a list (the Inbox's row). */
export function planKey(ask: PlanAsk): string {
  return `plan:${ask.apex.thread}:${ask.section}:${ask.index}`
}

const WAITING = /^waiting on\b/i

/** The lines of these Apexes' plans that wait on the person and aren't done, in the Apexes' order. */
export function planAsksOf(apexes: readonly ApexEntry[], plans: ApexesState["plans"]): PlanAsk[] {
  return apexes.flatMap((apex) => {
    const plan = plans[apex.thread]
    if (!plan) return []
    return parsePlan(plan).sections.filter((section) => WAITING.test(section.name)).flatMap((section) =>
      section.items.flatMap((item, index) => (item.done ? [] : [{ apex, section: section.name, index, text: item.text }])))
  })
}

/** Every Apex's plan lines that wait on the person, its plan read once it's asked for. */
export function useApexPlanAsks(): PlanAsk[] {
  const apexes = useApexList()
  const plans = useApexes((state) => state.plans)
  useEffect(() => {
    for (const apex of apexes) if (plans[apex.thread] === undefined) void readPlan(apex.thread).catch(() => undefined)
  }, [apexes, plans])
  return useMemo(() => planAsksOf(apexes, plans), [apexes, plans])
}


/** How many of one Apex's plan lines wait on the person. */
export function usePlanNeedsCount(apex: ApexEntry | undefined): number {
  const plan = useApexes((state) => (apex ? state.plans[apex.thread] : undefined))
  return useMemo(() => (plan ? parsePlan(plan).sections.filter((section) => WAITING.test(section.name)).reduce((sum, section) => sum + section.items.filter((item) => !item.done).length, 0) : 0), [plan])
}

/** The person answers a question the Apex's plan asks them: their words go to the Apex, and the line leaves Needs you. */
export async function answerPlan(thread: string, section: string, index: number, answer: string): Promise<boolean> {
  const saved = await getMako().answerApexPlan(thread, section, index, answer).catch((error: Error) => ({ refused: "failed" as const, why: error.message }))
  if ("refused" in saved) {
    toast.error("Your answer didn't reach it", { description: saved.why })
    return false
  }
  applyApexPlan(thread, saved.text)
  return true
}
