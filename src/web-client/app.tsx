import { lazy, Suspense, useEffect, useState, useSyncExternalStore } from "react"
import { z } from "zod"
import { SquarePenIcon } from "lucide-react"
import { MakoMark } from "@/components/ui/mako-mark"
import { useAccountList } from "./account-list"
import { useWebClient } from "./client"
import { useKeyboardInset } from "./keyboard"
import { ThreadList } from "./list"
import { routeHref, useRoute, useWide, type ScreenRoute } from "./route"
import { ScreenStack } from "./screens"
import { startedFromHere } from "./started"
import type { Started } from "./start"

/** What the service worker says when a notice is tapped: the app's address to go to. */
const OpenNoticeSchema = z.object({ type: z.literal("mako:open"), url: z.string().min(1) })

/**
 * A chunk of the app the list paints without, read once: its module as soon as it has arrived, and until then nothing.
 * Read without suspending, so a screen whose code is already here draws in the frame it's asked for (a Suspense
 * boundary would hold its reveal back for a beat).
 */
function chunk<Module>(load: () => Promise<Module>) {
  let module: Module | undefined
  let reading: Promise<Module> | undefined
  const listeners = new Set<() => void>()
  const read = (): Promise<Module> => {
    reading ??= load().then((loaded) => {
      module = loaded
      for (const listener of listeners) listener()
      return loaded
    })
    // Not here (offline before the service worker kept it): asked again next time.
    reading.catch(() => {
      reading = undefined
    })
    return reading
  }
  const subscribe = (listener: () => void) => {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }
  return { read, use: () => useSyncExternalStore(subscribe, () => module) }
}

/**
 * What the list paints without, each a chunk of its own: a Thread (its screen, then its transcript, the desk's live
 * state and its conversations), New, Settings and the toasts. A Thread's and New's are read as soon as the list has
 * painted (`afterFirstPaint`), so they're there by the time one is tapped, and at once when the app opens on one.
 */
const threadChunk = chunk(() => import("./thread"))
const transcriptChunk = chunk(() => import("./live-session"))
const conversationsChunk = chunk(() => import("./conversations"))
const startChunk = chunk(() => import("./new-thread"))
const Toaster = lazy(() => import("@/components/ui/sonner").then((module) => ({ default: module.Toaster })))
const Settings = lazy(() => import("./settings").then((module) => ({ default: module.Settings })))

/** A Thread's code first, the screen most often opened next, then New's: one after the other, each has the line to itself. */
async function readNextScreens(): Promise<void> {
  await Promise.allSettled([threadChunk.read(), transcriptChunk.read(), conversationsChunk.read()])
  await startChunk.read().catch(() => undefined)
}

/** Runs `then` in a task of its own once the list's first frame is on screen: work the first paint shouldn't wait on. */
function afterFirstPaint(then: () => void): () => void {
  let task: number | undefined
  const frame = requestAnimationFrame(() => {
    task = window.setTimeout(then, 0)
  })
  return () => {
    cancelAnimationFrame(frame)
    clearTimeout(task)
  }
}

/**
 * The web app: the account's Threads, one open, a new one, and Settings. On a phone the list stays under and what's
 * open slides over it (Back is the edge swipe, or the system's); a new Thread is a sheet over whatever is open. Wide,
 * it's the desk's two panes: the list as a rail on the shell, and what's open beside it, a new Thread included, which
 * opens in the pane as the desk's new tab does.
 */
