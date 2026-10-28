import { lazy, Suspense, useEffect } from "react"
import { z } from "zod"
import { Toaster } from "@/components/ui/sonner"
import { MakoMark } from "@/components/ui/mako-mark"
import { useAccountList } from "./account-list"
import { useWebClient } from "./client"
import { ThreadList } from "./list"
import { useRoute, useWide, type WebRoute } from "./route"
import { ThreadScreen } from "./thread"

/** What the service worker says when a notice is tapped: the app's address to go to. */
const OpenNoticeSchema = z.object({ type: z.literal("mako:open"), url: z.string().min(1) })

/** Each its own chunk, read when first opened: the list paints without them. */
const NewThread = lazy(() => import("./new-thread").then((module) => ({ default: module.NewThread })))
const Settings = lazy(() => import("./settings").then((module) => ({ default: module.Settings })))

/**
 * The web app: the account's Threads, one open, a new one, and Settings. On a phone each fills the screen and Back goes
 * back; on a tablet the list stays beside what's open.
 */
export function WebApp() {
  const client = useWebClient()
  const [route, navigate] = useRoute(client.options.base)
  const wide = useWide()
  const signedOut = useAccountList((state) => state.phase === "signed-out")
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
  const back = () => (history.length > 1 ? history.back() : navigate({ kind: "list" }, { replace: true }))
  const open = (next: WebRoute) => navigate(next, { replace: wide && route.kind !== "list" })
  const list = (
    <ThreadList
      wide={wide}
      selected={route.kind === "thread" ? route.thread : undefined}
      onOpen={(thread) => open({ kind: "thread", thread: thread.id })}
      onNew={() => open({ kind: "new" })}
      onSettings={() => open({ kind: "settings" })}
    />
  )
  const detail =
    route.kind === "thread" ? (
      <ThreadScreen
        key={route.thread}
        threadId={route.thread}
        sessionId={route.session}
        wide={wide}
        onBack={back}
        onSession={(session) => navigate({ kind: "thread", thread: route.thread, session }, { replace: true })}
      />
    ) : route.kind === "new" ? (
      <NewThread onBack={back} onStarted={(started) => navigate({ kind: "thread", thread: started.threadId }, { replace: true })} />
    ) : route.kind === "settings" ? (
      <Settings onBack={back} />
    ) : null
  return (
    <div className="web-app flex h-dvh w-full overflow-hidden bg-shell text-foreground">
      {wide ? (
        <>
          <div className="flex w-[min(380px,40vw)] shrink-0 flex-col border-r border-hairline">{list}</div>
          <main className="flex min-w-0 flex-1 flex-col"><Suspense fallback={null}>{detail ?? <NothingOpen />}</Suspense></main>
        </>
      ) : (
        <main className="flex min-w-0 flex-1 flex-col"><Suspense fallback={null}>{detail ?? list}</Suspense></main>
      )}
      <Toaster position="top-center" offset={{ top: "calc(env(safe-area-inset-top) + 8px)" }} />
    </div>
  )
}

function NothingOpen() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 bg-surface text-center">
      <MakoMark className="size-8 opacity-50" />
      <p className="text-ui text-faint">Open a Thread to read it live.</p>
    </div>
  )
}
