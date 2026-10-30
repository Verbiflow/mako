import type { Gateway } from "./gateway"

/** Said again this often while it lasts; the account counts a page attended for two minutes after it last said so. */
const ATTENTION_EVERY_MS = 60_000

/**
 * Says to the account while this page is in front of the person, and when it stops being, so a notice for them waits
 * while they're here (`needs you`). Said at most once a minute while it lasts; a page hidden says so at once.
 */
export function reportAttention(gateway: Gateway): () => void {
  let timer: ReturnType<typeof setInterval> | undefined
  let attending = false
  const say = (now: boolean) => {
    attending = now
    void gateway.rest("PUT", "/v1/attention", { attending: now }).catch(() => undefined)
  }
  const look = () => {
    const here = document.visibilityState === "visible" && document.hasFocus()
    if (here && !timer) {
      say(true)
      timer = setInterval(() => say(true), ATTENTION_EVERY_MS)
    } else if (!here && timer) {
      clearInterval(timer)
      timer = undefined
      if (attending) say(false)
    }
  }
  const events = ["focus", "blur"] as const
  for (const event of events) window.addEventListener(event, look)
  document.addEventListener("visibilitychange", look)
  look()
  return () => {
    for (const event of events) window.removeEventListener(event, look)
    document.removeEventListener("visibilitychange", look)
    if (timer) clearInterval(timer)
  }
}
