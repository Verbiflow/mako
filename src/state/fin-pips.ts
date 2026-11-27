import { finsWord } from "@mako/host/contracts/agents"
import { useApexes } from "@/state/apexes"
import { childGroup, childStateOf, rollupLabel, type Rollup } from "@mako/host/contracts/children"
import type { NativeAgent } from "@mako/host/contracts/native-agents"
import { threadAsking, threadRollup } from "@/state/fin-rollup"
import { threadChildren, useRailAcp, type AcpState } from "@/state/acp-state"
import { usePrefs } from "@/state/prefs"

/**
 * One letter per Fin, in `orderedChildren`' order: `n` needs the person, `w` working, `l` working while it asks its
 * Apex, `q` queued, `i` idle, `f` failed, `d` done. A string, so a row's selector compares it by value and repaints only when a
 * pip changes.
 */
export type Pips = string

const byChildren = new WeakMap<readonly NativeAgent[], Pips>()

function pipOf(agent: NativeAgent): string {
  const state = childStateOf(agent)
  const group = childGroup(state)
  if (group === "working") return state.kind === "blocked" ? "l" : "w"
  return group === "needs" ? "n" : group[0]!
}

/** As the roster lists them; from its counts alone while this window holds only the host's rollup. */
export function pipsOf(children: readonly NativeAgent[], counts: Rollup): Pips {
  if (!children.length) return "n".repeat(counts.needs) + "w".repeat(counts.working) + "q".repeat(counts.queued) + "i".repeat(counts.idle) + "f".repeat(counts.failed) + "d".repeat(counts.done)
  let held = byChildren.get(children)
  if (held === undefined) {
    held = children.map(pipOf).join("")
    byChildren.set(children, held)
  }
  return held
}

export function apexPips(state: AcpState, thread: string | undefined): Pips {
  return pipsOf(threadChildren(state, thread), threadRollup(state, thread))
}

/** Whether a Thread leads Fins: what turns its row into two lines. True or false until its first Fin starts or its last goes. */
export function useIsApex(thread: string | undefined): boolean {
  const leads = useRailAcp((state) => threadRollup(state, thread).total > 0)
  // A deliberate Apex is one before its first Fin, too.
  const made = useApexes((state) => (thread ? state.byThread[thread] !== undefined : false))
  return leads || made
}

function sameEntries(left: readonly NativeAgent[], right: readonly NativeAgent[]): boolean {
  return left.length === right.length && left.every((agent, index) => agent === right[index])
}

/** The Fins of an Apex that wait on the person, oldest first: a Fin moving among the others repaints nothing here. */
export function useNeedsYouFins(thread: string | undefined): readonly NativeAgent[] {
  return useRailAcp((state) => threadAsking(state, thread), sameEntries)
}

/** The pips counted as `rollup` counts their Fins: one asking its Apex is working. */
export function pipsCounts(pips: Pips): Rollup {
  const count = (letter: string) => pips.split(letter).length - 1
  return { total: pips.length, needs: count("n"), working: count("w") + count("l"), queued: count("q"), idle: count("i"), failed: count("f"), done: count("d") }
}

/** Beside the pips: how many Fins, and the done and idle ones the pips leave out. The desk's rail and the phone's list say it alike. */
export function settledWords(pips: Pips): string {
  const { done, idle, total } = pipsCounts(pips)
  if (done + idle === 0 || done + idle === total) return finsWord(total)
  return [finsWord(total), done ? `${done} done` : "", idle ? `${idle} idle` : ""].filter(Boolean).join(" · ")
}

/** An Apex's Fins as its row reads them: whether any works (the ring), their counts in words (the tip), and whether it's open. */
export interface ApexFins {
  working: boolean
  label: string | undefined
  open: boolean
}

export function useApexFins(thread: string | undefined, apex: boolean): ApexFins {
  const pips = useRailAcp((state) => (apex ? apexPips(state, thread) : ""))
  const open = usePrefs((prefs) => Boolean(apex && thread && prefs.openApexes.includes(thread)))
  return { working: /[wl]/.test(pips), label: pips ? rollupLabel(pipsCounts(pips)) : undefined, open }
}
