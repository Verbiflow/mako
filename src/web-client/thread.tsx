import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { ArchiveIcon, ArrowDownIcon, ArrowUpIcon, CheckIcon, ChevronLeftIcon, ChevronsUpDownIcon, CloudIcon, EllipsisIcon, FileDiffIcon, FolderTreeIcon, GlobeIcon, LaptopIcon, MoonIcon, MoreHorizontalIcon, PlusIcon, ServerIcon, XIcon } from "lucide-react"
import { sessionStanding, type OpenedBy } from "@mako/host/contracts/session-choice"
import { forkedFrom, sessionBrief, sessionDetail, sessionName } from "@/lib/session-words"
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/menu"
import { Spinner } from "@/components/ui/spinner"
import { toast } from "sonner"
import type { PromptAttachment } from "@mako/host/contracts/providers-acp"
import { MoveDividersContext } from "@/components/transcript/transcript-notes"
import { RoutedOpenContext } from "@/components/transcript/routed-open"
import { WebHarnessIcon } from "./harness-icon"
import { copyAge } from "@/lib/format"
import { cn } from "@/lib/utils"
import { useAccountList } from "./account-list"
import { useWebClient } from "./client"
import { Composer } from "./composer"
import { threadDraftKey } from "./drafts"
import { webHarnessLabel } from "./labels"
import { MoveSheet, ThreadMove } from "./move-card"
import { ContinueOffer, ContinueSheet } from "./continue-cloud"
import { startContinue, useContinueChoice } from "./continue-actions"
import { startMove, type MoveMac } from "./move-actions"
import type { MoveWay } from "./move-progress"
import { askBringBack, listedMove, useBringBackAsked, useMoves } from "./moves"
import { StartSheet, type AddingTo } from "./new-thread"
import { PreviewSheet, ServerCard } from "./preview"
import { appKey, appShownAs, askPreview, loopbackTarget, useApps, useThreadApp } from "./previews"
import { useForm } from "./route"
import { CLOUD_WHERE, openingSession, ownerOf, sessionsByLastWorked, subtitle, type WebSession, type WebThread } from "./threads"
import { Sheet, SheetScroll } from "./sheet"
import { startingWhere } from "./started"
import { useThread } from "./use-thread"
import { archiveAndSay } from "./archive-thread"
import { useSyncing } from "./syncing"
import { useDelayedStatus } from "./delayed-status"
import { useBranchOpening } from "./replies"
import { checkReach, useSessionDiagnosis } from "./thread-trouble"
import { DiagnosisCard } from "./trouble"
import { useNow, useTryAgain } from "./trouble-state"
import { QuietStrip } from "./quiet-strip"
import { activeLiveAcp, useAcp } from "@/state/acp"
import { openFiles } from "./files-open"
import { openReview } from "./review-open"
import { useCopyMissing } from "./copies"
import { FinOfApexContext, OpenChildContext, childSession, placedSessionOf } from "./fin-of-apex"
import { PhoneFinCount } from "./apex-fins"
import { transcriptChunk } from "./chunks"
import { TranscriptLoading } from "./transcript-loading"
import { CodeLine, CodeSlowLine } from "./code-unavailable"
import { ApexMark } from "@/components/ui/apex-mark"
import type { NativeAgent } from "@mako/host/contracts/native-agents"

