import { CameraIcon } from "lucide-react"
import { AppshotsSection } from "@/components/settings/appshots-section"
import type { SettingsSection } from "./manifest"

export const section = {
  id: "appshots",
  title: "Appshots",
  group: "Desk",
  icon: CameraIcon,
  keywords: [
    "appshot",
    "capture",
    "window",
    "screenshot",
    "shortcut",
    "hotkey",
    "shift",
    "screen recording",
    "accessibility",
    "permission",
  ],
  Component: AppshotsSection,
} as const satisfies SettingsSection