export function WebApp() {
  const client = useWebClient()
  const [route, navigate, back] = useRoute(client.options.base)
  const wide = useWide()
  useKeyboardInset()
  const signedOut = useAccountList((state) => state.phase === "signed-out")
  // The list paints first: what it doesn't need is read after (the page's own work too, such as its service worker).
  const painted = useAccountList((state) => state.phase !== "starting" && state.phase !== "signed-out")
  const [settled, setSettled] = useState(false)
  // Opened again, the app's files are on this device (its service worker keeps them): a Thread's are read at once, as
  // the list paints from the list kept here. The first time, they wait for the list, which has the network to itself.
  useEffect(() => {
    if (navigator.serviceWorker?.controller) void readNextScreens()
  }, [])
  useEffect(() => {
    if (!painted || settled) return
    return afterFirstPaint(() => {
      setSettled(true)
      // Then the page's own work, so a service worker keeping these files finds them already fetched.
      void readNextScreens()
        .catch(() => undefined)
        .then(() => client.options.painted?.())
    })
  }, [painted, settled, client])
  // New's sheet is mounted from its first opening on, so it leaves on its own path when closed. Wide, New is a pane.
  const [startOpened, setStartOpened] = useState(false)
  if (route.kind === "new" && !startOpened) setStartOpened(true)
  const startPane = wide && route.kind === "new"
  // A screen asked for before its code arrived (opened from an address, or tapped at once) reads it now.
  const threadCode = threadChunk.use()
  const startCode = startChunk.use()
  const wantsThread = route.kind === "thread" || (route.kind === "new" && route.over?.kind === "thread")
  useEffect(() => {
    if (!wantsThread || threadCode) return
    void transcriptChunk.read().catch(() => undefined)
    void threadChunk.read().catch(() => undefined)
  }, [wantsThread, threadCode])
  useEffect(() => {
    if (startOpened && !startCode) void startChunk.read().catch(() => undefined)
  }, [startOpened, startCode])
  useEffect(() => {
    if (signedOut) location.assign(client.options.signInUrl(location.pathname + location.search))
  }, [signedOut, client])
  // A tapped notice, with the app already open: the service worker says where to go.
  useEffect(() => {
    const worker = navigator.serviceWorker
    if (!worker) return
    const heard = (event: MessageEvent) => {
      const notice = OpenNoticeSchema.safeParse(event.data).data
      if (!notice) return
      history.pushState(null, "", notice.url)
      dispatchEvent(new PopStateEvent("popstate"))
    }
    worker.addEventListener("message", heard)
    return () => worker.removeEventListener("message", heard)
  }, [])
  // A new Thread is a sheet over what's open, with an address of its own, so Back closes it.
  const under: ScreenRoute = route.kind === "new" ? (route.over ?? { kind: "list" }) : route
  const open = (next: ScreenRoute) => navigate(next, { replace: wide && under.kind !== "list" })
  const onStarted = (started: Started, where: string) => {
    startedFromHere(started.threadId, where)
    navigate({ kind: "thread", thread: started.threadId }, { replace: true })
  }
  const list = (
    <ThreadList
      wide={wide}
      starting={startPane}
      settings={under.kind === "settings" && !startPane}
      selected={under.kind === "thread" && !startPane ? under.thread : undefined}
      onOpen={(thread) => open({ kind: "thread", thread: thread.id })}
      onNew={() => navigate({ kind: "new", over: under })}
      onSettings={() => open({ kind: "settings" })}
    />
  )
  const detail = startPane ? (
    startCode ? (
      <startCode.StartPane onDismiss={back} onStarted={onStarted} />
    ) : (
      <div className="flex-1 bg-surface" />
    )
  ) : under.kind === "thread" ? (
      threadCode ? (
        <threadCode.ThreadScreen
          key={under.thread}
          threadId={under.thread}
          sessionId={under.session}
          wide={wide}
          onBack={back}
          onSession={(session) => navigate({ kind: "thread", thread: under.thread, session }, { replace: true })}
        />
      ) : (
        <div data-thread-loading className="flex-1 bg-surface" />
      )
    ) : under.kind === "settings" ? (
      <Suspense fallback={null}>
        <Settings onBack={wide ? undefined : back} />
      </Suspense>
    ) : null
  const sheet = startOpened && startCode && !wide ? <startCode.StartSheet open={route.kind === "new"} onDismiss={back} onStarted={onStarted} /> : null
  return (
    <div className="web-app flex w-full overflow-hidden bg-shell text-foreground">
      {wide ? (
        <>
          <div className="web-rail flex shrink-0 flex-col border-r border-hairline">{list}</div>
          <main className="flex min-w-0 flex-1 flex-col">{detail ?? <NothingOpen onNew={() => navigate({ kind: "new", over: under })} />}</main>
        </>
      ) : (
        <main className="flex min-w-0 flex-1 flex-col">
          <ScreenStack under={list} top={detail} topKey={detail ? routeHref(under, client.options.base).split("?")[0] : undefined} onBack={back} />
        </main>
      )}
      {sheet}
      {settled ? (
        <Suspense fallback={null}>
          <Toaster position="top-center" offset={{ top: "calc(env(safe-area-inset-top) + 8px)" }} />
        </Suspense>
      ) : null}
    </div>
  )
}

/** The pane with nothing open: the fin, and the one thing to do from here besides picking a Thread. */
function NothingOpen({ onNew }: { onNew: () => void }) {
  return (
    <div className="web-enter flex flex-1 flex-col items-center justify-center gap-5 bg-surface text-center">
      <MakoMark className="size-9 opacity-35" />
      <button type="button" onClick={onNew} className="web-quiet-button gap-2 text-foreground">
        <SquarePenIcon className="size-4 text-muted-foreground" />
        New thread
      </button>
    </div>
  )
}