export function ThreadScreen({ threadId, sessionId, onBack, onSession, wide }: { threadId: string; sessionId?: string; onBack: () => void; onSession: (session: string) => void; wide: boolean }) {
  const thread = useThread(threadId)
  const phase = useAccountList((state) => state.phase)
  const heading = useRef<HTMLHeadingElement>(null)
  // Read again after a return or a reconnect, or opened from what this page kept: said quietly where its place is.
  const syncingConversation = useSyncing((state) => state.conversation)
  const syncing = useDelayedStatus(thread?.sessions.some((each) => each.row.conversation === syncingConversation) ? "Syncing…" : null, threadId)
  const [adding, setAdding] = useState(false)
  // The Session it opened on, when the address names none: kept while the screen is open, so a Session that stops
  // waiting or working doesn't hand the screen to another tab under the person's thumb.
  const [openedOn, setOpenedOn] = useState<string | undefined>(undefined)
  // One of its Fins opened from a chip under its bar, back to it by the bar's back button.
  const [child, setChild] = useState<{ apex: string; agent: NativeAgent; own?: WebSession } | null>(null)
  if (child && child.apex !== threadId) setChild(null)
  useEffect(() => heading.current?.focus({ preventScroll: true }), [threadId])
  const client = useWebClient()
  // A branch made from a reply here opens as this Thread's new tab once its owner lists it.
  const listedSessions = useMemo(() => thread?.sessions.map((each) => ({ conversation: each.row.conversation, session: each.row.session })) ?? [], [thread])
  useBranchOpening(listedSessions, onSession)
  // A Thread on screen is seen: its notices go from this device and every other (`WebPush.seen`), now and each time the
  // page comes back to the front on it (a notification tapped while it was open lands here without a new route). By its
  // Mako Thread ID, which the notices are kept by, whichever ID the route named it by.
  const seenThread = thread?.id
  useEffect(() => {
    if (!seenThread) return
    const seen = () => {
      if (document.visibilityState === "visible") void client.push.seen(seenThread).catch(() => undefined)
    }
    seen()
    document.addEventListener("visibilitychange", seen)
    return () => document.removeEventListener("visibilitychange", seen)
  }, [client, seenThread])
  if (!thread) {
    // A Thread started from here is listed once its owner reports it, a moment after its harness starts.
    const starting = startingWhere(threadId)
    return (
      <div className="flex min-h-0 flex-1 flex-col bg-surface">
        <ThreadBar onBack={wide ? undefined : onBack} title={starting ? `Starting on ${starting}…` : phase === "live" ? "Not in your list" : "Opening…"} subtitle={undefined} headingRef={heading} />
        {starting ? (
          <TranscriptLoading />
        ) : phase === "live" ? (
          <p className="mx-auto max-w-[340px] px-6 pt-20 text-center text-ui text-muted-foreground">This Thread isn't in your list any more. It may have been archived or closed on another device.</p>
        ) : null}
      </div>
    )
  }
  const session = thread.sessions.find((each) => each.row.session === (sessionId ?? openedOn)) ?? openingSession(thread)
  if (sessionId === undefined && openedOn !== session.row.session && !thread.sessions.some((each) => each.row.session === openedOn)) setOpenedOn(session.row.session)
  const owner = ownerOf(session)
  const addingTo: AddingTo | undefined = session.row.folder && !thread.archived && !session.quietSince ? { thread: thread.id, folder: session.row.folder, owner, where: session.where === CLOUD_WHERE ? "Cloud" : session.where } : undefined
  const opened = child ? child.own ?? childSession(session, child.agent) : undefined
  const openChild = (agent: NativeAgent) => {
    if (!agent.child?.conversation) return
    // A Fin placed on another device: its own row, written by that device, is what opens, and that device answers.
    const own = placedSessionOf(agent)
    setChild({ apex: thread.id, agent, ...(own && { own }) })
  }
  if (child && opened)
    return (
      <div className="flex min-h-0 flex-1 flex-col bg-surface" data-thread-screen={thread.id} data-child-of={thread.id}>
        <ThreadBar
          onBack={() => setChild(null)}
          backLabel={thread.title}
          title={child.agent.title}
          subtitle={subtitle(thread, session)}
          place={session.row.runsOn.kind === "cloud" ? "cloud" : session.machine ? "machine" : "device"}
          headingRef={heading}
        />
        <FinOfApexContext value={thread.title}>
          <ThreadBody thread={thread} session={opened} />
        </FinOfApexContext>
      </div>
    )
  return (
    <div className="flex min-h-0 flex-1 flex-col bg-surface" data-thread-screen={thread.id}>
      <OpenChildContext value={openChild}>
        <ThreadBar
          onBack={wide ? undefined : onBack}
          title={thread.title}
          subtitle={syncing ?? subtitle(thread, session)}
          place={session.row.runsOn.kind === "cloud" ? "cloud" : session.quietSince ? "quiet" : session.machine ? "machine" : "device"}
          headingRef={heading}
          actions={
            thread.archived ? undefined : (
              <>
                <PhoneFinCount thread={thread.id} conversation={session.row.conversation} />
                <ThreadActions thread={thread} session={session} onArchived={onBack} onAdd={addingTo && thread.sessions.length === 1 ? () => setAdding(true) : undefined} />
              </>
            )
          }
        />
        {thread.sessions.length > 1 ? <SessionSwitcher thread={thread} current={session} wide={wide} onSession={onSession} onAdd={addingTo ? () => setAdding(true) : undefined} /> : null}
        <RoutedOpenContext value={openChild}>
          <ThreadBody thread={thread} session={session} openedBy={sessionId === undefined ? "screen" : "person"} onSession={onSession} />
        </RoutedOpenContext>
      </OpenChildContext>
      {addingTo ? (
        <StartSheet
          open={adding}
          adding={addingTo}
          onDismiss={() => setAdding(false)}
          onStarted={(started) => {
            setAdding(false)
            // The new Session opens once its owner lists it; until then the Thread stays on the one it was on.
            const listed = thread.sessions.find((each) => each.row.conversation === started.conversationId)
            if (listed) onSession(listed.row.session)
          }}
        />
      ) : null}
    </div>
  )
}

