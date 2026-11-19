import type { ThreadWorktree, WorktreeBranchPull, WorktreeSummary } from "@mako/host/contracts/thread-worktrees"
import { pullKey, pullRef } from "@mako/host/contracts/agents"
import { childGroup, childStateOf, rosterChildren } from "@mako/host/contracts/children"
import type { NativeAgent } from "@mako/host/contracts/native-agents"
import { threadChildren, useRailAcp, type AcpState } from "@/state/acp-state"
import { createHook, createStore } from "@/state/store"

/*
 * An Apex's Overview, read from the roster this window already holds: one selector a section, each made once per
 * roster (`threadChildren` keeps the array while the roster stands) and heard through the rail's store, so a token
 * streaming in any conversation runs none of them. Nothing here asks the host anything.
 */

/**
 * The Overview's sections of Fins, in the order they're drawn. Every Fin is in exactly one, by `childGroup`: `waiting`
 * holds the idle and the queued, which both wait for something before their next turn.
 */
export const OVERVIEW_SECTIONS = ["needs", "working", "waiting", "failed", "done"] as const
export type OverviewSection = (typeof OVERVIEW_SECTIONS)[number]

export const OVERVIEW_HEADINGS = {
  needs: "Needs you",
  working: "Working",
  waiting: "Waiting",
  failed: "Failed",
  done: "Done",
} satisfies Record<OverviewSection, string>

/** Rows a section draws until it's opened further. */
export const OVERVIEW_SHOWN = 10
/** Past this many rows an opened section draws only the ones in view. */
export const OVERVIEW_WINDOWED = 100

/** A roster's Fins by section. */
interface Sections {
  needs: readonly NativeAgent[]
  working: readonly NativeAgent[]
  waiting: readonly NativeAgent[]
  failed: readonly NativeAgent[]
  done: readonly NativeAgent[]
}

const NONE: readonly NativeAgent[] = []
const sectionsOf = new WeakMap<readonly NativeAgent[], Sections>()

/** When a Fin came to stand as it does, for the newest of the finished first. */
function stoodSince(agent: NativeAgent): number {
  return agent.since ?? agent.settledAt ?? agent.observedAt
}

/** Waiting on what its report named first, then the queued, then the idle: the roster's order within each. */
function waitingRank(agent: NativeAgent): number {
  const state = childStateOf(agent)
  if (state.kind === "idle") return state.waitingOn?.length ? 0 : 2
  return 1
}

function divided(children: readonly NativeAgent[]): Sections {
  const of = (section: OverviewSection) => children.filter((agent) => sectionOf(agent) === section)
  // Stable sorts: Fins that rank alike keep the roster's order.
  const waiting = of("waiting").sort((left, right) => waitingRank(left) - waitingRank(right))
  const done = of("done").sort((left, right) => stoodSince(right) - stoodSince(left))
  return { needs: kept(of("needs")), working: kept(of("working")), waiting: kept(waiting), failed: kept(of("failed")), done: kept(done) }
}

/** Where a Fin is listed: the queued and the idle both wait. */
function sectionOf(agent: NativeAgent): OverviewSection {
  const group = childGroup(childStateOf(agent))
  return group === "queued" || group === "idle" ? "waiting" : group
}

function kept(agents: NativeAgent[]): readonly NativeAgent[] {
  return agents.length ? agents : NONE
}

/** One section's Fins of a roster, divided once per roster however many sections and rows ask. */
export function overviewFins(children: readonly NativeAgent[], section: OverviewSection): readonly NativeAgent[] {
  let held = sectionsOf.get(children)
  if (!held) {
    held = divided(children)
    sectionsOf.set(children, held)
  }
  return held[section]
}

export function sameFins(left: readonly NativeAgent[], right: readonly NativeAgent[]): boolean {
  return left === right || (left.length === right.length && left.every((agent, index) => agent === right[index]))
}

/**
 * The Fins the Overview shows: its Thread's as every surface reads them (`threadChildren`), or for a conversation
 * with no Thread, its own roster's.
 */
export function overviewChildren(state: AcpState, thread: string | undefined, conversation?: string): readonly NativeAgent[] {
  if (thread) return threadChildren(state, thread)
  const live = conversation ? state.conversations[conversation] : undefined
  return live?.kind === "live" ? rosterChildren(live.nativeAgents) : NONE
}

/** A section of those Fins as the state holds them. */
export function overviewSection(state: AcpState, thread: string | undefined, section: OverviewSection, conversation?: string): readonly NativeAgent[] {
  return overviewFins(overviewChildren(state, thread, conversation), section)
}

/**
 * A section's Fins, the same array until one of its own entries changes: a Fin's step moving draws its section's list
 * and that Fin's row again, and no other section.
 */
export function useOverviewSection(thread: string | undefined, section: OverviewSection, conversation?: string): readonly NativeAgent[] {
  return useRailAcp((state) => overviewSection(state, thread, section, conversation), sameFins)
}

/** A Thread's Fins from the rail's store: what the Overview and a Fin's own fold read, woken by a roster's change alone. */
export function useOverviewChildren(thread: string | undefined, conversation?: string): readonly NativeAgent[] {
  return useRailAcp((state) => overviewChildren(state, thread, conversation))
}

