import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react"
import { ArchiveIcon, ArrowDownIcon, ArrowUpIcon, ChevronLeftIcon, CloudIcon, EllipsisIcon, GlobeIcon, LaptopIcon, PlusIcon, XIcon } from "lucide-react"
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/menu"
import { Spinner } from "@/components/ui/spinner"
import { toast } from "sonner"
import type { PromptAttachment } from "@mako/host/contracts/providers-acp"
import { MoveDividersContext } from "@/components/transcript/transcript-notes"
import { WebHarnessIcon } from "./harness-icon"
import { copyAge } from "@/lib/format"
import { ACTION_TOAST_MS } from "@/lib/toast-duration"
import { cn } from "@/lib/utils"
import { useAccountList } from "./account-list"
import { useWebClient } from "./client"
import { Composer } from "./composer"
import { threadDraftKey } from "./drafts"
import { webHarnessLabel } from "./labels"
import { MoveCard, MoveSheet } from "./move-card"
import { startMove, type MoveMac } from "./move-actions"
import type { MoveWay } from "./move-progress"
import { listedMove, useMoves, type WebMove } from "./moves"
import { StartSheet, type AddingTo } from "./new-thread"
import { PreviewSheet, ServerCard } from "./preview"
import { appKey, askPreview, loopbackTarget, useApps, useThreadApp } from "./previews"
import { CLOUD_WHERE, openingSession, ownerOf, subtitle, type WebSession, type WebThread } from "./threads"
import { startingWhere } from "./started"
import { useThread } from "./use-thread"
import { archiveThread } from "./archive-thread"
import { useSyncing } from "./syncing"
import { useDelayedStatus } from "./delayed-status"
import { useBranchOpening } from "./replies"
import { checkReach, useSessionDiagnosis } from "./thread-trouble"
import { DiagnosisCard } from "./trouble"
import { useTryAgain } from "./trouble-state"

/** The renderer's live conversation: its transcript, approvals and questions, the desktop's own code. Its own chunk. */
const LiveSession = lazy(() => import("./live-session"))

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
  return (
    <div className="flex min-h-0 flex-1 flex-col bg-surface" data-thread-screen={thread.id}>
      <ThreadBar
        onBack={wide ? undefined : onBack}
        title={thread.title}
        subtitle={syncing ?? subtitle(thread, session)}
        place={session.row.runsOn.kind === "cloud" ? "cloud" : "device"}
        headingRef={heading}
        actions={thread.archived ? undefined : <ThreadActions thread={thread} session={session} onArchived={onBack} onAdd={addingTo && thread.sessions.length === 1 ? () => setAdding(true) : undefined} />}
      />
      {thread.sessions.length > 1 ? <SessionTabs thread={thread} current={session} onSession={onSession} onAdd={addingTo ? () => setAdding(true) : undefined} /> : null}
      <ThreadBody thread={thread} session={session} />
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

/** The Mac a Session runs on, or that a cloud Thread came from as far as this phone can tell: named, by its device. */
function macOf(session: WebSession, devices: ReadonlyMap<string, { kind: string; name: string }>): MoveMac | undefined {
  if (session.owner.kind === "device") return { deviceId: session.owner.deviceId, name: session.where }
  const macs = [...devices.entries()].filter(([, device]) => device.kind === "desktop")
  return macs.length === 1 ? { deviceId: macs[0]![0], name: macs[0]![1].name } : undefined
}

/**
 * What a Thread shows under its bar, on a phone, a tablet and a laptop's browser alike: archived, a move in its place
 * while one goes, its Mac asleep or offline (with why, and what still works), or the Session live. Above a live one,
 * what can't be reached, when something can't, and the servers its app runs; links in it to the app's own address open
 * the app here.
 */
export function ThreadBody({ thread, session, desk = false }: { thread: WebThread; session: WebSession; desk?: boolean }) {
  const client = useWebClient()
  const devices = useAccountList((state) => state.devices)
  const followed = useMoves((state) => state.moves.get(thread.id))
  const listed = followed ? undefined : listedMove(thread)
  const mac = macOf(session, devices)
  const move: (Pick<WebMove, "way" | "step" | "stepAt" | "handOff" | "mac" | "ours"> & Partial<WebMove>) | undefined =
    followed ?? (listed && mac ? { ...listed, handOff: session.row.state === "working", mac, ours: false } : undefined)
  const owner = ownerOf(session)
  const live = !thread.archived && !session.quietSince && !move
  useThreadApp(client, session.row.conversation, owner, session.row.folder, live)
  // While a move shows in its place, its owner is followed for the move's steps, as an open Session's would be.
  const watching = move !== undefined && !move.end && move.way === "cloud" && session.owner.kind === "device"
  useEffect(() => {
    if (!watching) return
    let stop: (() => void) | undefined
    let left = false
    void client.conversations().then((conversations) => {
      if (!left) stop = conversations.followSteps(session)
    })
    return () => {
      left = true
      stop?.()
    }
    // Followed once per conversation while the card shows; the row it was named by changes as the list does.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, watching, session.row.conversation])
  const retry = followed?.end?.kind === "failed" && mac
    ? () => void startMove(client, { thread, conversation: session.row.conversation, way: followed.way, mac: followed.mac, handOff: session.row.state === "working" })
    : undefined
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
      ) : move ? (
        <MoveCard key={move.move ?? "listed"} thread={thread} move={move} onRetry={retry} />
      ) : session.quietSince ? (
        <QuietSession key={session.row.session} session={session} />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col" onClickCapture={openLinks}>
          <ThreadTrouble session={session} />
          <ServerCards session={session} />
          <MoveDividersContext value>
            <Suspense fallback={<TranscriptLoading />}>
              <LiveSession key={session.row.conversation} session={session} desk={desk} />
            </Suspense>
          </MoveDividersContext>
        </div>
      )}
      <PreviewSheet conversation={session.row.conversation} owner={owner} folder={session.row.folder} title={thread.title} />
    </>
  )
}

