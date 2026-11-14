import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react"
import { AcpPanel } from "@/components/viewer/acp-panel"
import { ConversationSkeleton } from "@/components/viewer/conversation-skeleton"
import { ShowAgentsContext } from "@/components/viewer/show-agents"
import { TranscriptEndContext, type TranscriptEnd } from "@/components/transcript/transcript-end"
import { ExchangeNoteContext, PromptNoteContext } from "@/components/transcript/transcript-notes"
import { CompactPresentationContext, type CompactPresentation } from "@/components/transcript/compact-presentation"
import { activeLiveAcp, useAcp } from "@/state/acp"
import { acpStore } from "@/state/acp-state"
import { AgentsSheet } from "./agents"
import { deskComposerChunk } from "./chunks"
import { CodeLine, CodeSlowLine } from "./code-unavailable"
import { useWebClient } from "./client"
import { openingThread } from "./probe"
import { useSyncing } from "./syncing"
import { sameSwitches, switchesOf, useAnswered } from "./answered"
import { AnsweredLine, WebDock, type SendElsewhere } from "./dock"
import { readDraft, threadDraftKey, writeDraft } from "./drafts"
import { webHarnessLabel } from "./labels"
import { DELIVERY_WORDS, deliveryOf } from "./delivery"
import { resumeOutbox, retryUnconfirmed, useOutbox } from "./outbox"
import { newerThan, type WebSession, type WebThread } from "./threads"
import { useNow } from "./trouble-state"
import type { OpenedBy } from "@mako/host/contracts/session-choice"
import { sendsToWords, staleSendWords } from "@/lib/session-words"
import { PhoneReply, ReplySheet } from "./reply"
import { useReplyHold } from "./replies"
import { useWide } from "./route"
import { PhoneSteps } from "./steps"
import { SwitchLines } from "./thread-chips"
import { TranscriptLoading } from "./transcript-loading"

const NO_RECORDS: never[] = []

/** The desk's composer at rest (an empty draft and its chips), the room held for it while its code arrives. */
const DESK_COMPOSER_HEIGHT = 104

/**
 * A Session live: opened on its owner through the gateway, drawn by the renderer's own conversation (`AcpPanel`: the
 * transcript, exactly as on a Mac), and under it on a laptop's browser (`desk`) the desktop's own composer, its routing
 * row and sigils, sending through the same bridge; under a finger, the phone's dock (`dock.tsx`): what the agent asks,
 * pinned above the composer, a capsule saying what it's doing, the queue and the phone's composer. Either way each
 * message the person sent says under it how its delivery stands (`outbox.ts`).
 */
