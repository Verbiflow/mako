import { PuzzleIcon } from "lucide-react"
import { PluginsSection } from "@/components/settings/plugins-section"
import type { SettingsSection } from "./manifest"

export const section = {
  id: "plugins",
  title: "UI extensions",
  group: "Extensions",
  icon: PuzzleIcon,
  keywords: [
    "plugin",
    "extension",
    "hot-load",
    "command",
    "slot",
    "panel",
    "script",
  ],
  Component: PluginsSection,
} as const satisfies SettingsSection
