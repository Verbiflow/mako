import { useEffect, useState } from "react"
import { AlertTriangleIcon, CloudIcon, CloudOffIcon, GitBranchIcon, HistoryIcon, LaptopIcon, MessageSquareIcon, RotateCwIcon } from "lucide-react"
import type { ContinueOffer } from "@mako/protocol/continues"
import { copyAge } from "@/lib/format"
import { useAccountList } from "./account-list"
import { useWebClient, type WebClient } from "./client"
import { askContinueOffer, continueRefusalShown, startContinue, useContinueChoice } from "./continue-actions"
import { lastSeen } from "./diagnosis"
import type { MoveMac } from "./move-actions"
import { useMoves } from "./moves"
import { Sheet } from "./sheet"
import type { WebSession, WebThread } from "./threads"
import { useNow } from "./trouble-state"

/**
 * Continue in the cloud, beside a Thread whose Mac is off: the offer when its rows may go (the press opens what it
 * takes, `ContinueSheet`); why not yet when a person can change that; a continue that failed, with its reason and
 * another try. Nothing while a move or continue of it is followed: its strip says that.
 */
export function ContinueOffer({ thread, session }: { thread: WebThread; session: WebSession }) {
  const choice = useContinueChoice(session)
  const followed = useMoves((state) => state.moves.get(thread.id))
  const [asking, setAsking] = useState(false)
  if (!choice || followed) return null
  const failed = session.row.continued?.phase === "failed" ? session.row.continued : undefined
  if (!choice.offer && !continueRefusalShown(choice.why)) return null
  const press = (
    <button type="button" className={failed ? "web-button" : "web-button h-9 shrink-0 px-3.5"} onClick={() => setAsking(true)} data-continue-press>
      {failed ? <RotateCwIcon className="size-4" /> : <CloudIcon className="size-4" />}
      {failed ? "Continue in the cloud" : "Continue"}
    </button>
  )
  return (
    <section className="web-continue" data-continue={choice.offer ? (failed ? "failed" : "offer") : choice.why} aria-label="Continue in the cloud">
      <div className="web-move-head">
        <span className="web-move-mark">{choice.offer ? failed ? <AlertTriangleIcon className="size-4 text-caution" /> : <CloudIcon className="size-4" /> : <CloudOffIcon className="size-4 text-muted-foreground" />}</span>
        <span className="min-w-0 flex-1">
          <span className="block text-ui font-medium">{choice.offer ? (failed ? "Couldn't continue in the cloud" : "Continue in the cloud") : "It can't continue in the cloud yet"}</span>
          {failed ? null : <span className="block text-label text-muted-foreground">{choice.offer ? `Pick up where ${choice.mac.name} left off, on a cloud machine.` : choice.text}</span>}
        </span>
        {choice.offer && !failed ? press : null}
      </div>
      {choice.offer && failed ? (
        <>
          <p className="web-move-reason text-label text-muted-foreground">{failed.reason ?? "It didn't continue in the cloud."}</p>
          <div className="web-move-actions">{press}</div>
        </>
      ) : null}
      {choice.offer ? <ContinueSheet open={asking} thread={thread} session={session} mac={choice.mac} onDismiss={() => setAsking(false)} onContinue={(client) => {
        setAsking(false)
        void startContinue(client, { thread, session, mac: choice.mac })
      }} /> : null}
    </section>
  )
}

/**
 * What a continue takes, before the press, in the gateway's words: the branch the machine clones and that unpushed
 * changes stay on the Mac, the sessions as the Mac last sent them (and when the copy of what it showed is newer than
 * what it sent, that its last turns may stay behind), the messages that waited for the Mac and go with it.
 */
export function ContinueSheet({ open, thread, session, mac, onDismiss, onContinue }: { open: boolean; thread: WebThread; session: WebSession; mac: MoveMac; onDismiss: () => void; onContinue: (client: WebClient) => void }) {
  const client = useWebClient()
  const [offer, setOffer] = useState<ContinueOffer | { failed: string } | undefined>(undefined)
  const quietSince = useAccountList((state) => state.quiet.get(mac.deviceId))
  const now = useNow()
  useEffect(() => {
    if (!open) return
    // Asked again at each opening; what the last one said stands until the answer comes.
    let current = true
    askContinueOffer(client, session.row.session)
      .then((answer) => current && setOffer(answer))
      .catch((error) => current && setOffer({ failed: error instanceof Error ? error.message : String(error) }))
    return () => {
      current = false
    }
  }, [open, client, session.row.session])
  const waiting = thread.waitingMessages
  const ready = offer && "offer" in offer && offer.offer ? offer : undefined
  const behind = ready?.sessions.some((each) => each.freshness.behind) ?? false
  const sent = ready?.sessions.flatMap((each) => (each.freshness.originalsAt ? [Date.parse(each.freshness.originalsAt)] : [])) ?? []
  const refused = offer && "offer" in offer && !offer.offer ? offer.detail : offer && "failed" in offer ? offer.failed : undefined
  return (
    <Sheet open={open} onDismiss={onDismiss} label="Continue in the cloud?">
      <div className="web-move-ask" data-continue-ask={ready ? "ready" : refused ? "refused" : "asking"}>
        <p className="web-sheet-title px-0">Continue in the cloud?</p>
        <p className="text-ui text-muted-foreground">
          {mac.name} is asleep or offline{quietSince ? ` (seen ${lastSeen(quietSince, now)})` : ""}. Your account carries this Thread to a cloud machine, at the same folder, and it goes on there.
        </p>
        <ul className="web-continue-facts">
          <li>
            <GitBranchIcon className="size-4" />
            <span>{ready?.repository.branch ? <><span className="font-mono text-foreground">{ready.repository.branch}</span>, as pushed to GitHub. Changes on {mac.name} that weren't pushed stay there.</> : <span className="web-continue-pending">Its branch, as pushed to GitHub</span>}</span>
          </li>
          <li>
            <HistoryIcon className="size-4" />
            <span>{ready ? `Its ${ready.sessions.length === 1 ? "session" : `${ready.sessions.length} sessions`}, as ${mac.name} last sent ${ready.sessions.length === 1 ? "it" : "them"}${sent.length ? ` ${copyAge(Math.min(...sent), now)}` : ""}.` : <span className="web-continue-pending">Its sessions, as {mac.name} last sent them</span>}</span>
          </li>
          {waiting ? (
            <li>
              <MessageSquareIcon className="size-4" />
              <span>{waiting === 1 ? "The message waiting for it runs there, once." : `The ${waiting} messages waiting for it run there, once, in order.`}</span>
            </li>
          ) : null}
          <li>
            <LaptopIcon className="size-4" />
            <span>When {mac.name} is back, it lets the Thread go. Bring it back any time.</span>
          </li>
        </ul>
        {behind ? (
          <p className="web-continue-behind" data-continue-behind>
            <AlertTriangleIcon className="size-4 shrink-0" />
            <span>The last turns you read may not have reached your account before {mac.name} went quiet. The cloud goes on from what it sent; anything after stays in {mac.name}'s history.</span>
          </p>
        ) : null}
        {refused ? <p className="mt-3 text-label text-caution" data-continue-refused>{refused}</p> : null}
        <div className="mt-6 flex flex-col gap-2">
          <button type="button" className="web-button justify-center" disabled={!ready} onClick={() => onContinue(client)} data-continue-go>
            <CloudIcon className="size-4" />
            Continue in the cloud
          </button>
          <button type="button" className="web-quiet-button justify-center" onClick={onDismiss}>
            Cancel
          </button>
        </div>
      </div>
    </Sheet>
  )
}
