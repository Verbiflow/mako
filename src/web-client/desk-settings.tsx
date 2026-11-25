import { useEffect, useMemo, useState } from "react"
import { SettingsPanes } from "@/components/settings/settings-panes"
import type { ScreenRoute } from "./route"
import { webSettingsSections } from "./settings-sections"
import { SetupScreen } from "./setup-screen"
import { onSettingsSectionAsked, takeAskedSettingsSection } from "./settings-asked"

/** The desk's own routes for its pane: Settings, and a project's Setup opened from it. */
export type DeskSettingsRoute = Extract<ScreenRoute, { kind: "settings" | "setup" }>

/**
 * The pane a laptop's browser keeps Settings in: the desktop's own Settings panes (a grouped nav with its search, one
 * section at a time), holding what a browser can reach (`webSettingsSections`); and a project's Setup drawn there at
 * the desk's width, so an agent's ask has the same place to go as on the desk.
 */
export default function DeskSettings({ route, open }: { route: DeskSettingsRoute; open: (next: ScreenRoute) => void }) {
  const sections = useMemo(() => webSettingsSections((project) => open({ kind: "setup", project })), [open])
  // A section asked for by name opens here as on the desk: its id or an id merged into it, the part after "#" a group.
  const resolve = (asked: string | undefined) => {
    const id = asked?.split("#")[0]
    return sections.find((entry) => entry.id === id || entry.aliases?.includes(id ?? ""))?.id
  }
  const [section, setSection] = useState(() => resolve(takeAskedSettingsSection()) ?? sections[0]!.id)
  useEffect(() => onSettingsSectionAsked((asked) => {
    takeAskedSettingsSection()
    const id = resolve(asked)
    if (id) setSection(id)
  }))
  const [query, setQuery] = useState("")
  if (route.kind === "setup") return <SetupScreen project={route.project} onBack={() => open({ kind: "settings" })} desk />
  const active = sections.find((entry) => entry.id === section) ?? sections[0]!
  return (
    <div data-desk-settings className="flex min-h-0 flex-1 flex-col bg-shell">
      <SettingsPanes sections={sections} active={active} query={query} onQuery={setQuery} onSectionChange={setSection} />
    </div>
  )
}
