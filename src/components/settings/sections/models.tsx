import { CpuIcon } from "lucide-react"
import { ModelsSection } from "@/components/settings/models-section"
import type { SettingsSection } from "./manifest"

export const section = {
  id: "models",
  title: "Models",
  group: "Providers",
  icon: CpuIcon,
  keywords: ["model", "loadout", "effort", "reasoning", "fast", "default", "recommended", "picker", "harness", "order", "setup",
    "draft", "drafting", "drafting model", "commit message", "light model", "Automatic", "depth", "deep",
    "API key", "connection", "Google", "Gemini", "OpenAI", "Anthropic", "OpenAI-compatible", "local model"],
  Component: ModelsSection,
} as const satisfies SettingsSection