/** What can't be reached for a live Session, in a strip above its transcript: the headline, Details a tap away. */
function ThreadTrouble({ session }: { session: WebSession }) {
  const client = useWebClient()
  const diagnosis = useSessionDiagnosis(session)
  const mac = session.owner.kind === "device" ? session.owner.deviceId : undefined
  const { checking, tryAgain } = useTryAgain(() => checkReach(client, mac))
  // Said once it has lasted a moment: a reconnect that's over at once never shows.
  const shown = useDelayedStatus(diagnosis ? diagnosis.headline : null, session.row.conversation)
  if (!diagnosis || !shown) return null
  return <DiagnosisCard diagnosis={diagnosis} checking={checking} onTryAgain={tryAgain} compact className="web-trouble-strip" />
}

/** The servers a live Session's app runs, a card each, while it runs: tap one to open it here. */
function ServerCards({ session }: { session: WebSession }) {
  const folder = session.row.folder
  const key = folder ? appKey(ownerOf(session), folder) : undefined
  const servers = useApps((state) => (key ? state.apps.get(key)?.servers : undefined))
  const up = servers?.filter((server) => server.state !== "stopped") ?? []
  if (!up.length) return null
  return (
    <div className="web-servers web-scroll" aria-label="Its app">
      {up.map((server) => (
        <ServerCard key={server.port} server={server} compact onOpen={() => askPreview(session.row.conversation, { port: server.port })} />
      ))}
    </div>
  )
}

