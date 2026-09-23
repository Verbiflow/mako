import { DownloadIcon } from "lucide-react"
import { UpdatesSection } from "@/components/settings/updates-section"
import type { SettingsSection } from "./manifest"

export const section = {
  id: "updates",
  title: "Updates",
  group: "Application",
  icon: DownloadIcon,
  keywords: [
    "version",
    "install",
    "download",
    "release",
    "notes",
    "check",
    "restart",
  ],
  Component: UpdatesSection,
} as const satisfies SettingsSection
