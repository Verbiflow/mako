import { useEffect, useMemo, useRef, useState } from "react"
import { AcpPanel } from "@/components/viewer/acp-panel"
import { Composer as DeskComposer } from "@/components/composer/composer"
import { TranscriptEndContext, type TranscriptEnd } from "@/components/transcript/transcript-end"
import { ExchangeNoteContext, PromptNoteContext } from "@/components/transcript/transcript-notes"
import { CompactPresentationContext, type CompactPresentation } from "@/components/transcript/compact-presentation"
import { activeLiveAcp, useAcp } from "@/state/acp"
import { useWebClient } from "./client"
import { sameSwitches, switchesOf, useAnswered } from "./answered"
import { AnsweredLine, WebDock } from "./dock"
import { threadDraftKey } from "./drafts"
import { webHarnessLabel } from "./labels"
import { DELIVERY_WORDS, deliveryOf } from "./delivery"
import { resumeOutbox, retryUnconfirmed, useOutbox } from "./outbox"
import type { WebSession } from "./threads"
import { PhoneReply, ReplySheet } from "./reply"
import { useReplyHold } from "./replies"
import { useWide } from "./route"
import { PhoneSteps } from "./steps"
import { SwitchLines } from "./thread-chips"

const NO_RECORDS: never[] = []

/**
 * A Session live: opened on its owner through the gateway, drawn by the renderer's own conversation (`AcpPanel`: the
 * transcript, exactly as on a Mac), and under it on a laptop's browser (`desk`) the desktop's own composer, its routing
 * row and sigils, sending through the same bridge; under a finger, the phone's dock (`dock.tsx`): what the agent asks,
 * pinned above the composer, a capsule saying what it's doing, the queue and the phone's composer. Either way each
 * message the person sent says under it how its delivery stands (`outbox.ts`).
 */
export default function LiveSession({ session, desk = false }: { session: WebSession; desk?: boolean }) {
  const client = useWebClient()
  const conversation = session.row.conversation
  // Opened once per conversation: the row it was opened from changes as the list does, and its batches say more.
  const [opening] = useState(session)
  useEffect(() => {
    let close: (() => void) | undefined
    let left = false
    void client.conversations().then((conversations) => {
      if (!left) close = conversations.open(opening)
    })
    return () => {
      left = true
      close?.()
    }
  }, [client, conversation, opening])
  const active = useAcp((state) => state.activeKey === conversation)
  // Once its requests are read: what this browser left on its way to it is asked again under its own IDs.
  const hydrated = useAcp((state) => activeLiveAcp(state)?.key === conversation && activeLiveAcp(state)?.hydrated !== false && activeLiveAcp(state)?.requests !== undefined)
  useEffect(() => {
    if (hydrated) resumeOutbox(conversation)
  }, [hydrated, conversation])
  const [away, setAway] = useState(false)
  const [jump, setJump] = useState<{ to: (() => void) | null }>({ to: null })
  const end = useMemo<TranscriptEnd>(() => ({ away: setAway, bind: (to) => setJump({ to }) }), [])
  const note = useDeliveryNote(conversation)
  const records = useAnswered((state) => state.records.get(conversation) ?? NO_RECORDS)
  // Where the model or access changed, from the Session's own record: the same lines live, reloaded and elsewhere.
  // Read again only when the record's requests change, and kept while they say the same: a turn's lines stay drawn.
  const switches = useAcp((state) => {
    const live = state.conversations[conversation]
    return switchesOf(live?.kind === "live" ? live.requests : undefined)
  }, sameSwitches)
  const harnessId = session.row.harness
  const exchangeNote = useMemo(
    () =>
      records.length || switches.size
        ? (exchange: string, request: string | undefined) => {
            const switched = request ? switches.get(request) : undefined
            return (
              <>
                {records.filter((entry) => entry.exchange === exchange).map((entry) => <AnsweredLine key={entry.id} entry={entry} />)}
                {switched ? <SwitchLines harness={harnessId} switches={switched} /> : null}
              </>
            )
          }
        : null,
    [records, switches, harnessId]
  )
  const harness = webHarnessLabel(session.row.harness)
  const cloudThread = session.owner.kind === "cloud" ? session.owner.threadId : undefined
  const target = useMemo(() => ({ conversation, ...(cloudThread && { cloudThread }) }), [conversation, cloudThread])
  // Under a finger: replies offer Copy and Branch; on a phone's width a run of steps is one line that opens them.
  const wide = useWide()
  const compact = useMemo<CompactPresentation>(() => ({ reply: (reply) => <PhoneReply reply={reply} />, ...(!wide && { steps: (run) => <PhoneSteps key={run.id} run={run} /> }) }), [wide])
  const live = useRef<HTMLDivElement>(null)
  const hold = useReplyHold(live)
  if (desk)
    return (
      <PromptNoteContext value={note}>
        <div className="desk-live flex min-h-0 flex-1 flex-col" data-conversation={conversation}>
          {active ? <AcpPanel /> : <div className="flex-1" />}
          {active ? <DeskComposer /> : null}
        </div>
      </PromptNoteContext>
    )
  return (
    <PromptNoteContext value={note}>
      <ExchangeNoteContext value={exchangeNote}>
        <TranscriptEndContext value={end}>
          <CompactPresentationContext value={compact}>
          <div ref={live} className="web-live flex min-h-0 flex-1 flex-col" data-conversation={conversation}>
            {active ? <AcpPanel asks={false} /> : <div className="flex-1" />}
            <WebDock
              conversation={conversation}
              harness={harness}
              target={target}
              draftKey={threadDraftKey(client.account.id, conversation)}
              away={away}
              jump={() => jump.to?.()}
              reconnect={() => client.gateway.wake()}
            />
            <ReplySheet reply={hold.reply} onDismiss={hold.close} />
          </div>
          </CompactPresentationContext>
        </TranscriptEndContext>
      </ExchangeNoteContext>
    </PromptNoteContext>
  )
}

/** Under each message the person sent, how its delivery stands, in a word; "Not confirmed" with Retry. */
function useDeliveryNote(conversation: string) {
  const delivery = useAcp((state) => {
    const live = state.conversations[conversation]
    return live?.kind === "live" ? { requests: live.requests, pendingPrompts: live.pendingPrompts } : undefined
  }, (left, right) => left?.requests === right?.requests && left?.pendingPrompts === right?.pendingPrompts)
  const sending = useOutbox((state) => state.sending)
  return useMemo(() => {
    if (!delivery) return null
    return (requestId: string | undefined) => {
      if (!requestId) return null
      const state = deliveryOf(requestId, delivery, sending)
      if (!state) return null
      if (state === "unconfirmed")
        return (
          <span data-delivery={state} className="flex items-center gap-1 text-caution">
            {DELIVERY_WORDS[state]}
            <span aria-hidden>·</span>
            <button type="button" className="pressable -mx-1 rounded px-1 font-medium text-foreground" onClick={() => void retryUnconfirmed(conversation)}>
              Retry
            </button>
          </span>
        )
      return (
        <span data-delivery={state} className={state === "delivered" ? "text-faint" : undefined}>
          {DELIVERY_WORDS[state]}
        </span>
      )
    }
  }, [delivery, sending, conversation])
}