function ThreadBar({ onBack, title, subtitle, place, headingRef, actions }: { onBack: (() => void) | undefined; title: string; subtitle: string | undefined; place?: "cloud" | "device"; headingRef: React.Ref<HTMLHeadingElement>; actions?: React.ReactNode }) {
  const Place = place === "cloud" ? CloudIcon : LaptopIcon
  return (
    <header className="web-bar web-bar-thread flex shrink-0 items-center gap-1 px-1.5">
      {onBack ? (
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
            {place ? <Place aria-hidden className="size-3 shrink-0" /> : null}
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
export function ThreadActions({ thread, session, onArchived, onAdd }: { thread: WebThread; session: WebSession; onArchived: () => void; onAdd: (() => void) | undefined }) {
  const client = useWebClient()
  const devices = useAccountList((state) => state.devices)
  const moving = useMoves((state) => state.moves.has(thread.id)) || listedMove(thread) !== undefined
  const [busy, setBusy] = useState<string | undefined>(undefined)
  const [asking, setAsking] = useState<MoveWay | undefined>(undefined)
  const onMac = session.owner.kind === "device" && !session.quietSince ? session.owner : undefined
  const inCloud = session.owner.kind === "cloud"
  const hasMac = [...devices.values()].some((device) => device.kind === "desktop")
  const archive = async (anyway = false) => {
    setBusy("Archiving…")
    try {
      const outcome = await archiveThread(client, thread, { anyway, step: setBusy })
      if (outcome.kind === "refused") {
        if (outcome.anyway) toast.error("Not archived", { description: outcome.reason, action: { label: "Archive anyway", onClick: () => void archive(true) }, duration: ACTION_TOAST_MS })
        else toast.error("Not archived", { description: outcome.reason })
        return
      }
      toast.success("Archived", { description: thread.title })
      onArchived()
    } catch (error) {
      toast.error("Not archived", { description: error instanceof Error ? error.message : String(error) })
    } finally {
      setBusy(undefined)
    }
  }
  const move = (mac: MoveMac) => {
    const way = asking
    setAsking(undefined)
    if (way) void startMove(client, { thread, conversation: session.row.conversation, way, mac, handOff: session.row.state === "working" })
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
          <button type="button" aria-label="More for this Thread" className="web-icon-button">
            <EllipsisIcon className="size-5" />
          </button>
        </MenuTrigger>
        <MenuContent align="end" className="min-w-56">
          {onAdd ? (
            <MenuItem onSelect={onAdd} className="min-h-11 gap-2.5 px-3 text-ui">
              <PlusIcon className="size-4 text-muted-foreground" />
              Add a Session
            </MenuItem>
          ) : null}
          {session.row.folder && !session.quietSince && !moving ? (
            <MenuItem onSelect={() => askPreview(session.row.conversation)} className="min-h-11 gap-2.5 px-3 text-ui">
              <GlobeIcon className="size-4 text-muted-foreground" />
              Open app
            </MenuItem>
          ) : null}
          {onMac && cloudOn(client.account.entitlements) && !moving ? (
            <MenuItem onSelect={() => setAsking("cloud")} className="min-h-11 gap-2.5 px-3 text-ui">
              <ArrowUpIcon className="size-4 text-muted-foreground" />
              Move to the cloud
            </MenuItem>
          ) : null}
          {inCloud && hasMac && !moving ? (
            <MenuItem onSelect={() => setAsking("device")} className="min-h-11 gap-2.5 px-3 text-ui">
              <ArrowDownIcon className="size-4 text-muted-foreground" />
              Bring back to a Mac
            </MenuItem>
          ) : null}
          <MenuItem onSelect={() => void archive()} className="min-h-11 gap-2.5 px-3 text-ui">
            <ArchiveIcon className="size-4 text-muted-foreground" />
            Archive
          </MenuItem>
        </MenuContent>
      </Menu>
      <MoveSheet open={asking !== undefined} way={asking ?? "cloud"} working={session.row.state === "working"} from={onMac ? { deviceId: onMac.deviceId, name: session.where } : undefined} onDismiss={() => setAsking(undefined)} onMove={move} />
    </>
  )
}

function cloudOn(entitlements: readonly string[]): boolean {
  return entitlements.includes("cloud")
}

/** A Thread's Sessions, one tab each: Claude beside Codex, as a Mac's tabs show them; `+` adds one. */
function SessionTabs({ thread, current, onSession, onAdd }: { thread: WebThread; current: WebSession; onSession: (session: string) => void; onAdd: (() => void) | undefined }) {
  return (
    <div role="tablist" aria-label="Sessions in this Thread" className="web-scroll flex shrink-0 items-center gap-1.5 overflow-x-auto border-b border-hairline px-3 py-2">
      {thread.sessions.map((session) => {
        const selected = session.row.session === current.row.session
        return (
          <button
            key={session.row.session}
            type="button"
            role="tab"
            aria-selected={selected}
            onClick={() => onSession(session.row.session)}
            className={cn("web-tab", selected && "web-tab-on")}
          >
            <WebHarnessIcon harness={session.row.harness} className="size-3.5" />
            {webHarnessLabel(session.row.harness)}
            {session.row.state === "waiting" && !session.quietSince ? <span aria-label="waiting for you" className="size-1.5 rounded-full bg-caution" /> : null}
          </button>
        )
      })}
      {onAdd ? (
        <button type="button" aria-label="Add a Session" onClick={onAdd} className="web-tab web-tab-add">
          <PlusIcon className="size-4" />
        </button>
      ) : null}
    </div>
  )
}

/**
 * A Session whose Mac can't be reached: why, hop by hop (this phone, Mako Cloud, the Mac, its harness), with what it may
 * be, Try again and Copy diagnostics. Nothing runs it and nothing answers for it meanwhile; a message sent here waits in
 * the account and runs once the Mac is back.
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
              <li key={message.id} className="web-waiting flex items-start gap-2 rounded-xl bg-raised px-3.5 py-2.5 ring-1 ring-hairline">
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
      <span className="flex size-11 items-center justify-center rounded-2xl bg-raised ring-1 ring-hairline">
        <ArchiveIcon className="size-5 text-muted-foreground" />
      </span>
      <p className="mt-4 text-title font-medium">Archived</p>
      <p className="mt-1.5 text-ui text-muted-foreground">Its history is kept. Restore it from the Mac it came from, with what its agent wrote in the cloud.</p>
      {thread.archived ? <p className="mt-3 text-label text-faint">Archived {copyAge(Date.parse(thread.archived.archivedAt))}</p> : null}
    </div>
  )
}

export function TranscriptLoading() {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 px-5 pt-8" aria-busy aria-label="Opening the conversation">
      <span className="skeleton ml-auto h-12 w-3/5 rounded-2xl" />
      <span className="skeleton h-3.5 w-4/5 rounded" />
      <span className="skeleton h-3.5 w-2/3 rounded" />
      <span className="skeleton h-3.5 w-3/4 rounded" />
    </div>
  )
}
