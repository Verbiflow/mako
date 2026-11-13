import { useEffect, useState } from "react"
import { CODE_PATIENCE_MS } from "@/lib/code-patience"

/**
 * How a wait for code stands by the clock and the network, for a piece whose read has no state of its own (a
 * `React.lazy` piece's Suspense fallback): waiting, then past `CODE_PATIENCE_MS` slow, or offline while the browser is.
 * It follows the network from then on, and stops listening once the piece unmounts.
 */
export function usePatience(enabled = true): "waiting" | "slow" | "offline" {
  const [late, setLate] = useState<"waiting" | "slow" | "offline">("waiting")
  useEffect(() => {
    if (!enabled) return
    const say = () => setLate(navigator.onLine ? "slow" : "offline")
    const timer = setTimeout(() => {
      say()
      addEventListener("online", say)
      addEventListener("offline", say)
    }, CODE_PATIENCE_MS)
    return () => {
      clearTimeout(timer)
      removeEventListener("online", say)
      removeEventListener("offline", say)
    }
  }, [enabled])
  return late
}
