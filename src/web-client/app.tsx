import { lazy, Suspense, useEffect } from "react"
import { z } from "zod"
import { Toaster } from "@/components/ui/sonner"
import { MakoMark } from "@/components/ui/mako-mark"
import { useAccountList } from "./account-list"
import { useWebClient } from "./client"
import { useKeyboardInset } from "./keyboard"
import { ThreadList } from "./list"
import { StartSheet } from "./new-thread"
import { routeHref, useRoute, useWide, type ScreenRoute } from "./route"
import { ScreenStack } from "./screens"
import { startedFromHere } from "./started"
import { ThreadScreen } from "./thread"

/** What the service worker says when a notice is tapped: the app's address to go to. */
const OpenNoticeSchema = z.object({ type: z.literal("mako:open"), url: z.string().min(1) })

/** Its own chunk, read when first opened: the list paints without it. */
const Settings = lazy(() => import("./settings").then((module) => ({ default: module.Settings })))

/**
 * The web app: the account's Threads, one open, a new one, and Settings. On a phone the list stays under and what's
 * open slides over it (Back is the edge swipe, or the system's); a new Thread is a sheet over whatever is open. On a
 * tablet the list stays beside what's open.
 */
export function WebApp() {
  const client = useWebClient()
  const [route, navigate, back] = useRoute(client.options.base)
  const wide = useWide()
  useKeyboardInset()
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
  // A new Thread is a sheet over what's open, with an address of its own, so Back closes it.
  const under: ScreenRoute = route.kind === "new" ? (route.over ?? { kind: "list" }) : route
  const open = (next: ScreenRoute) => navigate(next, { replace: wide && under.kind !== "list" })
  const list = (
    <ThreadList
      wide={wide}
      selected={under.kind === "thread" ? under.thread : undefined}
      onOpen={(thread) => open({ kind: "thread", thread: thread.id })}
      onNew={() => navigate({ kind: "new", over: under })}
      onSettings={() => open({ kind: "settings" })}
    />
  )
  const detail =
    under.kind === "thread" ? (
      <ThreadScreen
        key={under.thread}
        threadId={under.thread}
        sessionId={under.session}
        wide={wide}
        onBack={back}
        onSession={(session) => navigate({ kind: "thread", thread: under.thread, session }, { replace: true })}
      />
    ) : under.kind === "settings" ? (
      <Suspense fallback={null}>
        <Settings onBack={back} />
      </Suspense>
    ) : null
  const sheet = (
    <StartSheet
      open={route.kind === "new"}
      onDismiss={back}
      onStarted={(started, where) => {
        startedFromHere(started.threadId, where)
        navigate({ kind: "thread", thread: started.threadId }, { replace: true })
      }}
    />
  )
  return (
    <div className="web-app flex w-full overflow-hidden bg-shell text-foreground">
      {wide ? (
        <>
          <div className="flex w-[min(380px,40vw)] shrink-0 flex-col border-r border-hairline">{list}</div>
          <main className="flex min-w-0 flex-1 flex-col">{detail ?? <NothingOpen />}</main>
        </>
      ) : (
        <main className="flex min-w-0 flex-1 flex-col">
          <ScreenStack under={list} top={detail} topKey={detail ? routeHref(under, client.options.base).split("?")[0] : undefined} onBack={back} />
        </main>
      )}
      {sheet}
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
