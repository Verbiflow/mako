import { HarnessIcon } from "@/components/ui/provider-icon"
import { harnessLabel } from "@/lib/harness-label"
import { sendsToWords, sessionName, standingBrief } from "@/lib/session-words"
import { useAcp } from "@/state/acp"
import { sessionPromptedAt, sessionTabFacts, sessionTabTitle, useMinute, useOnScreen, useThreadTabs } from "@/state/thread-sessions"

/**
 * Over the composer's field, quietly, where its words go when the Thread on screen was left whole, with more than one Session: the
 * Session's harness mark, "To Claude Code fork · Profile the rail", how it stands, "Asleep · Oct 17", and the one it
 * was forked from, last, as the first to give way to a narrow pane. Its tab says so too, but a narrow pane cuts a
 * Thread's tabs to a letter or two.
 */
export function ComposerSendsTo() {
  const here = useOnScreen()
  const tabs = useThreadTabs(here)
  const prompted = useAcp((state) => (here.session ? sessionPromptedAt(state, here.session) : undefined))
  const now = useMinute()
  const tab = here.draft ? undefined : tabs.find((each) => each.id === here.session)
  if (tabs.filter((each) => each.kind === "session").length < 2 || tab?.kind !== "session") return null
  const facts = { ...sessionTabFacts(tab, prompted), title: sessionTabTitle(tab) }
  const label = harnessLabel(facts.harness)
  const parentTab = tabs.find((each) => each.id === facts.forkOf)
  const parent = parentTab && sessionTabTitle(parentTab)
  const words = sendsToWords(facts, label)
  const standing = standingBrief(facts, now)
  const forked = parent && parent !== sessionName(facts, label) ? `fork of ${parent}` : undefined
  return (
    <p className="flex min-w-0 items-center gap-1 px-4 pt-3 text-label text-faint" data-sends-to title={[words, standing, forked].filter(Boolean).join("\n")}>
      {facts.harness ? <HarnessIcon harness={facts.harness} className="mr-0.5 size-3.5 shrink-0" /> : null}
      <span className="min-w-0 truncate">{words}</span>
      <span className="shrink-0">· {standing}</span>
      {forked ? <span className="min-w-0 shrink-[4] truncate">· {forked}</span> : null}
    </p>
  )
}