/**
 * What a Thread shows under its bar, on a phone, a tablet and a laptop's browser alike: archived, or the Session, live
 * or, while its Mac is asleep or offline, read from the copy that Mac keeps in the account, a message sent waiting for
 * it; with no copy to read, why its Mac can't be reached instead. Above it, a move while one goes, the transcript and
 * composer kept under it; above the transcript, what can't be reached, when something can't (its Mac off, and since
 * when), and the servers its app runs. Links in it to the app's own address open the app here.
 */
export function ThreadBody({ thread, session, desk = false, openedBy = "person", onSession }: { thread: WebThread; session: WebSession; desk?: boolean; openedBy?: OpenedBy; onSession?: (session: string) => void }) {
  const client = useWebClient()
  // Only whether one goes: the strip follows its steps itself, so its progress re-renders nothing under it.
  const moving = useMoves((state) => state.moves.has(thread.id)) || listedMove(thread) !== undefined
  // Carried on by the account while its Mac is off: that the Mac can't be reached is no longer the news.
  const continuing = useMoves((state) => {
    const followed = state.moves.get(thread.id)
    return followed?.continued === true && followed.end?.kind !== "failed"
  }) || listedMove(thread)?.continued === true
  const owner = ownerOf(session)
  const live = !thread.archived && !session.quietSince && !moving
  const noCopy = useCopyMissing((state) => (session.quietSince ? state.missing.get(session.row.conversation) : undefined))
  useThreadApp(client, session.row.conversation, owner, session.row.folder, live)
  // The renderer's live conversation (its transcript, approvals and questions, the desktop's own code), its own chunk.
  const transcript = transcriptChunk.use()
  const transcriptFailed = transcriptChunk.useFailed()
  const transcriptSlow = transcriptChunk.useSlow()
  const readTranscript = useCallback(() => transcriptChunk.read().then(() => undefined), [])
  useEffect(() => {
    if (!transcript) void transcriptChunk.read().catch(() => undefined)
  }, [transcript])
  // Its Mac off, what would carry the Thread on: said after why it can't be reached, as the remedy to it.
  const offered = session.quietSince && !moving && cloudOn(client.account.entitlements) ? <ContinueOffer thread={thread} session={session} /> : null
  // A link to the app's own address (`localhost:5173/login`) opens the app here, through its owner, not this phone's own.
  const openLinks = (event: React.MouseEvent) => {
    const anchor = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("a[href]") : null
    const target = anchor ? loopbackTarget(anchor.href) : undefined
    if (!target || !live) return
    event.preventDefault()
    event.stopPropagation()
    askPreview(session.row.conversation, target)
  }
  return (
    <>
      {thread.archived ? (
        <ArchivedThread thread={thread} />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col" onClickCapture={openLinks}>
          {moving ? <ThreadMove thread={thread} session={session} /> : null}
          {noCopy || continuing ? null : <ThreadTrouble session={session} />}
          {/* One place whether or not a copy is held, so the copy's answer doesn't close its sheet. */}
          {offered}
          {noCopy ? (
            <QuietSession key={session.row.session} session={session} />
          ) : (
            <>
              {moving || session.quietSince ? null : <ServerCards session={session} />}
              <MoveDividersContext value>
                {transcript ? (
                  <transcript.default key={session.row.conversation} session={session} desk={desk} thread={thread} openedBy={openedBy} onSession={onSession} />
                ) : transcriptFailed ? (
                  <div className="flex flex-1 items-center">
                    <CodeLine what="The conversation" retry={readTranscript} className="w-full" />
                  </div>
                ) : (
                  <>
                    {transcriptSlow ? <CodeSlowLine what="the conversation" slow className="justify-center px-4 pt-4" /> : null}
                    <TranscriptLoading />
                  </>
                )}
              </MoveDividersContext>
            </>
          )}
        </div>
      )}
      <PreviewSheet conversation={session.row.conversation} owner={owner} folder={session.row.folder} title={thread.title} />
    </>
  )
}

