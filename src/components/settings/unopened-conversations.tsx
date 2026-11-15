import { Action } from "@/components/ui/kit"
import { IfCanReveal } from "@/components/ui/machine-gate"
import { cn } from "@/lib/utils"
import { desktop } from "@/state/desktop"
import { useUnopened } from "@/state/unopened-conversations"

function openDiagnostics() {
  window.dispatchEvent(new CustomEvent("mako:settings", { detail: "diagnostics" }))
}

function counted(count: number): string {
  return count === 1 ? "A saved conversation couldn't be opened" : `${count} saved conversations couldn't be opened`
}

/** The rail's narrow line: "1 conversation couldn't open". */
function short(count: number): string {
  return `${count} conversation${count === 1 ? "" : "s"} couldn't open`
}

/** Above the rail's footer while any saved conversation couldn't be opened: how many, and where they're listed. */
export function UnopenedRailLine({ className }: { className?: string }) {
  const count = useUnopened((state) => state.conversations.length)
  if (!count) return null
  return (
    <div data-unopened={count} className={cn("flex items-center gap-2 border-t border-hairline px-3 py-2 text-label text-muted-foreground", className)}>
      <span className="min-w-0 flex-1 truncate" title={`${counted(count)}. Each journal is kept as it was.`}>{short(count)}</span>
      <button type="button" onClick={openDiagnostics} className="pressable -my-0.5 h-5 shrink-0 px-1.5 text-label font-medium text-foreground/80 hover:bg-fill-hover hover:text-foreground">
        Show
      </button>
    </div>
  )
}

/** Settings › Diagnostics: each saved conversation this host couldn't open, what it met, and its kept journal. */
export function UnopenedConversations() {
  const conversations = useUnopened((state) => state.conversations)
  if (!conversations.length) return null
  return (
    <section aria-label="Saved conversations that couldn't be opened" className="mt-2 bg-raised">
      <div className="px-3 py-2">
        <p className="text-ui">{counted(conversations.length)}</p>
        <p className="text-label text-muted-foreground">Each journal is kept as it was, for recovery; nothing in it was removed.</p>
      </div>
      {conversations.map((each) => (
        <div key={each.conversation} data-unopened-conversation={each.conversation} className="flex items-center gap-3 border-t border-hairline px-3 py-2">
          <div className="min-w-0 flex-1">
            <p className="truncate font-mono text-label">{each.conversation}</p>
            <p className="text-label text-muted-foreground">{each.error}</p>
          </div>
          <IfCanReveal>
            <Action onClick={() => void desktop.revealPath(each.journal)}>Show the journal</Action>
          </IfCanReveal>
        </div>
      ))}
    </section>
  )
}
