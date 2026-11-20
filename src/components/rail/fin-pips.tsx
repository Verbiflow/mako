import { observePhaseLockedAnimation } from "@/lib/visible-animation"
import type { Pips } from "@/state/fin-pips"

const PIP = new Map([["n", "needs"], ["w", "working"], ["l", "lead"], ["q", "queued"], ["i", "idle"], ["f", "failed"], ["d", "done"]])
const MAX_PIPS = 16

/**
 * An Apex's Shiver in one line: a 6 px pip per Fin that needs the person or is live (needs you, working, asking its
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