/** The Fins under an Apex at any depth, itself not among them: a Fin that leads Fins of its own brings them. */
export function treeFins(state: AcpState, apex: string | undefined): readonly NativeAgent[] {
  const direct = threadChildren(state, apex)
  if (!direct.length) return direct
  let all: NativeAgent[] | undefined
  const seen = new Set<string>(apex ? [apex] : [])
  const walk = (children: readonly NativeAgent[], depth: number) => {
    for (const agent of children) {
      const thread = agent.child?.thread
      if (!thread || seen.has(thread)) continue
      seen.add(thread)
      if (depth > 0) (all ??= [...direct]).push(agent)
      const under = threadChildren(state, thread)
      if (under.length && depth < TREE_DEPTH) walk(under, depth + 1)
    }
  }
  walk(direct, 0)
  return all ?? direct
}
/** How far down a tree is read: far past any tree made on purpose, and an end for one that names itself. */
const TREE_DEPTH = 8

/** An open pull request of an Apex's tree, as its row says it. */
export interface OverviewPull {
  /** `owner/name#12`, or `#12` where no repository is known: one row a pull request. */
  key: string
  number: number
  repository?: string
  /** Its title as GitHub last said it; a pull request only a report named has none. */
  title?: string
  url?: string
  draft: boolean
  checks: WorktreeBranchPull["checks"]
  /** Whose it is: the Fin's title, or the Apex's own. */
  owner: string
  /** What a Fin waits on of it (`checks`, `review`, `merge`), when one does. */
  until?: string
}

/** What's read of the tree to find its pull requests: each Thread, and what it's called. */
export interface PullOwner {
  thread: string
  title: string
  agent?: NativeAgent
}

/**
 * The open pull requests of an Apex's tree, from what this window holds and nothing read for it: each Thread's
 * worktree branch's as the worktree summaries last said it (number, title, checks), then any a Fin's state says it
 * waits on that those don't name. In the tree's order, each pull request once.
 */
export function overviewPulls(owners: readonly PullOwner[], worktrees: readonly ThreadWorktree[], summaries: Readonly<Record<string, WorktreeSummary>>): readonly OverviewPull[] {
  const found = new Map<string, OverviewPull>()
  const byThread = new Map<string, ThreadWorktree[]>()
  for (const worktree of worktrees) byThread.set(worktree.thread, [...(byThread.get(worktree.thread) ?? []), worktree])
  for (const owner of owners) {
    for (const worktree of byThread.get(owner.thread) ?? []) {
      const pull = summaries[worktree.path]?.pull
      if (!pull || (pull.state !== "open" && pull.state !== "draft")) continue
      const repository = pullRef(pull.url)?.repository
      const key = pullKey({ number: pull.number, ...(repository && { repository }) })
      if (!found.has(key)) found.set(key, { key, number: pull.number, ...(repository && { repository }), title: pull.title, url: pull.url, draft: pull.state === "draft", checks: pull.checks, owner: owner.title })
    }
  }
  for (const owner of owners) {
    const state = owner.agent && childStateOf(owner.agent)
    const waits = state && "waitingOn" in state ? state.waitingOn ?? [] : []
    for (const wait of waits) {
      if (wait.kind !== "pull-request") continue
      const ref = pullRef(wait.ref)
      const number = wait.number ?? ref?.number
      if (number === undefined) continue
      const repository = (wait.repository ?? ref?.repository)?.toLowerCase()
      // A bare `#12` is the one a branch's pull request already names by that number, when exactly one does.
      const named = repository ? found.get(pullKey({ repository, number })) : onlyNumbered(found, number)
      if (named) {
        if (!named.until && wait.until) found.set(named.key, { ...named, until: wait.until })
        continue
      }
      const key = pullKey({ number, ...(repository && { repository }) })
      found.set(key, { key, number, ...(repository && { repository }), ...(ref?.url && { url: ref.url }), draft: false, checks: null, owner: owner.title, ...(wait.until && { until: wait.until }) })
    }
  }
  return [...found.values()]
}

function onlyNumbered(found: ReadonlyMap<string, OverviewPull>, number: number): OverviewPull | undefined {
  const same = [...found.values()].filter((pull) => pull.number === number)
  return same.length === 1 ? same[0] : undefined
}

/** A pull request's checks in the words a worktree's tip says them. */
export function checksWords(checks: OverviewPull["checks"]): string {
  return checks === "passed" ? "Checks passed" : checks === "failed" ? "Checks failed" : checks === "running" ? "Checks running" : ""
}

/** Which of a Thread's sections the person folded, and which they opened past the first rows; kept while the window is. */
interface OverviewFolds {
  folded: FoldKeys
  opened: FoldKeys
}

/** The sections marked, by `foldKey`. */
interface FoldKeys {
  readonly [key: string]: true
}

export const overviewFoldsStore = createStore<OverviewFolds>({ folded: {}, opened: {} })
export const useOverviewFolds = createHook(overviewFoldsStore)

export function foldKey(thread: string | undefined, section: string): string {
  return `${thread ?? ""}:${section}`
}

function toggled(held: FoldKeys, key: string): FoldKeys {
  if (!held[key]) return { ...held, [key]: true }
  return Object.fromEntries(Object.entries(held).filter(([each]) => each !== key))
}

export function toggleOverviewFold(key: string): void {
  overviewFoldsStore.set((state) => ({ folded: toggled(state.folded, key) }))
}

export function toggleOverviewOpened(key: string): void {
  overviewFoldsStore.set((state) => ({ opened: toggled(state.opened, key) }))
}
