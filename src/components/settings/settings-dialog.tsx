import { useEffect, useRef, useState } from "react"
import { Dialog as DialogPrimitive } from "radix-ui"
import { ArrowLeftIcon, FileCodeIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { useUpdates } from "@/state/updates"
import { openSettingsFile } from "@/state/project-settings"
import type { SettingsSection } from "@/components/settings/sections/manifest"
import { SettingsPanes } from "@/components/settings/settings-panes"
import { section as agents } from "@/components/settings/sections/agents"
import { section as models } from "@/components/settings/sections/models"
import { section as fins } from "@/components/settings/sections/fins"
import { section as usage } from "@/components/settings/sections/usage"
import { section as appearance } from "@/components/settings/sections/appearance"
import { section as notifications } from "@/components/settings/sections/notifications"
import { section as conversation } from "@/components/settings/sections/conversation"
import { section as editor } from "@/components/settings/sections/editor"
import { section as keyboard } from "@/components/settings/sections/keyboard"
import { section as appshots } from "@/components/settings/sections/appshots"
import { section as simulators } from "@/components/settings/sections/simulators"
import { section as apps } from "@/components/settings/sections/apps"
import { section as projects } from "@/components/settings/sections/projects"
import { section as git } from "@/components/settings/sections/git"
import { section as integrations } from "@/components/settings/sections/integrations"
import { section as mcp } from "@/components/settings/sections/mcp"
import { section as skills } from "@/components/settings/sections/skills"
import { section as nativeAuthoring } from "@/components/settings/sections/native-authoring"
import { section as plugins } from "@/components/settings/sections/plugins"
import { section as account } from "@/components/settings/sections/account"
import { section as devices } from "@/components/settings/sections/devices"
import { section as updates } from "@/components/settings/sections/updates"
import { section as storage } from "@/components/settings/sections/storage"
import { section as privacy } from "@/components/settings/sections/privacy"
import { section as diagnostics } from "@/components/settings/sections/diagnostics"
import { section as about } from "@/components/settings/sections/about"

const SECTIONS: readonly SettingsSection[] = [
  agents,
  models,
  fins,
  usage,
  appearance,
  notifications,
  conversation,
  editor,
  keyboard,
  appshots,
  projects,
  git,
  apps,
  integrations,
  mcp,
  skills,
  nativeAuthoring,
  plugins,
  simulators,
  account,
  devices,
  updates,
  storage,
  privacy,
  diagnostics,
  about,
]

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

  // A deep link may name a group within its section, as `git#commit-messages`.
  const [sectionId = "", anchor] = section.split("#")
  const active = SECTIONS.find((entry) => entry.id === sectionId || entry.aliases?.includes(sectionId)) ?? SECTIONS[0]
  useEffect(() => {
    if (!open || !anchor) return
    const frame = requestAnimationFrame(() => document.getElementById(anchor)?.scrollIntoView({ block: "start" }))
    return () => cancelAnimationFrame(frame)
  }, [open, anchor])

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
          <header className="drag-region window-controls-clear flex h-[38px] shrink-0 items-center">
            <div className="window-inset flex h-full w-64 shrink-0 items-center border-r pr-2">
              <DialogPrimitive.Close className="pressable no-drag flex h-7 items-center gap-1.5 px-2 text-ui text-muted-foreground transition-colors duration-100 hover:bg-fill-hover hover:text-foreground">
                <ArrowLeftIcon className="size-3.5" />
                Back
              </DialogPrimitive.Close>
            </div>
            <p className="flex-1 truncate px-4 text-ui text-faint">Settings</p>
          </header>

          <SettingsPanes
            sections={SECTIONS}
            active={active}
            query={query}
            onQuery={setQuery}
            onSectionChange={onSectionChange}
            searchRef={searchRef}
            foot={
              <>
                <button
                  type="button"
                  data-settings-file
                  title="Opens preferences.json, where Mako keeps the settings that follow you between devices, in your editor"
                  onClick={() => void openSettingsFile()}
                  className="pressable flex h-7 items-center gap-2 px-2 text-label text-faint transition-colors duration-100 hover:bg-fill-hover hover:text-foreground"
                >
                  <FileCodeIcon className="size-3.5" />
                  Open settings file
                </button>
                <p className="px-2 text-label text-faint">
                  {version ? `Mako ${version}` : "Mako"}
                </p>
              </>
            }
          />
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
