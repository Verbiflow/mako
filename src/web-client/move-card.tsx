import { useState } from "react"
import { ArrowDownIcon, ArrowUpIcon, CloudIcon, LaptopIcon, MoonIcon, RotateCwIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { useAccountList } from "./account-list"
import { lastSeen } from "./diagnosis"
import { forward, percentWords, sentWords, stepFraction, stepWords, type MoveWay } from "./move-progress"
import { dismissMove, type WebMove } from "./moves"
import type { MoveMac } from "./move-actions"
import { Sheet } from "./sheet"
import type { WebThread } from "./threads"
import { useNow } from "./trouble-state"

/** What each step means for the Thread, under the bar: the desk's words (`thread-move-notice.tsx`), naming the Mac. */
function stepDetail(move: Pick<WebMove, "way" | "step" | "handOff" | "mac">): string {
  const mac = move.mac.name
  if (move.way === "cloud")
    switch (move.step) {
      case "asking":
        return `Mako on ${mac} starts it; this phone follows each step.`
      case "own-branch":
        return "Only its own changes leave the project folder; the rest stay. It moves to the cloud from its new worktree."
      case "packing":
        return move.handOff ? `Its worktree and sessions go ahead while its agent keeps working on ${mac}.` : `Its worktree and sessions go ahead while it still runs on ${mac}.`
      case "pausing":
        return "Its turn stops where it is. What it did so far is saved and goes with it."
      case "handing-over":
      case "moving":
        return `${mac} let go of it; nothing runs it until a cloud machine takes it.`
      case "resuming":
        return move.handOff ? "A cloud machine took it. Its turn goes on there from where it paused, at the same folder." : "A cloud machine took it. Its sessions pick up where they left off, at the same folder."
      default:
        return ""
    }
  switch (move.step) {
    case "asking":
      return `Mako on ${mac} starts it; this phone follows each step.`
    case "packing":
      return "Its cloud machine takes no new work and sends back its worktree and sessions. Until they're sent, it's still the cloud's."
    case "bringing":
    case "moving":
      return `The cloud let go of it. Its worktree and sessions are arriving on ${mac}; nothing runs it until they have.`
    default:
      return ""
  }
}

/** The bar's place now: the step's own span, by its bytes or its time so far, and never behind where it stood. */
function useForward(move: Pick<WebMove, "way" | "step" | "stepAt" | "sent" | "move">, ended: boolean, done: boolean): number {
  const now = useNow(ended ? 3_600_000 : 250)
  const [shown, setShown] = useState<{ move: string | undefined; fraction: number }>({ move: move.move, fraction: 0 })
  const base = shown.move === move.move ? shown.fraction : 0
  const fraction = done ? 1 : ended ? base : forward(base, stepFraction(move.way, move.step, now - move.stepAt, move.sent))
  if (shown.move !== move.move || shown.fraction !== fraction) setShown({ move: move.move, fraction })
  return fraction
}

/**
 * A move in a Thread's place while it goes: where to, a thin bar that only moves forward with how far it is in words,
 * the step it's on and what that means; at its end, the outcome: moved, or the owner's reason with Retry. Back stays
 * where it is: the list is a tap away the whole time.
 */
export function MoveCard({ thread, move, onRetry }: { thread: WebThread; move: Pick<WebMove, "way" | "step" | "stepAt" | "sent" | "move" | "handOff" | "mac" | "end" | "ours">; onRetry: (() => void) | undefined }) {
  const end = move.end
  const done = end?.kind === "done"
  const fraction = useForward(move, end !== undefined, done)
  const up = move.way === "cloud"
  const Arrow = up ? ArrowUpIcon : ArrowDownIcon
  const title = end?.kind === "failed"
    ? up ? "Couldn't move to the cloud" : `It stayed in the cloud`
    : end?.kind === "unsettled" ? "Waiting for the cloud's answer"
    : done ? (up ? "Moved to the cloud" : `Back on ${move.mac.name}`)
    : up ? "Moving to the cloud" : `Bringing it back to ${move.mac.name}`
  const words = stepWords(move.way, move.step, move.mac.name, move.handOff)
  return (
    <section className="web-move" data-move={move.way} data-move-step={end ? end.kind : move.step} aria-label={title}>
      <div className="web-move-card">
        <div className="flex items-center gap-3">
          <span className={cn("web-move-mark", end?.kind === "failed" && "text-negative")} aria-hidden>
            {end?.kind === "failed" ? up ? <LaptopIcon className="size-5" /> : <CloudIcon className="size-5" /> : <Arrow className="size-5" />}
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-title font-semibold">{title}</h2>
            <p className="truncate text-label text-faint">{thread.title}</p>
          </div>
        </div>
        {end?.kind === "failed" || end?.kind === "unsettled" ? (
          <>
            <p className={cn("mt-4 text-ui", end.kind === "failed" ? "text-foreground" : "text-caution")}>{end.reason}</p>
            <div className="mt-5 flex flex-wrap items-center gap-2">
              {onRetry && end.kind === "failed" ? (
                <button type="button" className="web-button" onClick={onRetry}>
                  <RotateCwIcon className="size-4" />
                  Retry
                </button>
              ) : null}
              <button type="button" className="web-quiet-button" onClick={() => dismissMove(thread.id)}>
                Show the Thread
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="web-move-track" role="progressbar" aria-label={title} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(fraction * 100)}>
              <span className="web-move-fill" style={{ transform: `scaleX(${fraction})` }} />
            </div>
            <div className="mt-2.5 flex items-baseline gap-3 text-label">
              <span className="min-w-0 flex-1 truncate font-medium text-foreground">
                {done ? (up ? "It goes on in a cloud machine, at the same folder." : `It goes on on ${move.mac.name}.`) : words}
                {!done && move.step === "packing" && move.sent ? <span className="tabular font-normal text-faint"> · {sentWords(move.sent)}</span> : null}
              </span>
              <span className="tabular shrink-0 text-faint">{percentWords(fraction, done)}</span>
            </div>
            {!done ? <p className="mt-3 text-label text-muted-foreground">{stepDetail(move)}</p> : null}
          </>
        )}
      </div>
    </section>
  )
}

