import { lazy, Suspense, useEffect, useRef, useState } from "react"
import { ArchiveIcon, ChevronLeftIcon, CloudIcon, EllipsisIcon, LaptopIcon, MoonIcon, XIcon } from "lucide-react"
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/menu"
import { Spinner } from "@/components/ui/spinner"
import { toast } from "sonner"
import { WebHarnessIcon } from "./harness-icon"
import { copyAge } from "@/lib/format"
import { ACTION_TOAST_MS } from "@/lib/toast-duration"
import { cn } from "@/lib/utils"
import { useAccountList } from "./account-list"
import { useWebClient } from "./client"
import { webHarnessLabel } from "./labels"
import { CLOUD_WHERE, openingSession, type WebSession, type WebThread } from "./threads"
import { useThread } from "./use-thread"
import { SendGlyph } from "./glyphs"

/** The renderer's live conversation: its transcript, approvals and questions, the desktop's own code. Its own chunk. */
const LiveSession = lazy(() => import("./live-session"))

export function ThreadScreen({ threadId, sessionId, onBack, onSession, wide }: { threadId: string; sessionId?: string; onBack: () => void; onSession: (session: string) => void; wide: boolean }) {
  const thread = useThread(threadId)
  const phase = useAccountList((state) => state.phase)
  const heading = useRef<HTMLHeadingElement>(null)
  useEffect(() => heading.current?.focus({ preventScroll: true }), [threadId])
  if (!thread) {
    // A cloud Thread started from here is listed once its machine reports it, a moment after its harness starts.
    const starting = threadId.startsWith("t-")
    return (
      <div className="flex min-h-0 flex-1 flex-col bg-surface">
        <ThreadBar onBack={wide ? undefined : onBack} title={starting ? "Starting in the cloud…" : phase === "live" ? "Not in your list" : "Opening…"} subtitle={undefined} headingRef={heading} />
        {starting ? (
          <TranscriptLoading />
        ) : phase === "live" ? (
          <p className="mx-auto max-w-[340px] px-6 pt-20 text-center text-ui text-muted-foreground">This Thread isn't in your account's list any more. It may have been archived or closed on another device.</p>
        ) : null}
      </div>
    )
  }
  const session = thread.sessions.find((each) => each.row.session === sessionId) ?? openingSession(thread)
  return (
    <div className="flex min-h-0 flex-1 flex-col bg-surface" data-thread-screen={thread.id}>
      <ThreadBar
        onBack={wide ? undefined : onBack}
        title={thread.title}
        subtitle={subtitle(thread, session)}
        place={session.row.runsOn.kind === "cloud" ? "cloud" : "device"}
        headingRef={heading}
        actions={thread.archived ? undefined : <ThreadActions thread={thread} onArchived={onBack} />}
      />
      {thread.sessions.length > 1 ? <SessionTabs thread={thread} current={session} onSession={onSession} /> : null}
      {thread.archived ? (
        <ArchivedThread thread={thread} />
      ) : session.quietSince ? (
        <QuietSession key={session.row.session} session={session} />
      ) : (
        <Suspense fallback={<TranscriptLoading />}>
          <LiveSession key={session.row.conversation} session={session} />
        </Suspense>
      )}
    </div>
  )
}

function subtitle(thread: WebThread, session: WebSession): string {
  const place = session.where === CLOUD_WHERE ? "In the cloud" : `On ${session.where}`
  return [place, thread.project, webHarnessLabel(session.row.harness)].filter(Boolean).join(" · ")
}