/**
 * What can't be reached for a Session, above its transcript. Its Mac asleep or offline with the copy it keeps on screen:
 * one quiet line (`QuietStrip`), there from when the copy is drawn until the Mac is back and the Session live. Anything
 * else that failed: the headline in a strip, Details a tap away.
 */
function ThreadTrouble({ session }: { session: WebSession }) {
  const client = useWebClient()
  const diagnosis = useSessionDiagnosis(session)
  const mac = session.owner.kind === "device" ? session.owner.deviceId : undefined
  const { checking, tryAgain } = useTryAgain(() => checkReach(client, mac))
  const conversation = session.row.conversation
  const copyAt = useAcp((state) => {
    const live = activeLiveAcp(state)
    return live?.key === conversation ? live.copy?.at : undefined
  })
  // Its copy on screen and its Mac not heard: quiet as the list says, or refused a call before the list says so.
  const macOff = copyAt !== undefined && (session.quietSince !== undefined || diagnosis?.at === "mac")
  // Each said once it has lasted a moment: a reconnect that's over at once, or a list kept from the last visit that the
  // account's own answer corrects, never shows.
  const quiet = useDelayedStatus(macOff ? (session.quietSince ?? UNHEARD) : null, conversation)
  const shown = useDelayedStatus(diagnosis ? diagnosis.headline : null, conversation)
  if (quiet && copyAt !== undefined) return <QuietStrip session={session} seenAt={quiet === UNHEARD ? undefined : quiet} copyAt={copyAt} />
  if (!diagnosis || !shown || session.quietSince) return null
  return <DiagnosisCard diagnosis={diagnosis} checking={checking} onTryAgain={tryAgain} compact className="web-trouble-strip" />
}

/** A Mac not heard that the list doesn't call quiet yet: when it was last seen isn't known. */
const UNHEARD = "unheard"

/**
 * The servers a live Session's app runs, a card each, while it runs: tap one to open it here. Where there's room for
 * them; a phone says it in the capsule instead (`appShownAs`).
 */
function ServerCards({ session }: { session: WebSession }) {
  const shown = appShownAs(useForm()) === "cards"
  const folder = session.row.folder
  const key = folder ? appKey(ownerOf(session), folder) : undefined
  const servers = useApps((state) => (key ? state.apps.get(key)?.servers : undefined))
  const up = servers?.filter((server) => server.state !== "stopped") ?? []
  if (!shown || !up.length) return null
  return (
    <div className="web-servers web-scroll" aria-label="Its app">
      {up.map((server) => (
        <ServerCard key={server.port} server={server} compact onOpen={() => askPreview(session.row.conversation, { port: server.port })} />
      ))}
    </div>
  )
}