/**
 * Before a move: what happens to the Thread and to its turn, said plainly, and the one button that does it. Bringing
 * it back asks which Mac when the account has several; one that's off is listed, and can't be chosen.
 */
export function MoveSheet({ open, way, working, from, onDismiss, onMove }: { open: boolean; way: MoveWay; working: boolean; from: MoveMac | undefined; onDismiss: () => void; onMove: (mac: MoveMac) => void }) {
  const devices = useAccountList((state) => state.devices)
  const quiet = useAccountList((state) => state.quiet)
  const macs = [...devices.values()].filter((device) => device.kind === "desktop").sort((left, right) => Number(quiet.has(left.id)) - Number(quiet.has(right.id)))
  const [chosen, setChosen] = useState<string | undefined>(undefined)
  const up = way === "cloud"
  const picked = macs.find((mac) => mac.id === chosen) ?? macs.find((mac) => !quiet.has(mac.id))
  const target: MoveMac | undefined = up ? from : picked && { deviceId: picked.id, name: picked.name }
  const name = target?.name ?? "your Mac"
  const title = up ? "Move to the cloud?" : `Bring it back to ${name}?`
  const body = up
    ? working
      ? `Its turn is working now. It pauses on ${name}, goes up with its worktree and sessions, and carries on in a cloud machine where it left off.`
      : `It goes on in a cloud machine, at the same folder, with its worktree and sessions. Its worktree on ${name} follows each turn there.`
    : working
      ? `Its turn is working in the cloud. It comes back between turns: if that turn is still going, the cloud says so and nothing moves.`
      : `Its cloud machine stops taking work and packs up. It comes back into its worktree on ${name}, with what it did in the cloud, and the machine is gone.`
  const off = target ? quiet.get(target.deviceId) : undefined
  const now = useNow()
  return (
    <Sheet open={open} onDismiss={onDismiss} label={title}>
      <div className="web-move-ask" data-move-ask={way}>
        <p className="web-sheet-title px-0">{title}</p>
        <p className="text-ui text-muted-foreground">{body}</p>
        {!up && macs.length > 1 ? (
          <div role="radiogroup" aria-label="Bring it back to" className="mt-4 flex flex-col gap-1">
            {macs.map((mac) => {
              const away = quiet.get(mac.id)
              return (
                <button key={mac.id} type="button" role="radio" aria-checked={target?.deviceId === mac.id} disabled={away !== undefined} onClick={() => setChosen(mac.id)} className={cn("web-move-mac pressable", target?.deviceId === mac.id && "web-move-mac-on")}>
                  {away ? <MoonIcon className="size-4 text-faint" /> : <LaptopIcon className="size-4 text-muted-foreground" />}
                  <span className="min-w-0 flex-1 truncate text-left">{mac.name}</span>
                  {away ? <span className="text-label text-faint">Off · seen {lastSeen(away, now)}</span> : null}
                </button>
              )
            })}
          </div>
        ) : null}
        {off ? <p className="mt-3 text-label text-caution">{name} is off (seen {lastSeen(off, now)}). It has to be on to {up ? "move it" : "take it back"}.</p> : null}
        <div className="mt-6 flex flex-col gap-2">
          <button type="button" className="web-button justify-center" disabled={!target || off !== undefined} onClick={() => target && onMove(target)}>
            {up ? <ArrowUpIcon className="size-4" /> : <ArrowDownIcon className="size-4" />}
            {up ? "Move to the cloud" : `Bring back to ${name}`}
          </button>
          <button type="button" className="web-quiet-button justify-center" onClick={onDismiss}>
            Cancel
          </button>
        </div>
      </div>
    </Sheet>
  )
}
