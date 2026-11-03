import { childGroup, childStateOf, rollupLabel, type Rollup } from "@mako/host/contracts/children"
import type { NativeAgent } from "@mako/host/contracts/native-agents"
import { finsWord } from "@mako/host/contracts/agents"
import { memo } from "react"
import { observePhaseLockedAnimation } from "@/lib/visible-animation"
import { threadAsking, threadChildren, threadRollup } from "@/state/apex-fins"
import { useAcp, type AcpState } from "@/state/acp"

/**
 * One letter per Fin, in `orderedChildren`' order: `n` needs the person, `w` working, `l` working while it asks its
 * Apex, `q` queued, `f` failed, `d` done. A string, so a row's selector compares it by value and repaints only when a
 * pip changes.
 */
export type Pips = string

const PIP: Record<string, string> = { n: "needs", w: "working", l: "lead", q: "queued", f: "failed", d: "done" }
const MAX_PIPS = 16
const byChildren = new WeakMap<readonly NativeAgent[], Pips>()

function pipOf(agent: NativeAgent): string {
  const state = childStateOf(agent)
  const group = childGroup(state)
  if (group === "working") return state.kind === "blocked" ? "l" : "w"
  return group === "needs" ? "n" : group[0]!
}

/** As the roster lists them; from its counts alone while this window holds only the host's rollup. */
export function pipsOf(children: readonly NativeAgent[], counts: Rollup): Pips {
  if (!children.length) return "n".repeat(counts.needs) + "w".repeat(counts.working) + "q".repeat(counts.queued) + "f".repeat(counts.failed) + "d".repeat(counts.done)
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
  return useAcp((state) => threadRollup(state, thread).total > 0)
}

function sameEntries(left: readonly NativeAgent[], right: readonly NativeAgent[]): boolean {
  return left.length === right.length && left.every((agent, index) => agent === right[index])
}

/** The Fins of an Apex that wait on the person, oldest first: a Fin moving among the others repaints nothing here. */
export function useNeedsYouFins(thread: string | undefined): readonly NativeAgent[] {
  return useAcp((state) => threadAsking(state, thread), sameEntries)
}

/** The pips counted as `rollup` counts their Fins: one asking its Apex is working. */
export function pipsCounts(pips: Pips): Rollup {
  const count = (letter: string) => pips.split(letter).length - 1
  return { total: pips.length, needs: count("n"), working: count("w") + count("l"), queued: count("q"), failed: count("f"), done: count("d") }
}

/**
 * An Apex's crew in one line: a 6 px pip per Fin in the order every surface lists them, past sixteen "+N". The
 * working stretch is one box under one veil in the row's own colour, which sweeps across it on the shared clock: a
 * single compositor animation per row however many Fins work, and none at all for a row scrolled away.
 */
export function FinPips({ pips }: { pips: Pips }) {
  const shown = pips.slice(0, MAX_PIPS)
  const more = pips.length - shown.length
  const start = shown.search(/[wl]/)
  const end = start < 0 ? -1 : start + /^[wl]+/.exec(shown.slice(start))![0].length
  const dots = (from: number, to: number) => [...shown.slice(from, to)].map((pip, index) => <span key={from + index} data-pip={PIP[pip]} className="fin-pip" />)
  return (
    <span aria-hidden className="fin-pips">
      {start < 0 ? (
        dots(0, shown.length)
      ) : (
        <>
          {dots(0, start)}
          <span className="fin-pips-wave">
            {dots(start, end)}
            <span ref={observePhaseLockedAnimation} className="fin-pips-veil" />
          </span>
          {dots(end, shown.length)}
        </>
      )}
      {more > 0 ? <span className="tabular pl-0.5 text-label text-faint">+{more}</span> : null}
    </span>
  )
}

/** The second line of an Apex's rail row: its pips and how many Fins. Repaints when a pip changes, never its row. */
export const ApexCrewLine = memo(function ApexCrewLine({ thread }: { thread: string | undefined }) {
  const pips = useAcp((state) => apexPips(state, thread))
  if (!pips) return null
  const label = rollupLabel(pipsCounts(pips))
  return (
    <span role="img" aria-label={label} data-tip={label} data-fin-pips={pips} className="flex h-3.5 w-full min-w-0 items-center gap-2 pl-7">
      <FinPips pips={pips} />
      <span className="tabular min-w-0 truncate text-label text-faint">{finsWord(pips.length)}</span>
    </span>
  )
})
