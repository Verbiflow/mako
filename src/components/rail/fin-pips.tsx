import { rollupLabel } from "@mako/host/contracts/children"
import { finsWord } from "@mako/host/contracts/agents"
import { memo } from "react"
import { observePhaseLockedAnimation } from "@/lib/visible-animation"
import { apexPips, pipsCounts, type Pips } from "@/state/fin-pips"
import { useAcp } from "@/state/acp-state"

const PIP = new Map([["n", "needs"], ["w", "working"], ["l", "lead"], ["q", "queued"], ["i", "idle"], ["f", "failed"], ["d", "done"]])
const MAX_PIPS = 16

/**
 * An Apex's crew in one line: a 6 px pip per Fin that needs the person or is live (needs you, working, asking its
 * Apex, queued, failed), in the order every surface lists them, past sixteen "+N"; done and idle ones are only in the
 * count beside them. The
 * working stretch is one box under one veil in the row's own colour, which sweeps across it on the shared clock: a
 * single compositor animation per row however many Fins work, and none at all for a row scrolled away.
 */
export function FinPips({ pips }: { pips: Pips }) {
  const live = pips.replace(/[id]/g, "")
  const shown = live.slice(0, MAX_PIPS)
  const more = live.length - shown.length
  const start = shown.search(/[wl]/)
  const end = start < 0 ? -1 : start + /^[wl]+/.exec(shown.slice(start))![0].length
  const dots = (from: number, to: number) => Array.from(shown.slice(from, to), (pip, index) => <span key={from + index} data-pip={PIP.get(pip)} className="fin-pip" />)
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
    <span role="img" aria-label={label} data-tip={label} data-fin-pips={pips} data-fin-counts={label} className="flex h-3.5 w-full min-w-0 items-center gap-2 pl-7">
      <FinPips pips={pips} />
      <span className="tabular min-w-0 truncate text-label text-faint">{settledWords(pips)}</span>
    </span>
  )
})

/** Beside the pips: how many Fins, and the done and idle ones the pips leave out. */
function settledWords(pips: Pips): string {
  const { done, idle, total } = pipsCounts(pips)
  if (done + idle === 0 || done + idle === total) return finsWord(total)
  return [finsWord(total), done ? `${done} done` : "", idle ? `${idle} idle` : ""].filter(Boolean).join(" · ")
}
