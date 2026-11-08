import { CpuIcon } from "lucide-react"
import { ModelsSection } from "@/components/settings/models-section"
import type { SettingsSection } from "./manifest"

export const section = {
  id: "models",
  title: "Models",
  group: "Providers",
  icon: CpuIcon,
  keywords: ["model", "loadout", "effort", "reasoning", "fast", "default", "recommended", "picker", "harness", "order", "setup", "connection", "subscription", "gateway", "api key", "openrouter", "bedrock", "local", "ollama", "lm studio", "endpoint"],
  Component: ModelsSection,
} as const satisfies SettingsSection
