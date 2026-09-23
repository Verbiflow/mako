import { useRef, useState } from "react"
import { Dialog as DialogPrimitive } from "radix-ui"
import { ArrowLeftIcon, SearchIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { useUpdates } from "@/state/updates"
import {
  SETTINGS_GROUPS,
  type SettingsSection,
} from "@/components/settings/sections/manifest"
import { section as agents } from "@/components/settings/sections/agents"
import { section as models } from "@/components/settings/sections/models"
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
import { Keys } from "@/components/ui/kit"

const SECTIONS: readonly SettingsSection[] = [
  agents,
  models,
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
 * Settings takes the whole window, the way a preferences page does: its own
 * title strip with the way back, a grouped nav with a search-as-index, and
 * one section at a time in a readable column. The desk is not behind a
 * scrim; it is simply not in the way. Radix still owns Escape and the focus
 * trap, and the first Escape clears a non-empty search instead of closing.
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
  const searchRef = useRef<HTMLInputElement>(null)

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
    <DialogPrimitive.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) setQuery("")
        onOpenChange(next)
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Content
          aria-describedby={undefined}
          onEscapeKeyDown={(event) => {
            if (!query) return
            event.preventDefault()
            setQuery("")
          }}
          onKeyDown={(event) => {
            if (event.key === "f" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault()
              searchRef.current?.focus()
            }
          }}
          className={cn(
            "fixed inset-0 z-40 flex flex-col bg-shell text-foreground outline-hidden",
            "data-open:animate-in data-open:fade-in-0 data-open:duration-150",
            "data-closed:animate-out data-closed:fade-out-0 data-closed:duration-100"
          )}
        >
          <DialogPrimitive.Title className="sr-only">Settings</DialogPrimitive.Title>
          <header className="drag-region flex h-[38px] shrink-0 items-center border-b border-hairline">
            <div className="flex h-full w-64 shrink-0 items-center border-r border-hairline pr-2 pl-[86px]">
              <DialogPrimitive.Close className="pressable no-drag flex h-7 items-center gap-1.5 rounded-md px-2 text-ui text-muted-foreground transition-colors duration-100 hover:bg-fill-hover hover:text-foreground">
                <ArrowLeftIcon className="size-3.5" />
                Back
              </DialogPrimitive.Close>
            </div>
            <p className="flex-1 truncate px-4 text-ui text-faint">Settings</p>
          </header>

          <div className="flex min-h-0 flex-1">
            <nav className="flex w-64 shrink-0 flex-col border-r border-hairline">
              <div className="p-3 pb-1">
                <label className="flex h-8 items-center gap-2 rounded-md bg-raised/70 px-2.5 [box-shadow:inset_0_0_0_0.5px_var(--hairline)] focus-within:[box-shadow:inset_0_0_0_1px_var(--border)]">
                  <SearchIcon className="size-3.5 shrink-0 text-faint" />
                  <input
                    ref={searchRef}
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
                    className="min-w-0 flex-1 bg-transparent text-ui placeholder:text-faint focus:outline-none"
                  />
                  {query ? null : <Keys keys={["⌘", "F"]} />}
                </label>
              </div>

              <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
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
                        <div className="px-2 pt-4 pb-1.5 text-label text-faint">
                          {group}
                        </div>
                        {entries.map((entry) => {
                          const chip = term ? matchedKeyword(entry, term) : undefined
                          const selected = active.id === entry.id
                          const Icon = entry.icon
                          return (
                            <button
                              key={entry.id}
                              type="button"
                              aria-current={selected ? "page" : undefined}
                              onClick={() => onSectionChange(entry.id)}
                              className={cn(
                                "pressable flex h-8 w-full items-center gap-2.5 rounded-md px-2 text-left text-ui transition-colors duration-100",
                                selected
                                  ? "bg-fill-selected font-medium text-foreground"
                                  : "text-muted-foreground hover:bg-fill-hover hover:text-foreground"
                              )}
                            >
                              <Icon
                                className={cn(
                                  "size-4 shrink-0",
                                  selected ? "text-foreground" : "text-faint"
                                )}
                              />
                              <span className="min-w-0 flex-1 truncate">{entry.title}</span>
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

              <p className="shrink-0 border-t border-hairline px-5 py-2.5 text-label text-faint">
                {version ? `Mako ${version}` : "Mako"}
              </p>
            </nav>

            <main className="min-w-0 flex-1 overflow-y-auto bg-surface">
              <div
                key={active.id}
                className="mx-auto flex max-w-[50rem] flex-col gap-8 px-10 pt-9 pb-16 animate-in fade-in-0 slide-in-from-bottom-1 duration-200"
              >
                <div className="flex items-center gap-2.5">
                  <active.icon className="size-4 text-faint" />
                  <h2 className="text-title font-semibold">{active.title}</h2>
                </div>
                <active.Component />
              </div>
            </main>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
