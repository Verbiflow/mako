import { ShieldIcon } from "lucide-react"
import { PrivacySection } from "@/components/settings/privacy-section"
import type { SettingsSection } from "./manifest"

export const section = {
  id: "privacy",
  title: "Privacy",
  group: "Application",
  icon: ShieldIcon,
  keywords: ["telemetry", "analytics", "usage", "error reports", "tracking", "data", "privacy", "opt out"],
  Component: PrivacySection,
} as const satisfies SettingsSection
