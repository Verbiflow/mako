import { useCallback, useEffect, useRef, useState } from "react"
import { CloudOffIcon, XIcon } from "lucide-react"

/** Back online, a read is tried at once and then after these pauses: the event can come before the network carries. */
const ONLINE_RETRIES_MS = [0, 1_000, 3_000]
/** A read still unsettled this long while online won't settle: Safari leaves an import it failed before pending. */
const READ_PATIENCE_MS = 8_000

/**
 * A screen whose code didn't arrive: opened offline before the service worker kept it, or on a network that dropped it.
 * It says so and offers Retry, and tries again by itself when the browser is back online, never an empty layer. A read
 * that fails, or never settles, while the browser says it's online is one this page won't fetch again (Safari can leave
 * a module it failed to load pending for good), so it offers Reload instead, which reads everything afresh.
 */
export function CodeUnavailable({ what, retry, onClose }: { what: string; retry: () => Promise<void>; onClose: () => void }) {
  const [stuck, setStuck] = useState(false)
  const shown = useRef(true)
  useEffect(() => {
    shown.current = true
    return () => {
      shown.current = false
    }
  }, [])
  const tryOnce = useCallback(async () => {
    const online = navigator.onLine
    let timer: ReturnType<typeof setTimeout> | undefined
    const late = new Promise<boolean>((settle) => {
      timer = setTimeout(() => settle(true), READ_PATIENCE_MS)
    })
    const failed = await Promise.race([retry().then(() => false, () => true), late])
    clearTimeout(timer)
    if (failed && online && shown.current) setStuck(true)
    return !failed
  }, [retry])
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const back = () => {
      clearTimeout(timer)
      const attempt = (index: number) => {
        timer = setTimeout(() => {
          void tryOnce().then((read) => {
            if (!read && index + 1 < ONLINE_RETRIES_MS.length) attempt(index + 1)
          })
        }, ONLINE_RETRIES_MS[index])
      }
      attempt(0)
    }
    addEventListener("online", back)
    return () => {
      removeEventListener("online", back)
      clearTimeout(timer)
    }
  }, [tryOnce])
  return (
    <div className="rv-screen" data-code-unavailable={stuck ? "stuck" : ""}>
      <div className="rv-bar justify-end">
        <button type="button" aria-label={`Close ${what}`} className="web-icon-button" onClick={onClose}>
          <XIcon className="size-5" />
        </button>
      </div>
      {/* Drawn as the kit's empty state (`Blank`) is, without its module: this is part of the list's first code. */}
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
