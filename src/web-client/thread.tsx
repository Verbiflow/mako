import { lazy, Suspense, useEffect, useRef, useState } from "react"
import { ArchiveIcon, ChevronLeftIcon, CloudIcon, CloudUploadIcon, EllipsisIcon, GlobeIcon, LaptopIcon, MoonIcon, PlusIcon, XIcon } from "lucide-react"
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/menu"
import { Spinner } from "@/components/ui/spinner"
import { toast } from "sonner"
import { WebHarnessIcon } from "./harness-icon"
import { copyAge } from "@/lib/format"
import { ACTION_TOAST_MS } from "@/lib/toast-duration"
import { cn } from "@/lib/utils"
import { useAccountList } from "./account-list"
import { useWebClient } from "./client"
import { Composer } from "./composer"
import { webHarnessLabel } from "./labels"
import { StartSheet, type AddingTo } from "./new-thread"
import { PreviewSheet } from "./preview"
import { moveToCloud, type Owner } from "./start"
import { CLOUD_WHERE, openingSession, type WebSession, type WebThread } from "./threads"
import { startingWhere } from "./started"
import { useThread } from "./use-thread"

/** The renderer's live conversation: its transcript, approvals and questions, the desktop's own code. Its own chunk. */
const LiveSession = lazy(() => import("./live-session"))

export function ThreadScreen({ threadId, sessionId, onBack, onSession, wide }: { threadId: string; sessionId?: string; onBack: () => void; onSession: (session: string) => void; wide: boolean }) {
  const thread = useThread(threadId)
  const phase = useAccountList((state) => state.phase)
  const heading = useRef<HTMLHeadingElement>(null)
  const [adding, setAdding] = useState(false)
  const [previewing, setPreviewing] = useState(false)
  useEffect(() => heading.current?.focus({ preventScroll: true }), [threadId])
  const client = useWebClient()
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
  const session = thread.sessions.find((each) => each.row.session === sessionId) ?? openingSession(thread)
  const owner = ownerOf(session)
  const addingTo: AddingTo | undefined = session.row.folder && !thread.archived && !session.quietSince ? { thread: thread.id, folder: session.row.folder, owner, where: session.where === CLOUD_WHERE ? "Cloud" : session.where } : undefined
  return (
    <div className="flex min-h-0 flex-1 flex-col bg-surface" data-thread-screen={thread.id}>
      <ThreadBar
        onBack={wide ? undefined : onBack}
        title={thread.title}
        subtitle={subtitle(thread, session)}
        place={session.row.runsOn.kind === "cloud" ? "cloud" : "device"}
        headingRef={heading}
        actions={thread.archived ? undefined : <ThreadActions thread={thread} session={session} onArchived={onBack} onPreview={() => setPreviewing(true)} onAdd={addingTo && thread.sessions.length === 1 ? () => setAdding(true) : undefined} />}
      />
      {thread.sessions.length > 1 ? <SessionTabs thread={thread} current={session} onSession={onSession} onAdd={addingTo ? () => setAdding(true) : undefined} /> : null}
      {thread.archived ? (
        <ArchivedThread thread={thread} />
      ) : session.quietSince ? (
        <QuietSession key={session.row.session} session={session} />
      ) : (
        <Suspense fallback={<TranscriptLoading />}>
          <LiveSession key={session.row.conversation} session={session} />
        </Suspense>
      )}
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
      <PreviewSheet open={previewing} onDismiss={() => setPreviewing(false)} owner={owner} folder={session.row.folder} title={thread.title} />
    </div>
  )
}

/** Who answers a Session's calls: its Mac, or its cloud Thread's machine. */
function ownerOf(session: WebSession): Owner {
  return session.owner.kind === "cloud" ? { kind: "cloud", threadId: session.owner.threadId } : { kind: "mac", deviceId: session.owner.deviceId }
}

