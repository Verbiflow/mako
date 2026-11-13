import { CloudOffIcon, XIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { useCodeRetry } from "./code-retry"

// Every piece of the web app read as a chunk of its own says where it stands: loading draws a line, a failure says so
// with Retry (and Reload where the page won't fetch it again, `useCodeRetry`), and nothing is left blank. Drawn without
// the kit's module (`Blank`), since the Files layer that uses them is part of the list's first code.

/**
 * A piece whose code is on its way: a quiet line where it will draw. Past its patience (`slow`) the download is still
 * under way, not failed: the same look, saying "Still loading…", with Reload for someone who won't wait.
 */
export function CodeSlowLine({ what, slow, className }: { what: string; slow: boolean; className?: string }) {
  return (
    <p data-code-loading="" data-code-slow={slow ? "" : undefined} aria-live="polite" className={cn("flex items-center gap-2 text-ui text-faint", className)}>
      <span>{slow ? `Still loading ${what}…` : `Loading ${what}…`}</span>
      {slow ? (
        <button type="button" className="pressable h-7 shrink-0 border border-hairline px-2.5 text-ui text-foreground" onClick={() => location.reload()}>
          Reload
        </button>
      ) : null}
    </p>
  )
}

/** A layer whose code is on its way (Files, Changes): its loading line where it will draw. */
export function CodeLoading({ what, slow }: { what: string; slow: boolean }) {
  return (
    <div className="rv-screen" data-code-loading-layer="">
      <CodeSlowLine what={what} slow={slow} className="m-auto" />
    </div>
  )
}

/** A layer whose code didn't arrive: opened offline before the service worker kept it, or on a network that dropped it. */
export function CodeUnavailable({ what, retry, onClose }: { what: string; retry: () => Promise<void>; onClose: () => void }) {
  const { stuck, tryOnce } = useCodeRetry(retry)
  return (
    <div className="rv-screen" data-code-unavailable={stuck ? "stuck" : ""}>
      <div className="rv-bar justify-end">
        <button type="button" aria-label={`Close ${what}`} className="web-icon-button" onClick={onClose}>
          <XIcon className="size-5" />
        </button>
      </div>
      <div className="flex flex-1 flex-col items-center justify-center gap-2 px-8 py-12 text-center">
        <div className="mb-1 flex size-8 items-center justify-center bg-raised text-faint [&_svg]:size-4">
          <CloudOffIcon />
        </div>
        <p className="text-ui font-medium text-foreground">{what} couldn't load</p>
        <p className="max-w-[30ch] text-ui leading-relaxed text-faint">
          {stuck ? "This page won't fetch it again. Reload to load it fresh." : "Check your connection. Mako tries again once you're back online."}
        </p>
        <button type="button" className="pressable mt-2 h-8 border border-hairline px-3 text-ui" onClick={stuck ? () => location.reload() : () => void tryOnce()}>
          {stuck ? "Reload" : "Retry"}
        </button>
      </div>
    </div>
  )
}

/**
 * A piece inside a screen whose code didn't arrive (the desk's composer, the Agents sheet's roster): one line saying so,
 * with Retry and Reload, in the room the piece would take.
 */
export function CodeLine({ what, retry, className }: { what: string; retry: () => Promise<void>; className?: string }) {
  const { stuck, tryOnce } = useCodeRetry(retry)
  return (
    <div role="alert" data-code-unavailable={stuck ? "stuck" : ""} className={cn("flex items-center gap-2 px-4 text-ui text-faint", className)}>
      <CloudOffIcon className="size-3.5 shrink-0" />
      <span className="min-w-0 flex-1">
        {what} couldn't load. {stuck ? "This page won't fetch it again." : "Mako tries again once you're back online."}
      </span>
      {stuck ? null : (
        <button type="button" className="pressable h-7 shrink-0 border border-hairline px-2.5 text-ui text-foreground" onClick={() => void tryOnce()}>
          Retry
        </button>
      )}
      <button type="button" className="pressable h-7 shrink-0 border border-hairline px-2.5 text-ui text-foreground" onClick={() => location.reload()}>
        Reload
      </button>
    </div>
  )
}
