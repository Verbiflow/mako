import type { ReactNode, RefObject } from "react"
import { SectionTitleContext } from "@/components/settings/section-title"
import { SearchIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { SETTINGS_GROUPS, sectionKeywords, type SettingsSection } from "@/components/settings/sections/manifest"
import type { HarnessDescriptor } from "@/lib/types"
import { useThreads } from "@/state/thread-store"
import { Keys } from "@/components/ui/kit"

function matches(entry: SettingsSection, term: string, harnesses: readonly HarnessDescriptor[]): boolean {
  if (!term) return true
  return (
    entry.title.toLowerCase().includes(term) ||
    sectionKeywords(entry, harnesses).some((keyword) => keyword.toLowerCase().includes(term))
  )
}

/** The keyword that earned a row its place in a filtered nav — shown as a
 * small chip so a hit on "daemon" under Agents is legible, not mysterious. */
function matchedKeyword(
  entry: SettingsSection,
  term: string,
  harnesses: readonly HarnessDescriptor[]
): string | undefined {
  if (entry.title.toLowerCase().includes(term)) return undefined
  return sectionKeywords(entry, harnesses).find((keyword) => keyword.toLowerCase().includes(term))
}

/**
 * Settings' two panes, wherever Settings is drawn: the desktop's window and a laptop's browser alike. A grouped nav
 * with its search-as-index at the side, one section at a time in a readable column beside it. What the sections are is
 * the caller's: the desktop's, or what a browser can reach.
 */
export function SettingsPanes({ sections, active, query, onQuery, onSectionChange, searchRef, foot }: {
  sections: readonly SettingsSection[]
  active: SettingsSection
  query: string
  onQuery: (query: string) => void
  onSectionChange: (id: string) => void
  searchRef?: RefObject<HTMLInputElement | null>
  /** Under the nav: what the window says of itself (its settings file, its version). */
  foot?: ReactNode
}) {
  const descriptors = useThreads((state) => state.descriptors)
  const term = query.trim().toLowerCase()
  const shown = sections.filter((entry) => matches(entry, term, descriptors))
  const search = (next: string) => {
    onQuery(next)
    const nextTerm = next.trim().toLowerCase()
    if (!nextTerm) return
    const hits = sections.filter((entry) => matches(entry, nextTerm, descriptors))
    const destination = hits.find((entry) => entry.id === active.id) ?? hits[0]
    if (!destination) return
    destination.onSearch?.(nextTerm)
    if (destination.id !== active.id) onSectionChange(destination.id)
  }
  return (
    <div className="flex min-h-0 flex-1">
      <nav className="flex w-64 shrink-0 flex-col border-r">
        <div className="p-3 pb-1">
          <label className="flex h-8 items-center gap-2 bg-raised px-2.5 focus-within:[box-shadow:inset_0_0_0_1px_var(--border)]">
            <SearchIcon className="size-3.5 shrink-0 text-faint" />
            <input
              ref={searchRef}
              value={query}
              onChange={(event) => search(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape" && query) {
                  event.stopPropagation()
                  onQuery("")
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
                    const chip = term ? matchedKeyword(entry, term, descriptors) : undefined
                    const selected = active.id === entry.id
                    const Icon = entry.icon
                    return (
                      <button
                        key={entry.id}
                        type="button"
                        data-settings-section={entry.id}
                        aria-current={selected ? "page" : undefined}
                        onClick={() => {
                          if (term) entry.onSearch?.(term)
                          onSectionChange(entry.id)
                        }}
                        className={cn(
                          "pressable flex h-8 w-full items-center gap-2.5 px-2 text-left text-ui transition-colors duration-100",
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

        {foot ? <div className="flex shrink-0 flex-col items-start gap-0.5 px-3 pt-1 pb-2.5">{foot}</div> : null}
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
          <SectionTitleContext value={active.title}>
          <active.Component />
        </SectionTitleContext>
        </div>
      </main>
    </div>
  )
}
