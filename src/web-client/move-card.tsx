import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { ArrowDownIcon, ArrowUpIcon, ChevronDownIcon, CloudIcon, LaptopIcon, MoonIcon, RotateCwIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { useAccountList } from "./account-list"
import { useWebClient } from "./client"
import { lastSeen } from "./diagnosis"
import { barFrom, forward, percentWords, sentWords, stepFraction, stepWords, type MoveBar, type MoveWay } from "./move-progress"
import { dismissMove, listedMove, settledEnd, useMoves, type WebMove } from "./moves"
import { askAgain, startMove, type MoveMac } from "./move-actions"
import { useForm } from "./route"
import { Sheet } from "./sheet"
import type { WebSession, WebThread } from "./threads"
import { hereOf, useNow } from "./trouble-state"

/** A move as its strip draws it: one this browser follows, or the list's word on one, naming its Mac when it can. */
export type ShownMove = Pick<WebMove, "way" | "step" | "stepAt" | "sent" | "move" | "handOff" | "end" | "ours"> & { mac: { name: string } }

/** What each step means for the Thread: the desk's words (`thread-move-notice.tsx`), naming the Mac and this end. */
function stepDetail(move: ShownMove, here: string): string {
  const mac = move.mac.name
  if (move.end?.kind === "unconfirmed") return `${here} lost the answer on the way (${move.end.reason}). The move goes on on ${mac} all the same, and ${here.toLowerCase()} asks it how it went until it hears.`
  if (move.way === "cloud")
    switch (move.step) {
      case "asking":
        return `Mako on ${mac} starts it; ${here.toLowerCase()} follows each step.`
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
      return `Mako on ${mac} starts it; ${here.toLowerCase()} follows each step.`
    case "packing":
      return "Its cloud machine takes no new work and sends back its worktree and sessions. Until they're sent, it's still the cloud's."
    case "bringing":
    case "moving":
      return `The cloud let go of it. Its worktree and sessions are arriving on ${mac}; nothing runs it until they have.`
    default:
      return ""
  }
}

/** How often a move's bar creeps on while it waits: written straight to the bar and its percent, never re-rendered. */
const BAR_EVERY_MS = 250

/**
 * The bar's place, drawn through refs: the step's own span, by its bytes or its time so far, and never behind where it
 * stood, across the list's word giving way to the steps heard. A different move (a retry) starts a bar of its own.
 */
function useBar(move: ShownMove, ended: boolean, done: boolean) {
  const fill = useRef<HTMLSpanElement>(null)
  const percent = useRef<HTMLSpanElement>(null)
  const track = useRef<HTMLDivElement>(null)
  const best = useRef<MoveBar>({ move: move.move, fraction: 0 })
  const { way, step, stepAt, sent } = move
  const id = move.move
  useLayoutEffect(() => {
    best.current = barFrom(best.current, id)
    const draw = () => {
      // Ended (or its answer lost), it holds where its step had reached, drawn once.
      const fraction = done ? 1 : forward(best.current.fraction, stepFraction(way, step, Date.now() - stepAt, sent))
      best.current.fraction = fraction
      if (fill.current) fill.current.style.transform = `scaleX(${fraction})`
      if (percent.current) percent.current.textContent = percentWords(fraction, done)
      track.current?.setAttribute("aria-valuenow", String(Math.round(fraction * 100)))
    }
    draw()
    if (ended || done) return
    // Hidden, the page draws nothing; back, it catches up at once.
    const timer = setInterval(() => document.visibilityState === "visible" && draw(), BAR_EVERY_MS)
    return () => clearInterval(timer)
  }, [id, way, step, stepAt, sent, ended, done])
  return { fill, percent, track }
}

/** The Mac a Session runs on, or that a cloud Thread came from as far as this browser can tell: named, by its device. */
function macOf(session: WebSession, devices: ReadonlyMap<string, { kind: string; name: string }>): MoveMac | undefined {
  if (session.owner.kind === "device") return { deviceId: session.owner.deviceId, name: session.where }
  const macs = [...devices.entries()].filter(([, device]) => device.kind === "desktop")
  return macs.length === 1 ? { deviceId: macs[0]![0], name: macs[0]![1].name } : undefined
}

/**
 * A Thread's move while it goes, in a strip above its transcript, which stays with its composer: the agent keeps
 * working through most of a move, and a message sent meanwhile goes with it. The same on every account and form: a
 * move this browser follows, or the list's word on one. Its owner is followed for the move's steps meanwhile, the
 * forked conversation's once a Thread in the main checkout forked onto its own branch.
 */
export function ThreadMove({ thread, session }: { thread: WebThread; session: WebSession }) {
  const client = useWebClient()
  const devices = useAccountList((state) => state.devices)
  const followed = useMoves((state) => state.moves.get(thread.id))
  const listed = followed ? undefined : listedMove(thread)
  const mac = followed?.mac ?? macOf(session, devices)
  const move: ShownMove | undefined = followed ?? (listed && { ...listed, handOff: session.row.state === "working", mac: mac ?? { name: "your Mac" }, ours: false })
  const deviceId = session.owner.kind === "device" ? session.owner.deviceId : undefined
  const watched = move && !settledEnd(move.end) && move.way === "cloud" && deviceId ? (followed?.conversation ?? session.row.conversation) : undefined
  useEffect(() => {
    if (!watched || !deviceId) return
    let stop: (() => void) | undefined
    let left = false
    void client.conversations().then((conversations) => {
      if (!left) stop = conversations.followMac(deviceId, watched)
    })
    return () => {
      left = true
      stop?.()
    }
  }, [client, deviceId, watched])
  if (!move) return null
  const end = followed?.end
  const retry =
    end?.kind === "failed" && followed
      ? () => void startMove(client, { thread, conversation: session.row.conversation, way: followed.way, mac: followed.mac, handOff: session.row.state === "working" })
      : end?.kind === "unconfirmed" && followed?.move
        ? () => askAgain(followed.move!)
        : undefined
  return <MoveStrip thread={thread.id} move={move} onRetry={retry} />
}

/**
 * A move in a strip: where to, how far in words with a thin bar that only moves forward, the step it's on (what that
 * means a tap away); at its end, the outcome: moved, or the owner's reason with Retry. Not confirmed, it says so and
 * asks again.
 */
export function MoveStrip({ thread, move, onRetry }: { thread: string; move: ShownMove; onRetry: (() => void) | undefined }) {
  const form = useForm()
  const here = hereOf(form)
  const [open, setOpen] = useState(form !== "phone")
  const end = move.end
  const done = end?.kind === "done"
  const problem = end?.kind === "failed" || end?.kind === "unsettled" ? end : undefined
  const unconfirmed = end?.kind === "unconfirmed"
  const { fill, percent, track } = useBar(move, end !== undefined, done)
  const up = move.way === "cloud"
  const Arrow = up ? ArrowUpIcon : ArrowDownIcon
  const title = end?.kind === "failed"
    ? up ? "Couldn't move to the cloud" : "It stayed in the cloud"
    : end?.kind === "unsettled" ? "Waiting for the cloud's answer"
    : done ? (up ? "Moved to the cloud" : `Back on ${move.mac.name}`)
    : up ? "Moving to the cloud" : `Bringing it back to ${move.mac.name}`
  const words = unconfirmed ? `Not confirmed · asking ${move.mac.name} again` : done ? (up ? "It goes on in a cloud machine, at the same folder." : `It goes on on ${move.mac.name}.`) : stepWords(move.way, move.step, move.mac.name, move.handOff)
  const detail = problem || done ? "" : stepDetail(move, here)
  return (
    <section className="web-move" data-move={move.way} data-move-step={end ? end.kind : move.step} aria-label={title}>
      <button type="button" className="web-move-head" onClick={() => setOpen((shown) => !shown)} aria-expanded={detail ? open : undefined} disabled={!detail}>
        <span className={cn("web-move-mark", end?.kind === "failed" && "text-negative")} aria-hidden>
          {end?.kind === "failed" ? up ? <LaptopIcon className="size-4" /> : <CloudIcon className="size-4" /> : <Arrow className="size-4" />}
        </span>
        <span className="min-w-0 flex-1 text-left">
          <span className="flex items-baseline gap-2">
            <span className="min-w-0 flex-1 truncate text-ui font-semibold text-foreground">{title}</span>
            {problem ? null : <span ref={percent} className="tabular shrink-0 text-label text-faint" />}
            {detail ? <ChevronDownIcon aria-hidden className="web-move-chevron size-4 shrink-0 self-center text-faint" /> : null}
          </span>
          {problem ? null : (
            <span className={cn("block truncate text-label", unconfirmed ? "text-caution" : "text-muted-foreground")}>
              {words}
              {!done && !unconfirmed && move.step === "packing" && move.sent ? <span className="tabular text-faint"> · {sentWords(move.sent)}</span> : null}
            </span>
          )}
        </span>
      </button>
      {problem ? (
        <p className={cn("web-move-reason text-ui", problem.kind === "failed" ? "text-muted-foreground" : "text-caution")}>{problem.reason}</p>
      ) : (
        <div ref={track} className="web-move-track" role="progressbar" aria-label={title} aria-valuemin={0} aria-valuemax={100}>
          <span ref={fill} className="web-move-fill" />
        </div>
      )}
      {detail && open ? <p className="web-move-detail text-label text-muted-foreground">{detail}</p> : null}
      {problem || unconfirmed ? (
        <div className="web-move-actions">
          {onRetry && (end?.kind === "failed" || unconfirmed) ? (
            <button type="button" className={unconfirmed ? "web-quiet-button" : "web-button"} onClick={onRetry}>
              <RotateCwIcon className="size-4" />
              {unconfirmed ? "Ask now" : "Retry"}
            </button>
          ) : null}
          {problem ? (
            <button type="button" className="web-quiet-button" onClick={() => dismissMove(thread)}>
              Dismiss
            </button>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}

/**
 * Before a move: what happens to the Thread and to its turn, said plainly, and the one button that does it. Bringing
 * it back asks which Mac when the account has several; one asleep or offline is listed, and can't be chosen.
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
  const away = target ? quiet.get(target.deviceId) : undefined
  const now = useNow()
  return (
    <Sheet open={open} onDismiss={onDismiss} label={title}>
      <div className="web-move-ask" data-move-ask={way}>
        <p className="web-sheet-title px-0">{title}</p>
        <p className="text-ui text-muted-foreground">{body}</p>
        {!up && macs.length > 1 ? (
          <div role="radiogroup" aria-label="Bring it back to" className="mt-4 flex flex-col gap-1">
            {macs.map((mac) => {
              const asleep = quiet.get(mac.id)
              return (
                <button key={mac.id} type="button" role="radio" aria-checked={target?.deviceId === mac.id} disabled={asleep !== undefined} onClick={() => setChosen(mac.id)} className={cn("web-move-mac pressable", target?.deviceId === mac.id && "web-move-mac-on")}>
                  {asleep ? <MoonIcon className="size-4 text-faint" /> : <LaptopIcon className="size-4 text-muted-foreground" />}
                  <span className="min-w-0 flex-1 truncate text-left">{mac.name}</span>
                  {asleep ? <span className="text-label text-faint">Asleep or offline · seen {lastSeen(asleep, now)}</span> : null}
                </button>
              )
            })}
          </div>
        ) : null}
        {away ? <p className="mt-3 text-label text-caution">{name} is asleep or offline (seen {lastSeen(away, now)}). It has to be awake and online to {up ? "move it" : "take it back"}.</p> : null}
        <div className="mt-6 flex flex-col gap-2">
          <button type="button" className="web-button justify-center" disabled={!target || away !== undefined} onClick={() => target && onMove(target)}>
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