function ThreadBar({ onBack, title, subtitle, place, headingRef, actions }: { onBack: (() => void) | undefined; title: string; subtitle: string | undefined; place?: "cloud" | "device"; headingRef: React.Ref<HTMLHeadingElement>; actions?: React.ReactNode }) {
  const Place = place === "cloud" ? CloudIcon : LaptopIcon
  return (
    <header className="web-bar flex shrink-0 items-center gap-1 border-b border-hairline bg-surface/90 px-2 backdrop-blur-xl">
      {onBack ? (
        <button type="button" aria-label="Back to threads" onClick={onBack} className="web-icon-button">
          <ChevronLeftIcon className="size-5" />
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
 * What a Thread can be asked from a phone: archived, as a Mac archives it. A cloud Thread's archive is the cloud's own
 * (its machine packs, then ends, and every device shows it archived); another device's Sessions are archived by asking
 * that device. Either can be refused, in words: a Thread at work is archived once its turn ends.
 */
function ThreadActions({ thread, onArchived }: { thread: WebThread; onArchived: () => void }) {
  const client = useWebClient()
  const [archiving, setArchiving] = useState<string | undefined>(undefined)
  const cloud = thread.sessions.find((each) => each.row.runsOn.kind === "cloud")?.row.runsOn
  const archive = async (anyway = false) => {
    setArchiving("Archiving…")
    try {
      if (cloud?.kind === "cloud") {
        const { archiveCloudThread } = await import("./archive")
        const words = { packing: "Saving its work…", ending: "Ending its machine…" } as const
        const outcome = await archiveCloudThread(client.gateway, client.deviceId, cloud.threadId, client.list.rows(), { anyway, step: (kind) => kind !== "bringing" && setArchiving(words[kind]) })
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
      setArchiving(undefined)
    }
  }
  if (archiving)
    return (
      <span role="status" className="flex shrink-0 items-center gap-1.5 pr-3 text-label text-muted-foreground">
        <Spinner aria-hidden className="size-3.5" />
        {archiving}
      </span>
    )
  return (
    <Menu>
      <MenuTrigger asChild>
        <button type="button" aria-label="More for this Thread" className="web-icon-button">
          <EllipsisIcon className="size-5" />
        </button>
      </MenuTrigger>
      <MenuContent align="end" className="min-w-52">
        <MenuItem onSelect={() => void archive()} className="min-h-11 gap-2.5 px-3 text-ui">
          <ArchiveIcon className="size-4 text-muted-foreground" />
          Archive
        </MenuItem>
      </MenuContent>
    </Menu>
  )
}

/** A Thread's Sessions, one tab each, when it has more than one: Claude beside Codex, as a Mac's tabs show them. */
function SessionTabs({ thread, current, onSession }: { thread: WebThread; current: WebSession; onSession: (session: string) => void }) {
  return (
    <div role="tablist" aria-label="Sessions in this Thread" className="web-scroll flex shrink-0 gap-1.5 overflow-x-auto border-b border-hairline px-3 py-2">
      {thread.sessions.map((session) => {
        const selected = session.row.session === current.row.session
        return (
          <button
            key={session.row.session}
            type="button"
            role="tab"
            aria-selected={selected}
            onClick={() => onSession(session.row.session)}
            className={cn("pressable flex h-8 shrink-0 items-center gap-1.5 rounded-full px-3 text-label font-medium ring-1", selected ? "bg-fill-selected text-foreground ring-border" : "text-muted-foreground ring-hairline")}
          >
            <WebHarnessIcon harness={session.row.harness} className="size-3.5" />
            {session.row.title ?? webHarnessLabel(session.row.harness)}
            {session.row.state === "waiting" && !session.quietSince ? <span aria-label="waiting for you" className="size-1.5 rounded-full bg-caution" /> : null}
          </button>
        )
      })}
    </div>
  )
}

/**
 * A Session whose Mac is off: nothing runs it and nothing answers for it. Its history reads on the account's Macs from
 * the copy its Mac keeps; a message sent here waits in the account and runs once the Mac is back.
 */
function QuietSession({ session }: { session: WebSession }) {
  const client = useWebClient()
  const [text, setText] = useState("")
  const [sending, setSending] = useState(false)
  const send = async () => {
    const message = text.trim()
    if (!message) return
    setSending(true)
    try {
      await client.gateway.rest("PUT", `/v1/sessions/${session.row.session}/waiting/${crypto.randomUUID()}`, { conversation: session.row.conversation, text: message })
      setText("")
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      setSending(false)
    }
  }
  const remove = (id: string) => void client.gateway.rest("DELETE", `/v1/sessions/${session.row.session}/waiting/${id}`).catch((error) => toast.error(error instanceof Error ? error.message : String(error)))
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="web-scroll min-h-0 flex-1 overflow-y-auto px-5 pt-10">
        <div className="mx-auto flex max-w-[420px] flex-col items-center text-center">
          <span className="flex size-11 items-center justify-center rounded-2xl bg-raised ring-1 ring-hairline">
            <MoonIcon className="size-5 text-muted-foreground" />
          </span>
          <p className="mt-4 text-title font-medium">{session.where} is off</p>
          <p className="mt-1.5 text-ui text-muted-foreground">
            {session.quietSince ? `Last seen ${copyAge(Date.parse(session.quietSince))}. ` : ""}Nothing runs this Thread while it's off. A message you send waits in your account and runs when {session.where} is back.
          </p>
        </div>
        {session.waiting.length ? (
          <ul role="list" className="mx-auto mt-8 flex max-w-[560px] flex-col gap-2">
            {session.waiting.map((message) => (
              <li key={message.id} className="flex items-start gap-2 rounded-xl bg-raised px-3.5 py-2.5 ring-1 ring-hairline">
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
      <form
        className="web-composer"
        onSubmit={(event) => {
          event.preventDefault()
          void send()
        }}
      >
        <textarea value={text} onChange={(event) => setText(event.target.value)} rows={1} placeholder={`Message for when ${session.where} is back`} aria-label="Message" className="web-composer-input" />
        <button type="submit" disabled={!text.trim() || sending} className="web-send" aria-label="Send">
          <SendGlyph />
        </button>
      </form>
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
      <p className="mt-1.5 text-ui text-muted-foreground">
        Its machine is gone and its history is kept. Restore it from the Mac it came from: it comes back there, with what its agent wrote in the cloud.
      </p>
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
