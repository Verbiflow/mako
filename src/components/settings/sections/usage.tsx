import { GaugeIcon } from "lucide-react"
import { UsageSection } from "@/components/settings/usage-section"
import type { SettingsSection } from "./manifest"

export const section = {
  id: "usage",
  title: "Usage",
  group: "Providers",
  icon: GaugeIcon,
  keywords: [
    "cost",
    "spend",
    "money",
    "tokens",
    "billing",
    "price",
    "model",
    "project",
    "limits",
  ],
  Component: UsageSection,
} as const satisfies SettingsSection
