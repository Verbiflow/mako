import { useEffect, useId, useState } from "react"
import type { Root } from "hast"
import { requestProse, cancelProse } from "@/lib/prose-parser-client"

/**
 * From this length a streaming piece is parsed in the prose worker, not on the page. Measured on a CI Mac on the phone's
 * streamed prose, the parse alone took 2.7 to 7.4 ms at 4 KB and 9 to 24 ms at 16 KB, and the page builds its tree on
 * top: at the 16 KB this was, a 15,000-character answer streamed under a reader's flick held the page 54 to 135 ms.
 */
const OFF_THREAD_CHARS = 4_096

export function useParsedProse(text: string, streaming: boolean) {
  const owner = useId()
  const [result, setResult] = useState<{ text: string; tree: Root } | null>(
    null
  )
  const [failed, setFailed] = useState(false)
  const enabled = streaming && text.length >= OFF_THREAD_CHARS && !failed
  if (!enabled && result) setResult(null)
  useEffect(() => () => cancelProse(owner), [owner, enabled])
  useEffect(() => {
    if (!enabled) return
    return requestProse(owner, text, (tree) => {
      if (tree) setResult({ text, tree })
      else setFailed(true)
    })
  }, [owner, text, enabled])
  return enabled && result && text.startsWith(result.text) ? result : null
}
