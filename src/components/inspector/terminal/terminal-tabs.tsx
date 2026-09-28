import { useRef } from "react"
import { Columns2Icon, Rows2Icon } from "lucide-react"
import { useCompactRow } from "@/components/composer/use-compact-row"
import type { TerminalGroup } from "@/lib/terminal-layout"
import type { TerminalSession } from "@/lib/types"
import { terminalActions } from "@/state/terminal"
import { hideAppOutput } from "@/state/thread-app"
import { SessionTab } from "./session-tab"

/**
 * One tab per shell, left to right. Panes of a split sit between two
 * hairlines behind the split's mark, so a split reads as one place with
 * several shells in it.
 */
export function TerminalTabs({
  groups,
  sessions,
  activeId,
  titles,
}: {
  groups: TerminalGroup[]
  sessions: TerminalSession[]
  activeId?: string
  titles: Record<string, string>
}) {
  const strip = useRef<HTMLDivElement>(null)
  useCompactRow(strip, 0)
  const ids = groups.flatMap((group) => group.sessionIds)
  const seen = new Map<string, number>()
  const ordinals = new Map<string, number>()
  for (const id of ids) {
    const session = sessions.find((entry) => entry.id === id)
    if (!session) continue
    const title = titles[id] ?? session.title
    const count = (seen.get(title) ?? 0) + 1
    seen.set(title, count)
    if (count > 1) ordinals.set(id, count)
  }
  return (
    <div
      ref={strip}
      role="tablist"
      aria-label="Terminal sessions"
      aria-orientation="horizontal"
      onKeyDown={(event) => {
        if (
          !(event.target instanceof HTMLElement) ||
          event.target.getAttribute("role") !== "tab"
        )
          return
        const index = ids.indexOf(activeId ?? "")
        const next =
          event.key === "ArrowRight"
            ? (index + 1) % ids.length
            : event.key === "ArrowLeft"
              ? (index - 1 + ids.length) % ids.length
              : event.key === "Home"
                ? 0
                : event.key === "End"
                  ? ids.length - 1
                  : undefined
        if (next === undefined) return
        event.preventDefault()
        terminalActions.activate(ids[next])
        event.currentTarget
          .querySelectorAll<HTMLButtonElement>('[role="tab"]')
          .item(next)
          ?.focus()
      }}
      className="terminal-tabs flex h-full min-w-0 items-stretch overflow-x-auto [scrollbar-width:none]"
    >
      {groups.map((group) => {
        const tabs = group.sessionIds.flatMap((id) => {
          const session = sessions.find((entry) => entry.id === id)
          return session
            ? [
                <SessionTab
                  key={id}
                  session={session}
                  title={titles[id] ?? session.title}
                  ordinal={ordinals.get(id)}
                  active={id === activeId}
                  onSelect={() => {
                    hideAppOutput()
                    terminalActions.activate(id)
                  }}
                  onClose={() => terminalActions.requestClose(id)}
                />,
              ]
            : []
        })
        if (group.sessionIds.length < 2) return tabs
        const SplitIcon =
          group.orientation === "vertical" ? Rows2Icon : Columns2Icon
        return (
          <div
            key={group.id}
            role="presentation"
            className="flex shrink-0 items-stretch border-x border-hairline first:border-l-0"
          >
            <SplitIcon
              aria-label={
                group.orientation === "vertical" ? "Stacked" : "Side by side"
              }
              className="ml-2.5 size-3 shrink-0 self-center text-faint"
            />
            {tabs}
          </div>
        )
      })}
    </div>
  )
}
