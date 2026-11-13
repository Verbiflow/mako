import { useCallback, useEffect, useRef, useState } from "react"
import { CODE_PATIENCE_MS } from "@/lib/code-patience"

/** Back online, a read is tried at once and then after these pauses: the event can come before the network carries. */
const ONLINE_RETRIES_MS = [0, 1_000, 3_000]

/**
 * Trying a chunk of code again (`chunk`, `lazyCode`): by hand, and by itself when the browser is back online. A read that
 * fails, or never settles, while the browser says it's online is one this page won't fetch again (Electron's Chromium
 * keeps a dynamic import it failed once; Safari can leave it pending), so it's `stuck`: only a reload brings it.
 */
export interface CodeRetry {
  /** A read failed, or never settled, while the browser was online: only a reload brings it. */
  stuck: boolean
  /** One read now: whether the code arrived. */
  tryOnce: () => Promise<boolean>
}

export function useCodeRetry(retry: () => Promise<void>): CodeRetry {
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
      timer = setTimeout(() => settle(true), CODE_PATIENCE_MS)
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
  return { stuck, tryOnce }
}
