import { AppearanceSection } from "@/components/settings/appearance-section"
import type { SettingsSection } from "./manifest"

export const section = {
  id: "appearance",
  title: "Appearance",
  group: "Desk",
  keywords: ["theme", "dark", "light", "auto", "system", "color"],
  Component: AppearanceSection,
} as const satisfies SettingsSection