function ThreadBar({ onBack, backLabel, title, subtitle, place, headingRef, actions }: { onBack: (() => void) | undefined; backLabel?: string; title: string; subtitle: string | undefined; place?: "cloud" | "device" | "machine" | "quiet"; headingRef: React.Ref<HTMLHeadingElement>; actions?: React.ReactNode }) {
  // Where it runs, as the desk's strip and the list's rows draw it: a Mac asleep or offline under the moon.
  const Place = place === "cloud" ? CloudIcon : place === "quiet" ? MoonIcon : place === "machine" ? ServerIcon : LaptopIcon
  return (
    <header className="web-bar web-bar-thread flex shrink-0 items-center gap-1 px-1.5">
      {onBack && backLabel ? (
        <button type="button" aria-label={`Back to ${backLabel}`} data-back-to-apex onClick={onBack} className="pressable flex h-11 max-w-[40%] shrink-0 items-center gap-0.5 pr-1.5 text-ui text-muted-foreground">
          <ChevronLeftIcon className="size-6 shrink-0" strokeWidth={2} />
          <ApexMark className="size-3 shrink-0" />
          <span className="ml-1 truncate">{backLabel}</span>
        </button>
      ) : onBack ? (
        <button type="button" aria-label="Back to threads" onClick={onBack} className="web-icon-button">
          <ChevronLeftIcon className="size-6" strokeWidth={2} />
        </button>
      ) : (
        <span className="w-2" />
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <h1 ref={headingRef} tabIndex={-1} className="truncate text-ui font-semibold outline-none">
          {title}
        </h1>
        {subtitle ? (
          <p className="flex min-w-0 items-center gap-1 text-label text-faint">
            {place ? <Place aria-hidden data-place={place} className="size-3 shrink-0" /> : null}
            <span className="truncate">{subtitle}</span>
          </p>
        ) : null}
      </div>
      {actions}
    </header>
  )
}

/**
 * What a Thread can be asked from a phone: its app opened, moved from its Mac to the cloud or brought back, archived. A
 * cloud Thread's archive is the cloud's own; another device's Sessions are archived, and moved, by asking that device.
 * Each can be refused, in the owner's words.
 */
export function ThreadActions({ thread, session, onArchived, onAdd, desk = false }: { thread: WebThread; session: WebSession; onArchived: () => void; onAdd: (() => void) | undefined; desk?: boolean }) {
  // In a laptop's browser, the desktop's own menu: its rows and glyphs at the desk's size, under the strip's `…`.
  const item = desk ? undefined : "min-h-11 gap-2.5 px-3 text-ui"
  const glyph = desk ? "size-3.5" : "size-4 text-muted-foreground"
  const client = useWebClient()
  const devices = useAccountList((state) => state.devices)
  const moving = useMoves((state) => state.moves.has(thread.id)) || listedMove(thread) !== undefined
  const [busy, setBusy] = useState<string | undefined>(undefined)
  const [asking, setAsking] = useState<MoveWay | undefined>(undefined)
  const [continuing, setContinuing] = useState(false)
  // The person allowed its agent's ask to come back: the sheet that picks the Mac, as the menu's Bring it back opens.
  const backAsked = useBringBackAsked((state) => state.conversation === session.row.conversation)
  const way = backAsked ? "device" : asking
  const choice = useContinueChoice(session.quietSince ? session : undefined)
  const offered = choice?.offer && cloudOn(client.account.entitlements) && !moving ? choice : undefined
  const onMac = session.owner.kind === "device" && !session.quietSince ? session.owner : undefined
  const inCloud = session.owner.kind === "cloud"
  const hasMac = [...devices.values()].some((device) => device.kind === "desktop")
  const archive = () => void archiveAndSay(client, thread, setBusy, onArchived)
  // At work as the open Session says it, at once, or as the list does: the list hears of a turn just sent only at its owner's next report.
  const liveWorking = useAcp((state) => {
    const live = activeLiveAcp(state)
    return live?.key === session.row.conversation && live.session.status === "running"
  })
  const working = liveWorking || session.row.state === "working"
  const move = (mac: MoveMac) => {
    setAsking(undefined)
    askBringBack(undefined)
    if (way) void startMove(client, { thread, conversation: session.row.conversation, way, mac, handOff: working })
  }
  if (busy)
    return (
      <span role="status" className="flex shrink-0 items-center gap-1.5 pr-3 text-label text-muted-foreground">
        <Spinner aria-hidden className="size-3.5" />
        {busy}
      </span>
    )
  return (
    <>
      <Menu>
        <MenuTrigger asChild>
          {desk ? (
            <button type="button" aria-label="More for this Thread" className="pressable mr-1 flex size-7 shrink-0 items-center justify-center text-faint hover:bg-fill-hover hover:text-foreground data-[state=open]:bg-fill-hover data-[state=open]:text-foreground">
              <MoreHorizontalIcon className="size-3.5" />
            </button>
          ) : (
            <button type="button" aria-label="More for this Thread" className="web-icon-button">
              <EllipsisIcon className="size-5" />
            </button>
          )}
        </MenuTrigger>
        <MenuContent align="end" className={desk ? "min-w-52" : "min-w-56"}>
          {onAdd ? (
            <MenuItem onSelect={onAdd} className={item}>
              <PlusIcon className={glyph} />
              Add a Session
            </MenuItem>
          ) : null}
          {!session.quietSince ? (
            <MenuItem onSelect={() => openReview({ conversation: session.row.conversation, scope: { kind: "thread" } })} className={item}>
              <FileDiffIcon className={glyph} />
              Changes
            </MenuItem>
          ) : null}
          {!session.quietSince ? (
            <MenuItem onSelect={() => openFiles({ conversation: session.row.conversation })} className={item}>
              <FolderTreeIcon className={glyph} />
              Files
            </MenuItem>
          ) : null}
          {session.row.folder && !session.quietSince && !moving ? (
            <MenuItem onSelect={() => askPreview(session.row.conversation)} className={item}>
              <GlobeIcon className={glyph} />
              Open app
            </MenuItem>
          ) : null}
          {onMac && cloudOn(client.account.entitlements) && !moving ? (
            <MenuItem onSelect={() => setAsking("cloud")} className={item}>
              <ArrowUpIcon className={glyph} />
              Move to the cloud
            </MenuItem>
          ) : null}
          {offered ? (
            <MenuItem onSelect={() => setContinuing(true)} className={item}>
              <CloudIcon className={glyph} />
              Continue in the cloud
            </MenuItem>
          ) : null}
          {inCloud && hasMac && !moving ? (
            <MenuItem onSelect={() => setAsking("device")} className={item}>
              <ArrowDownIcon className={glyph} />
              Bring back to a Mac
            </MenuItem>
          ) : null}
          <MenuItem onSelect={archive} className={item}>
            <ArchiveIcon className={glyph} />
            Archive
          </MenuItem>
        </MenuContent>
      </Menu>
      <MoveSheet
        open={way !== undefined}
        way={way ?? "cloud"}
        working={working}
        from={onMac ? { deviceId: onMac.deviceId, name: session.where } : undefined}
        onDismiss={() => {
          setAsking(undefined)
          askBringBack(undefined)
        }}
        onMove={move}
      />
      {offered ? (
        <ContinueSheet
          open={continuing}
          thread={thread}
          session={session}
          mac={offered.mac}
          onDismiss={() => setContinuing(false)}
          onContinue={(client) => {
            setContinuing(false)
            void startContinue(client, { thread, session, mac: offered.mac })
          }}
        />
      ) : null}
    </>
  )
}

function cloudOn(entitlements: readonly string[]): boolean {
  return entitlements.includes("cloud")
}

/**
 * A Thread's Sessions under a finger, phone and tablet alike: one line naming the Session the composer sends to (its
 * harness's mark, its own name, how it stands and when the person last worked in it), and how many there are, with a
 * dot when another waits on the person or works. Pressed, the Sessions newest first, each said the same way, the ones
 * asleep folded under the rest; `+` adds one. A row of harness names told nothing apart: a Thread's Sessions are often
 * one harness, and a fork keeps the title it was forked from.
 */
function SessionSwitcher({ thread, current, wide, onSession, onAdd }: { thread: WebThread; current: WebSession; wide: boolean; onSession: (session: string) => void; onAdd: (() => void) | undefined }) {
  const [open, setOpen] = useState(false)
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const now = useNow(60_000)
  const others = thread.sessions.filter((session) => session !== current).map((session) => sessionStanding(session.facts, now))
  const busy = others.includes("waiting") ? "waiting" : others.includes("working") ? "working" : undefined
  const label = webHarnessLabel(current.row.harness)
  const name = sessionName(current.facts, label)
  const parent = forkedFrom(current.facts, thread.sessions.map((session) => session.facts), webHarnessLabel)
  return (
    <div className="flex shrink-0 items-center gap-1 border-b border-hairline px-2 py-1.5" data-session-switcher>
      <button
        ref={setAnchor}
        type="button"
        aria-haspopup="dialog"
        aria-label={`Sessions in this Thread: ${thread.sessions.length}. Sending to ${name}, ${sessionDetail(current.facts, now, label, parent)}`}
        onClick={() => setOpen(true)}
        className="web-session-current"
      >
        <WebHarnessIcon harness={current.row.harness} className="size-4 shrink-0" />
        <span className="flex min-w-0 flex-1 items-baseline gap-1 text-left">
          <span className="min-w-0 truncate font-medium text-foreground">{name}</span>
          {/* A phone's width holds "Fork"; who it was forked from is in the list, one tap away. */}
          <span className="shrink-0 text-faint">· {sessionBrief(current.facts, now, label, wide ? parent : undefined)}</span>
        </span>
        <span className="flex shrink-0 items-center gap-1 text-label text-muted-foreground">
          {busy ? <span aria-label={busy === "waiting" ? "another is waiting on you" : "another is working"} className={cn("size-1.5 rounded-full", busy === "waiting" ? "bg-attention" : "bg-sea")} /> : null}
          {thread.sessions.length}
          <ChevronsUpDownIcon aria-hidden className="size-3.5" />
        </span>
      </button>
      {onAdd ? (
        <button type="button" aria-label="Add a Session" onClick={onAdd} className="web-icon-button size-9 shrink-0">
          <PlusIcon className="size-4" />
        </button>
      ) : null}
      <Sheet open={open} onDismiss={() => setOpen(false)} label="Sessions in this Thread" anchor={anchor}>
        <SessionList
          thread={thread}
          current={current}
          now={now}
          onPick={(session) => {
            setOpen(false)
            // The one already open too: picked, it's where the person means their words to go (`OpenedBy`).
            onSession(session)
          }}
          onAdd={
            onAdd
              ? () => {
                  setOpen(false)
                  onAdd()
                }
              : undefined
          }
        />
      </Sheet>
    </div>
  )
}

/** The Sessions of a Thread, newest first, the ones asleep folded unless one is open. */
function SessionList({ thread, current, now, onPick, onAdd }: { thread: WebThread; current: WebSession; now: number; onPick: (session: string) => void; onAdd: (() => void) | undefined }) {
  const [unfolded, setUnfolded] = useState(false)
  const ordered = sessionsByLastWorked(thread)
  const shown = ordered.filter((session, index) => unfolded || index === 0 || session === current || sessionStanding(session.facts, now) !== "asleep")
  const folded = ordered.length - shown.length
  const facts = thread.sessions.map((session) => session.facts)
  return (
    <>
      <h3 className="web-sheet-title">Sessions in this Thread</h3>
      <SheetScroll className="flex flex-col px-2 pb-[calc(env(safe-area-inset-bottom)+12px)]">
        <ul role="list" aria-label="Sessions in this Thread" className="flex flex-col">
          {shown.map((session) => {
            const selected = session === current
            const label = webHarnessLabel(session.row.harness)
            const standing = sessionStanding(session.facts, now)
            return (
              <li key={session.row.session}>
                <button type="button" aria-current={selected || undefined} data-session-row={session.row.session} onClick={() => onPick(session.row.session)} className={cn("web-choice web-session-choice", selected && "bg-fill-selected")}>
                  <WebHarnessIcon harness={session.row.harness} className="size-5 shrink-0" />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate font-medium">{sessionName(session.facts, label)}</span>
                    <span className={cn("line-clamp-2 text-label", standing === "waiting" ? "text-attention" : standing === "failed" ? "text-negative" : "text-faint")}>
                      {session.facts.title ? `${label} · ` : ""}
                      {sessionDetail(session.facts, now, label, forkedFrom(session.facts, facts, webHarnessLabel))}
                    </span>
                  </span>
                  {selected ? <CheckIcon aria-label="Sending here" className="size-4 shrink-0 text-foreground" /> : null}
                </button>
              </li>
            )
          })}
        </ul>
        {folded ? (
          <button type="button" data-session-fold className="web-choice text-muted-foreground" onClick={() => setUnfolded(true)}>
            <MoonIcon aria-hidden className="size-[18px] shrink-0" />
            {folded === 1 ? "1 more, asleep" : `${folded} more, asleep`}
          </button>
        ) : null}
        {onAdd ? (
          <button type="button" className="web-choice text-muted-foreground" onClick={onAdd}>
            <PlusIcon aria-hidden className="size-[18px] shrink-0" />
            Add a Session
          </button>
        ) : null}
      </SheetScroll>
    </>
  )
}

/**
 * A Session whose Mac can't be reached and whose copy can't be read (the account has none yet, or neither it nor this
 * browser has it now): why, hop by hop (this phone, Mako Cloud, the Mac, its harness), with what it may be, Try again
 * and Copy diagnostics. Nothing runs it and nothing answers for it meanwhile; a message sent here waits in the account
 * and runs once the Mac is back.
 */
export function QuietSession({ session }: { session: WebSession }) {
  const client = useWebClient()
  const diagnosis = useSessionDiagnosis(session)
  const mac = session.owner.kind === "device" ? session.owner.deviceId : undefined
  const { checking, tryAgain } = useTryAgain(() => checkReach(client, mac))
  const send = async (text: string, _attachments: PromptAttachment[], id: string): Promise<boolean> => {
    try {
      // Put under the message's own ID: asked again, it's the same message.
      await client.gateway.rest("PUT", `/v1/sessions/${encodeURIComponent(session.row.session)}/waiting/${id}`, { conversation: session.row.conversation, text })
      return true
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
      return false
    }
  }
  const remove = (id: string) => void client.gateway.rest("DELETE", `/v1/sessions/${encodeURIComponent(session.row.session)}/waiting/${encodeURIComponent(id)}`).catch((error) => toast.error(error instanceof Error ? error.message : String(error)))
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-quiet-session>
      <div className="web-scroll min-h-0 flex-1 overflow-y-auto px-4 pt-6">
        <div className="mx-auto max-w-[460px]">
          {diagnosis ? <DiagnosisCard diagnosis={diagnosis} checking={checking} onTryAgain={tryAgain} /> : null}
          <p className="mt-4 px-1 text-label text-muted-foreground">A message sent now waits in your account and runs when {session.where} is back.</p>
        </div>
        {session.waiting.length ? (
          <ul role="list" className="mx-auto mt-4 flex max-w-[460px] flex-col gap-2">
            {session.waiting.map((message) => (
              <li key={message.id} className="web-waiting flex items-start gap-2 bg-raised px-3.5 py-2.5 ring-1 ring-hairline">
                <p className="min-w-0 flex-1 text-ui whitespace-pre-wrap">{message.displayText ?? message.text}</p>
                <span className="shrink-0 pt-0.5 text-label text-faint">Waiting</span>
                <button type="button" aria-label="Take this message back" onClick={() => remove(message.id)} className="web-icon-button -my-1.5 -mr-2 size-8">
                  <XIcon className="size-4" />
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      <div className="web-dock shrink-0">
        <Composer attach={false} placeholder={`Message for when ${session.where} is back`} onSend={send} draftKey={threadDraftKey(client.account.id, session.row.conversation)} />
      </div>
    </div>
  )
}

export function ArchivedThread({ thread }: { thread: WebThread }) {
  return (
    <div className="mx-auto flex max-w-[420px] flex-col items-center px-6 pt-16 text-center">
      <span className="flex size-11 items-center justify-center bg-raised ring-1 ring-hairline">
        <ArchiveIcon className="size-5 text-muted-foreground" />
      </span>
      <p className="mt-4 text-title font-medium">Archived</p>
      <p className="mt-1.5 text-ui text-muted-foreground">Its history is kept. Restore it from the Mac it came from, with what its agent wrote in the cloud.</p>
      {thread.archived ? <p className="mt-3 text-label text-faint">Archived {copyAge(Date.parse(thread.archived.archivedAt))}</p> : null}
    </div>
  )
}

