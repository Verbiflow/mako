import type { HarnessBehind } from "@mako/host/contracts/cloud-harnesses"
import { HarnessIcon } from "@/components/ui/provider-icon"
import { Action } from "@/components/ui/kit"
import { behindWords } from "@/lib/harness-check"
import { harnessLabel } from "@/lib/harness-label"

/**
 * In the Local or Cloud chip's popover, under the move or the way back: this Mac's harnesses older than the cloud's
 * (`ThreadHarnessCheck.behind`), each with its versions and, where Mako can't update it, what to do; and the one
 * choice that updates what Mako can and goes on, beside going on without it. Said before anything moves, so a Thread
 * never learns it can't come back only once it's in the cloud.
 */
export function HarnessesBehind({ behind, way, handOff = false, disabled = false, onUpdate, onAnyway, onCheckAgain }: {
  behind: readonly HarnessBehind[]
  way: "move" | "back"
  handOff?: boolean
  disabled?: boolean
  onUpdate(): void
  onAnyway(): void
  onCheckAgain(): void
}) {
  const words = behindWords(behind, harnessLabel, way, handOff)
  // Updated outside Mako (another app's, a command): weighed again on focus, or now when the person says so.
  const elsewhere = behind.some((each) => each.offer.kind !== "update")
  return (
    <div data-harness-behind={way} className="mt-1 flex flex-col gap-2 border-t border-hairline px-2 pt-2.5 pb-1.5">
      <div className="flex flex-col gap-0.5">
        <p className="text-ui font-medium text-foreground">{words.title}</p>
        <p className="text-label leading-relaxed text-muted-foreground">{words.detail}</p>
      </div>
      <ul className="flex flex-col gap-1.5">
        {words.rows.map((row) => (
          <li key={row.harness} data-harness-behind-row={row.harness} className="flex items-start gap-2 text-label">
            <HarnessIcon harness={row.harness} className="mt-px size-3.5 shrink-0" />
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="text-foreground tabular-nums">{row.versions}</span>
              {row.todo ? <span className="leading-relaxed text-muted-foreground [overflow-wrap:anywhere]">{row.todo}</span> : null}
            </span>
          </li>
        ))}
      </ul>
      {/* The one choice first, the width of the popover; going on without it, and weighing again, under it. */}
      <div className="mt-0.5 flex flex-col gap-1">
        {words.update ? (
          <Action tone="solid" size="md" data-harness-update-then disabled={disabled} onClick={onUpdate} className="w-full">
            {words.update}
          </Action>
        ) : null}
        <div className="flex items-center justify-between gap-1.5">
          {elsewhere ? (
            <Action tone="ghost" data-harness-check-again disabled={disabled} onClick={onCheckAgain}>
              Check again
            </Action>
          ) : <span />}
          <Action tone={words.update ? "ghost" : "outline"} data-harness-anyway disabled={disabled} onClick={onAnyway}>
            {words.anyway}
          </Action>
        </div>
      </div>
    </div>
  )
}
