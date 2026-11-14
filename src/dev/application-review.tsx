import { useEffect, useState } from "react"
import { SettingsDialog } from "@/components/settings/settings-dialog"
import {
  ApplicationDialog,
  ApplicationNotice,
} from "@/components/settings/application-dialog"
import { CommandPalette } from "@/components/palette/command-palette"
import { TooltipProvider } from "@/components/ui/tooltip"
import { useDeskCommands } from "@/desk/use-desk-commands"
import { rememberDraft } from "@/state/drafts"

export function ApplicationReview() {
  useDeskCommands()
  const [open, setOpen] = useState(true)
  useEffect(() => {
    const show = () => setOpen(true)
    window.addEventListener("mako:settings", show)
    return () => window.removeEventListener("mako:settings", show)
  }, [])
  return (
    <TooltipProvider>
      <div className="flex h-svh flex-col bg-shell">
        <ApplicationNotice />
        <textarea
          aria-label="Draft retained across updates"
          className="m-6 bg-surface p-4 text-ui"
          onChange={(event) => rememberDraft("fixture", event.target.value)}
        />
        <div className="m-auto text-ui text-faint">
          Your workspace stays here.
        </div>
      </div>
      <SettingsDialog
        open={open}
        section="updates"
        onOpenChange={setOpen}
        onSectionChange={() => {}}
      />
      <ApplicationDialog />
      <CommandPalette />
    </TooltipProvider>
  )
}
