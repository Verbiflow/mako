import { CpuIcon } from "lucide-react"
import { ModelsSection } from "@/components/settings/models-section"
import type { SettingsSection } from "./manifest"

export const section = {
  id: "models",
  title: "Models",
  group: "Providers",
  icon: CpuIcon,
  keywords: ["model", "loadout", "effort", "fast", "default", "picker"],
  Component: ModelsSection,
} as const satisfies SettingsSection