/** The header's one line: the Mac's name, when it isn't the cloud, and the project. Where it runs is the glyph before it. */
function subtitle(thread: WebThread, session: WebSession): string {
  return [session.where === CLOUD_WHERE ? undefined : session.where, thread.project].filter(Boolean).join(" · ") || (session.where === CLOUD_WHERE ? "Cloud" : session.where)
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
 * What a Thread can be asked from a phone: its app opened, moved from its Mac to the cloud, archived. A cloud Thread's
 * archive is the cloud's own; another device's Sessions are archived, and moved, by asking that device. Each can be
 * refused, in the owner's words.
 */
function ThreadActions({ thread, session, onArchived, onPreview, onAdd }: { thread: WebThread; session: WebSession; onArchived: () => void; onPreview: () => void; onAdd: (() => void) | undefined }) {
  const client = useWebClient()
  const [busy, setBusy] = useState<string | undefined>(undefined)
  const cloud = thread.sessions.find((each) => each.row.runsOn.kind === "cloud")?.row.runsOn
  const onMac = session.owner.kind === "device" && !session.quietSince ? session.owner : undefined
  const archive = async (anyway = false) => {
    setBusy("Archiving…")
    try {
      if (cloud?.kind === "cloud") {
        const { archiveCloudThread } = await import("./archive")
        const words = { packing: "Saving its work…", ending: "Ending its machine…" } as const
        const outcome = await archiveCloudThread(client.gateway, client.deviceId, cloud.threadId, client.list.rows(), { anyway, step: (kind) => kind !== "bringing" && setBusy(words[kind]) })
        if (outcome.kind === "refused") {
          if (outcome.anyway) toast.error("Not archived", { description: outcome.reason, action: { label: "Archive anyway", onClick: () => void archive(true) }, duration: ACTION_TOAST_MS })
          else toast.error("Not archived", { description: outcome.reason })
          return
        }
      } else {
        const conversations = await client.conversations()
        for (const each of thread.sessions) await conversations.archiveOnOwner(each.row.conversation)
      }
      toast.success("Archived", { description: thread.title })
      onArchived()
    } catch (error) {
      toast.error("Not archived", { description: error instanceof Error ? error.message : String(error) })
    } finally {
      setBusy(undefined)
    }
  }
  const move = async () => {
    if (!onMac) return
    setBusy("Moving to the cloud…")
    try {
      const outcome = await moveToCloud(client.gateway, client.deviceId, onMac.deviceId, session.row.conversation)
      if (outcome.kind === "moved" || outcome.kind === "released") toast.success("Moved to the cloud", { description: thread.title })
      else toast.error("Not moved", { description: outcome.reason })
    } catch (error) {
      toast.error("Not moved", { description: error instanceof Error ? error.message : String(error) })
    } finally {
      setBusy(undefined)
    }
  }
  if (busy)
    return (
      <span role="status" className="flex shrink-0 items-center gap-1.5 pr-3 text-label text-muted-foreground">
        <Spinner aria-hidden className="size-3.5" />
        {busy}
      </span>
    )
  return (
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
        {session.row.folder && !session.quietSince ? (
          <MenuItem onSelect={onPreview} className="min-h-11 gap-2.5 px-3 text-ui">
            <GlobeIcon className="size-4 text-muted-foreground" />
            Open app
          </MenuItem>
        ) : null}
        {onMac && cloudOn(client.account.entitlements) ? (
          <MenuItem onSelect={() => void move()} className="min-h-11 gap-2.5 px-3 text-ui">
            <CloudUploadIcon className="size-4 text-muted-foreground" />
            Move to the cloud
          </MenuItem>
        ) : null}
        <MenuItem onSelect={() => void archive()} className="min-h-11 gap-2.5 px-3 text-ui">
          <ArchiveIcon className="size-4 text-muted-foreground" />
          Archive
        </MenuItem>
      </MenuContent>
    </Menu>
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
 * A Session whose Mac is off: nothing runs it and nothing answers for it. A message sent here waits in the account and
 * runs once the Mac is back.
 */
function QuietSession({ session }: { session: WebSession }) {
  const client = useWebClient()
  const send = async (text: string): Promise<boolean> => {
    try {
      await client.gateway.rest("PUT", `/v1/sessions/${encodeURIComponent(session.row.session)}/waiting/${crypto.randomUUID()}`, { conversation: session.row.conversation, text })
      return true
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
      return false
    }
  }
  const remove = (id: string) => void client.gateway.rest("DELETE", `/v1/sessions/${encodeURIComponent(session.row.session)}/waiting/${encodeURIComponent(id)}`).catch((error) => toast.error(error instanceof Error ? error.message : String(error)))
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="web-scroll min-h-0 flex-1 overflow-y-auto px-5 pt-10">
        <div className="mx-auto flex max-w-[420px] flex-col items-center text-center">
          <span className="flex size-11 items-center justify-center rounded-2xl bg-raised ring-1 ring-hairline">
            <MoonIcon className="size-5 text-muted-foreground" />
          </span>
          <p className="mt-4 text-title font-medium">{session.where} is off</p>
          <p className="mt-1.5 text-ui text-muted-foreground">
            {session.quietSince ? `Seen ${copyAge(Date.parse(session.quietSince))}. ` : ""}A message sent now runs when it's back.
          </p>
        </div>
        {session.waiting.length ? (
          <ul role="list" className="mx-auto mt-8 flex max-w-[560px] flex-col gap-2">
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
        <Composer attach={false} placeholder={`Message for when ${session.where} is back`} onSend={send} />
      </div>
    </div>
  )
}

function ArchivedThread({ thread }: { thread: WebThread }) {
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

function TranscriptLoading() {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 px-5 pt-8" aria-busy aria-label="Opening the conversation">
      <span className="skeleton ml-auto h-12 w-3/5 rounded-2xl" />
      <span className="skeleton h-3.5 w-4/5 rounded" />
      <span className="skeleton h-3.5 w-2/3 rounded" />
      <span className="skeleton h-3.5 w-3/4 rounded" />
    </div>
  )
}
