import { useState } from "react"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { cn } from "@/lib/utils"
import { useUpdates } from "@/state/updates"
import {
  SETTINGS_GROUPS,
  type SettingsSection,
} from "@/components/settings/sections/manifest"
import { section as agents } from "@/components/settings/sections/agents"
import { section as usage } from "@/components/settings/sections/usage"
import { section as appearance } from "@/components/settings/sections/appearance"
import { section as notifications } from "@/components/settings/sections/notifications"
import { section as conversation } from "@/components/settings/sections/conversation"
import { section as editor } from "@/components/settings/sections/editor"
import { section as keyboard } from "@/components/settings/sections/keyboard"
import { section as commits } from "@/components/settings/sections/commit-prompt"
import { section as automations } from "@/components/settings/sections/automations"
import { section as integrations } from "@/components/settings/sections/integrations"
import { section as mcp } from "@/components/settings/sections/mcp"
import { section as skills } from "@/components/settings/sections/skills"
import { section as plugins } from "@/components/settings/sections/plugins"
import { section as updates } from "@/components/settings/sections/updates"
import { section as diagnostics } from "@/components/settings/sections/diagnostics"
import { section as about } from "@/components/settings/sections/about"

const SECTIONS: readonly SettingsSection[] = [
  agents,
  usage,
  appearance,
  notifications,
  conversation,
  editor,
  keyboard,
  commits,
  automations,
  integrations,
  mcp,
  skills,
  plugins,
  updates,
  diagnostics,
  about,
]

function matches(entry: SettingsSection, term: string): boolean {
  if (!term) return true
  return (
    entry.title.toLowerCase().includes(term) ||
    entry.keywords.some((keyword) => keyword.toLowerCase().includes(term))
  )
}

/** The keyword that earned a row its place in a filtered nav — shown as a
 * small chip so a hit on "daemon" under Agents is legible, not mysterious. */
function matchedKeyword(
  entry: SettingsSection,
  term: string
): string | undefined {
  if (entry.title.toLowerCase().includes(term)) return undefined
  return entry.keywords.find((keyword) => keyword.toLowerCase().includes(term))
}

/**
 * Settings, as a large centered dialog: a grouped nav rail with a
 * search-as-index on the left, one section at a time on the right. Radix
 * owns Escape, the scrim, and the focus trap; the first Escape clears a
 * non-empty search instead of closing.
 */
export function SettingsDialog({
  open,
  section,
  onOpenChange,
  onSectionChange,
}: {
  open: boolean
  section: string
  onOpenChange: (open: boolean) => void
  onSectionChange: (id: string) => void
}) {
  const [query, setQuery] = useState("")
  const version = useUpdates((state) => state.version)

  const active = SECTIONS.find((entry) => entry.id === section) ?? SECTIONS[0]
  const term = query.trim().toLowerCase()
  const shown = SECTIONS.filter((entry) => matches(entry, term))

  const search = (next: string) => {
    setQuery(next)
    const nextTerm = next.trim().toLowerCase()
    if (!nextTerm) return
    const hits = SECTIONS.filter((entry) => matches(entry, nextTerm))
    const first = hits[0]
    if (first && !hits.some((entry) => entry.id === active.id))
      onSectionChange(first.id)
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setQuery("")
        onOpenChange(next)
      }}
    >
      <DialogContent
        size="settings"
        className="flex overflow-hidden"
        onEscapeKeyDown={(event) => {
          if (!query) return
          event.preventDefault()
          setQuery("")
        }}
      >
        <DialogTitle className="sr-only">Settings</DialogTitle>

        <nav className="flex w-60 shrink-0 flex-col border-r border-hairline p-3">
          <input
            value={query}
            onChange={(event) => search(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape" && query) {
                event.stopPropagation()
                setQuery("")
              }
            }}
            placeholder="Search settings"
            aria-label="Search settings"
            className="h-7 w-full shrink-0 rounded-md bg-raised px-2 text-ui placeholder:text-faint focus:ring-1 focus:ring-border focus:outline-none"
          />

          <div className="min-h-0 flex-1 overflow-y-auto">
            {shown.length === 0 ? (
              <p className="px-2 pt-3 text-ui text-faint">
                Nothing matches “{query.trim()}”.
              </p>
            ) : (
              SETTINGS_GROUPS.map((group) => {
                const entries = shown.filter((entry) => entry.group === group)
                if (entries.length === 0) return null
                return (
                  <div key={group} className="flex flex-col gap-px">
                    <div className="px-2 pt-3 pb-1 text-label text-faint">
                      {group}
                    </div>
                    {entries.map((entry) => {
                      const chip = term
                        ? matchedKeyword(entry, term)
                        : undefined
                      return (
                        <button
                          key={entry.id}
                          type="button"
                          onClick={() => onSectionChange(entry.id)}
                          className={cn(
                            "pressable flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-ui",
                            active.id === entry.id
                              ? "bg-fill-selected font-medium text-foreground"
                              : "text-muted-foreground hover:bg-fill-hover"
                          )}
                        >
                          <span className="min-w-0 flex-1 truncate">
                            {entry.title}
                          </span>
                          {chip ? (
                            <span className="shrink-0 truncate text-label text-faint">
                              {chip}
                            </span>
                          ) : null}
                        </button>
                      )
                    })}
                  </div>
                )
              })
            )}
          </div>

          <p className="shrink-0 px-2 pt-2 text-label text-faint">
            {version ? `Mako ${version}` : "Mako"}
          </p>
        </nav>

        <div className="min-w-0 flex-1 overflow-y-auto">
          <div key={active.id} className="flex flex-col gap-8 px-8 py-7">
            <h2 className="text-title font-semibold">{active.title}</h2>
            <active.Component />
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
