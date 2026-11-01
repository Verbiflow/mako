import { useState } from "react"
import { ChevronRightIcon, MoonIcon } from "lucide-react"
import { QUIET_WORDS, quietLine } from "@/lib/quiet-device"
import { useWebClient } from "./client"
import { useWide } from "./route"
import { Sheet, SheetScroll } from "./sheet"
import { checkReach, useSessionDiagnosis } from "./thread-trouble"
import type { WebSession } from "./threads"
import { DiagnosisCard } from "./trouble"
import { useNow, useTryAgain } from "./trouble-state"

/**
 * A Session read from the copy its Mac keeps in the account, that Mac asleep or offline, said in one quiet line above
 * the transcript, in the words a Mac's window says it (`quietLine`): the Mac, when it was last seen, and the copy's age
 * only where the copy misses something. Nothing to press on it: the Thread turns live by itself once the Mac is back.
 * Tapped, the whole diagnosis (each hop, Try again, Copy diagnostics) rises in a sheet on a phone and opens in a popover
 * from the line where there's room, as the web app's other choices do.
 */
export function QuietStrip({ session, seenAt, copyAt }: { session: WebSession; seenAt: string | undefined; copyAt: number }) {
  const [open, setOpen] = useState(false)
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null)
  const now = useNow()
  const wide = useWide()
  const seen = seenAt === undefined ? Number.NaN : Date.parse(seenAt)
  const line = quietLine({ name: session.where, ...(Number.isFinite(seen) && { seenAt: seen }), copyAt, activityAt: Date.parse(session.row.activityAt), now })
  return (
    <>
      <button ref={setAnchor} type="button" className="web-quiet-strip pressable" data-quiet-strip={seenAt ?? ""} aria-haspopup="dialog" aria-expanded={open} aria-label={`${line.title}${line.description ? `, ${line.description}` : ""}. Details`} onClick={() => setOpen(true)}>
        <MoonIcon aria-hidden className="size-3.5 shrink-0" />
        <span className="web-quiet-strip-line">
          <span className="web-quiet-strip-what">
            <span className="web-quiet-strip-name">{session.where}</span>
            <span className="shrink-0 whitespace-pre">{` ${QUIET_WORDS}`}</span>
          </span>
          {line.description ? <span className="web-quiet-strip-since">{` · ${line.description}`}</span> : null}
        </span>
        {wide ? <span className="shrink-0 pl-2 text-faint">Details</span> : <ChevronRightIcon aria-hidden className="size-4 shrink-0 text-faint" />}
      </button>
      <Sheet open={open} onDismiss={() => setOpen(false)} label={line.title} anchor={anchor}>
        <QuietDetails session={session} />
      </Sheet>
    </>
  )
}

/** The strip's details: the diagnosis whole, then where a message sent meanwhile goes. Read only while it's open. */
function QuietDetails({ session }: { session: WebSession }) {
  const client = useWebClient()
  const diagnosis = useSessionDiagnosis(session)
  const mac = session.owner.kind === "device" ? session.owner.deviceId : undefined
  const { checking, tryAgain } = useTryAgain(() => checkReach(client, mac))
  return (
    <SheetScroll className="web-quiet-details">
      {diagnosis ? <DiagnosisCard diagnosis={diagnosis} checking={checking} onTryAgain={tryAgain} className="web-trouble-bare" /> : null}
      <p className="web-quiet-waits">A message sent now waits in your account and runs when {session.where} is back.</p>
    </SheetScroll>
  )
}
