import { useEffect, useState } from "react"
import { GitForkIcon } from "lucide-react"
import type { ThreadOrigin } from "@mako/host/contracts/thread-splits"
import { getMako, hasBridge } from "@/lib/bridge"
import { currentThreadTabs, openSessionTab, sessionTabTitle, useOnScreen, useThreadTabs } from "@/state/thread-sessions"

const NOWHERE = {}

/**
 * Over a Thread that came from another, quietly: "Forked from …", or "Split from …" for one that was a tab of it before
 * a Thread was one conversation. Pressed, it opens that Thread.
 */
export function ThreadCrumb() {
  const { thread, draft } = useOnScreen()
  const shown = draft ? undefined : thread
  const [known, setKnown] = useState<{ thread: string; origin: ThreadOrigin | null } | null>(null)
  useEffect(() => {
    if (!shown || !hasBridge()) return
    let current = true
    void getMako().threadOrigin(shown).then((origin) => {
      if (current) setKnown({ thread: shown, origin })
    }, () => {})
    return () => {
      current = false
    }
  }, [shown])
  const origin = known?.thread === shown ? known?.origin : undefined
  const [from] = useThreadTabs(origin ? { thread: origin.from } : NOWHERE)
  if (!origin) return null
  const title = (from && sessionTabTitle(from)) ?? origin.title
  if (!title) return null
  const open = () => {
    const tab = currentThreadTabs(origin.from)[0]
    if (tab) openSessionTab(tab)
  }
  return (
    <nav aria-label="Where this thread came from" data-thread-crumb={origin.kind} className="flex h-7 shrink-0 items-center gap-1 px-3 text-label text-faint">
      <GitForkIcon aria-hidden className="size-3 shrink-0" />
      <span className="shrink-0">{origin.kind === "fork" ? "Forked from" : "Split from"}</span>
      <button type="button" onClick={open} disabled={!from} className="pressable min-w-0 truncate px-0.5 text-muted-foreground hover:text-foreground disabled:text-faint">
        {title}
      </button>
    </nav>
  )
}
