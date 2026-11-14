import { Suspense, use, useEffect, useMemo, useState } from "react"
import { FileCode2Icon } from "lucide-react"
import type { MessageOrigin, OriginEntry } from "@/lib/types"
import { cn } from "@/lib/utils"
import { usePrefs } from "@/state/prefs"
import { canReadOriginals } from "@/state/thread-viewing"
import { LazyBoundary } from "@/components/ui/lazy-boundary"
import { CODE_PATIENCE_MS } from "@/lib/code-patience"
import { useTranscriptSource } from "./source-context"

/**
 * The dialog and its readers (the code highlighter among them): read the first time it opens, a debugging aid few turn
 * on. One read, the same promise on every render until Retry forgets it (`forgetDialog`), so `use` never meets a new
 * one. Past its patience it's still opening, not failed (`OpeningOriginal`); only a read that fails is.
 */
let dialogReading: Promise<typeof import("./show-original-dialog")> | undefined
function readDialog(): Promise<typeof import("./show-original-dialog")> {
  dialogReading ??= import("./show-original-dialog")
  return dialogReading
}
function forgetDialog(): void {
  dialogReading = undefined
}

/** The dialog once its code is here: suspends until then, and throws to its `LazyBoundary` if it can't arrive. */
function OriginalDialogLoader(props: { entries: readonly Recorded[]; onClose: () => void }) {
  const { OriginalDialog } = use(readDialog())
  return <OriginalDialog {...props} />
}

/** An entry with the bytes it names: the session whose record files those are, and the live conversation that holds it. */
export interface Recorded { path?: string; live?: string; entry: OriginEntry }

function recorded(origins: readonly (MessageOrigin | undefined)[], live: string | undefined): Recorded[] {
  return origins.flatMap((origin) => origin?.entries.flatMap((entry): Recorded[] => {
    const inLive = live !== undefined && entry.at !== undefined && Boolean(entry.record || entry.stream)
    // A record known only by the stream line it came in (a live record no decoder read, in Settings › Diagnostics) is read from the stream.
    const streamOnly = !inLive && !origin.path && entry.at === undefined && entry.stream !== undefined
    if (!inLive && !streamOnly && !(origin.path && entry.id && entry.record)) return []
    return [{ ...origin.path && { path: origin.path }, ...inLive && { live }, entry }]
  }) ?? [])
}

/**
 * "Opening the original…" while the viewer's code is on its way; past its patience "Still opening…" with Retry and
 * Reload, the download still under way, not failed. With the browser offline by then it says it couldn't open.
 */
function OpeningOriginal({ onRetry }: { onRetry: () => void }) {
  const [late, setLate] = useState<"slow" | "offline" | undefined>()
  useEffect(() => {
    const timer = setTimeout(() => setLate(navigator.onLine ? "slow" : "offline"), CODE_PATIENCE_MS)
    return () => clearTimeout(timer)
  }, [])
  if (!late) return <span data-original-loading="" aria-live="polite">Opening the original…</span>
  return (
    <span role={late === "offline" ? "alert" : undefined} {...(late === "offline" ? { "data-original-unavailable": "" } : { "data-original-loading": "", "data-original-slow": "" })} className={cn("flex items-center gap-1.5", late === "offline" && "text-negative")}>
      {late === "offline" ? "Couldn't open the original." : "Still opening the original…"}
      <button type="button" className="pressable px-1 text-foreground underline" onClick={onRetry}>
        Retry
      </button>
      <button type="button" className="pressable px-1 text-foreground underline" onClick={() => location.reload()}>
        Reload
      </button>
    </span>
  )
}

/**
 * "Original", when Settings › Diagnostics turns it on: the records a prompt, an answer or a marker was read from, as
 * the harness wrote them, and in a live conversation the lines of its
 * transport Mako recorded it from as it streamed. Only entries that name
 * their bytes offer it: what Mako read from its own older copy has no
 * original to show. Each is read when it is selected: a record from the
 * harness's file, or from Mako's copy when the harness has deleted the
 * session; a live entry by its host, from the view this window holds.
 */
export function ShowOriginal({ origins, className, always = false }: {
  origins: readonly (MessageOrigin | undefined)[]
  className?: string
  /** Shown whatever the setting says, where reading the original is the point (Diagnostics' unread records). */
  always?: boolean
}) {
  const [open, setOpen] = useState(false)
  // Each Retry reads the viewer afresh: a new attempt mounts a new boundary and a new wait.
  const [attempt, setAttempt] = useState(0)
  const retry = () => {
    forgetDialog()
    setAttempt((count) => count + 1)
  }
  const { liveId } = useTranscriptSource()
  const entries = useMemo(() => recorded(origins, liveId), [origins, liveId])
  // A debugging aid, so it's offered only to someone who turned it on (Settings › Diagnostics).
  const shown = usePrefs((prefs) => prefs.showOriginals)
  if ((!shown && !always) || !canReadOriginals() || !entries.length) return null
  return (
    <>
      <button
        type="button"
        data-show-original=""
        onClick={() => setOpen(true)}
        title="The bytes this was read from, as the harness wrote them"
        className={cn("pressable flex h-5 items-center gap-1 px-1 hover:text-foreground focus-visible:text-foreground", className)}
      >
        <FileCode2Icon className="size-3" />
        <span>Original</span>
      </button>
      {open ? (
        <LazyBoundary
          key={attempt}
          onRetry={forgetDialog}
          fallback={(retry) => (
            <span role="alert" data-original-unavailable="" className="flex items-center gap-1.5 text-negative">
              Couldn't open the original.
              <button type="button" className="pressable px-1 text-foreground underline" onClick={retry}>
                Retry
              </button>
              {/* A browser that keeps a dynamic import it failed once (Electron's Chromium) only reads it again afresh. */}
              <button type="button" className="pressable px-1 text-foreground underline" onClick={() => location.reload()}>
                Reload
              </button>
            </span>
          )}>
          <Suspense fallback={<OpeningOriginal onRetry={retry} />}>
            <OriginalDialogLoader entries={entries} onClose={() => setOpen(false)} />
          </Suspense>
        </LazyBoundary>
      ) : null}
    </>
  )
}