export default function LiveSession({ session, desk = false, thread, openedBy = "person", onSession }: { session: WebSession; desk?: boolean; thread?: WebThread; openedBy?: OpenedBy; onSession?: (session: string) => void }) {
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
  // What it held paints before it's read again: a conversation listed anew is no longer `hydrated`, but keeps its turns.
  const drawn = useAcp((state) => state.activeKey === conversation && (state.conversations[conversation]?.projection?.exchanges.length ?? 0) > 0)
  const syncing = useSyncing((state) => state.conversation === conversation)
  // Nothing of it on this page yet, while it's opened and first read from its owner: the transcript's loader over it,
  // never an empty column under the bar. Over it, not instead of it: the transcript is mounted when its turns arrive, as
  // a held one is, so it lands them at its end as it always has. Once read, an empty conversation is its own empty
  // transcript.
  const loading = !active || (!drawn && !hydrated && syncing)
  const live = useRef<HTMLDivElement>(null)
  const deskLive = useRef<HTMLDivElement>(null)
  useOpenReading(conversation, desk ? deskLive : live, hydrated, drawn, syncing)
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
  // Said only where a Thread has more than one Session: with one, there's nowhere else it could go.
  const sendsTo = (thread?.sessions.length ?? 0) > 1 ? sendsToWords(session.facts, harness) : undefined
  const cloudThread = session.owner.kind === "cloud" ? session.owner.threadId : undefined
  const target = useMemo(() => ({ conversation, ...(cloudThread && { cloudThread }) }), [conversation, cloudThread])
  // Under a finger: replies offer Copy and Branch; on a phone's width a run of steps is one line that opens them.
  const wide = useWide()
  const compact = useMemo<CompactPresentation>(() => ({ reply: (reply) => <PhoneReply reply={reply} />, ...(!wide && { steps: (run) => <PhoneSteps key={run.id} run={run} />, navigator: false }) }), [wide])
  const hold = useReplyHold(live)
  const [agents, setAgents] = useState(false)
  const showAgents = useCallback(() => setAgents(true), [])
  const elsewhere = useSendElsewhere(session, thread, openedBy, onSession)
  const deskComposer = deskComposerChunk.use()
  const composerFailed = deskComposerChunk.useFailed()
  const composerSlow = deskComposerChunk.useSlow()
  const readComposer = useCallback(() => deskComposerChunk.read().then(() => undefined), [])
  useEffect(() => {
    if (desk && !deskComposer) void readComposer().catch(() => undefined)
  }, [desk, deskComposer, readComposer])
  if (desk)
    return (
      <PromptNoteContext value={note}>
        <div ref={deskLive} className="desk-live flex min-h-0 flex-1 flex-col" data-conversation={conversation}>
          <div className="relative flex min-h-0 flex-1 flex-col">
            {active ? <AcpPanel /> : null}
            {/* The desktop's own placeholder, in the transcript's column, as the desktop opens a conversation. */}
            {loading ? (
              <div className="absolute inset-0" aria-busy aria-label="Opening the conversation">
                <ConversationSkeleton />
              </div>
            ) : null}
          </div>
          {active ? (
            deskComposer ? (
              <deskComposer.Composer />
            ) : (
              // The composer's room while its code arrives, so the transcript above doesn't move when it does; a line
              // saying so with Retry if it can't.
              <div data-composer-pending="" aria-busy={!composerFailed} aria-label="Loading the composer" className="flex shrink-0 items-center bg-surface" style={{ height: DESK_COMPOSER_HEIGHT }}>
                {composerFailed ? <CodeLine what="The composer" retry={readComposer} className="w-full" /> : <CodeSlowLine what="the composer" slow={composerSlow} className="px-4" />}
              </div>
            )
          ) : null}
        </div>
      </PromptNoteContext>
    )
  return (
    <PromptNoteContext value={note}>
      <ExchangeNoteContext value={exchangeNote}>
        <TranscriptEndContext value={end}>
          <CompactPresentationContext value={compact}>
          <ShowAgentsContext value={showAgents}>
          <div ref={live} className="web-live flex min-h-0 flex-1 flex-col" data-conversation={conversation}>
            <div className="relative flex min-h-0 flex-1 flex-col">
              {active ? <AcpPanel asks={false} compact /> : null}
              {loading ? <TranscriptLoading className="absolute inset-0" /> : null}
            </div>
            <WebDock
              conversation={conversation}
              harness={harness}
              target={target}
              draftKey={threadDraftKey(client.account.id, conversation)}
              away={away}
              jump={() => jump.to?.()}
              reconnect={() => client.gateway.wake()}
              elsewhere={elsewhere}
              sendsTo={sendsTo}
            />
            <ReplySheet reply={hold.reply} onDismiss={hold.close} />
            <AgentsSheet conversation={conversation} open={agents} onDismiss={() => setAgents(false)} />
          </div>
          </ShowAgentsContext>
          </CompactPresentationContext>
        </TranscriptEndContext>
      </ExchangeNoteContext>
    </PromptNoteContext>
  )
}

/**
 * How long opening the conversation took to show its newest turn, and to catch up with it, for the page's readings:
 * from what this page already held of it, or from the network.
 */
function useOpenReading(conversation: string, live: RefObject<HTMLDivElement | null>, hydrated: boolean, drawn: boolean, syncing: boolean): void {
  const reading = useRef<{ opened: ReturnType<typeof openingThread>; kept: boolean } | null>(null)
  useEffect(() => {
    const opened = openingThread()
    reading.current = { opened, kept: (acpStore.get().conversations[conversation]?.projection?.exchanges.length ?? 0) > 0 }
    return () => opened.close()
  }, [conversation])
  useEffect(() => {
    const held = reading.current
    if (!held || !(drawn || hydrated)) return
    // Two frames on: the turns this render committed are painted.
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        held.opened.painted(held.kept ? "kept" : "network", live.current?.querySelectorAll("[data-exchange]").length ?? 0)
        if (hydrated && !syncing) held.opened.caughtUp()
      })
    })
    return () => cancelAnimationFrame(frame)
  }, [drawn, hydrated, syncing, live])
}

/**
 * Whether a message here asks first (`newerThan`): the screen opened on this Session by itself, asleep a day while the
 * person has worked in another of its Thread since. Switching takes the words to that one's draft, after any kept
 * there, and opens it.
 */
function useSendElsewhere(session: WebSession, thread: WebThread | undefined, openedBy: OpenedBy, onSession: ((session: string) => void) | undefined): SendElsewhere | undefined {
  const client = useWebClient()
  const now = useNow(60_000)
  const newest = thread && onSession ? newerThan(thread, session, now, openedBy) : undefined
  return useMemo(() => {
    if (!newest || !onSession) return undefined
    const key = threadDraftKey(client.account.id, newest.row.conversation)
    return {
      ...staleSendWords(session.facts, newest.facts, webHarnessLabel, now),
      switchTo: (text) => {
        writeDraft(key, [readDraft(key)?.text ?? "", text].filter((each) => each.trim()).join("\n\n"))
        onSession(newest.row.session)
      },
    }
  }, [client, newest, onSession, session.facts, now])
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
            <button type="button" className="pressable -mx-1 px-1 font-medium text-foreground" onClick={() => void retryUnconfirmed(conversation)}>
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
