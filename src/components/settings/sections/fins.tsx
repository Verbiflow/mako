import { WorkflowIcon } from "lucide-react"
import { FinsSection } from "@/components/settings/fins-section"
import type { SettingsSection } from "./manifest"

export const section = {
  id: "fins",
  title: "Fins",
  group: "Providers",
  icon: WorkflowIcon,
  keywords: ["fin", "fins", "apex", "agents", "subagent", "delegate", "orchestration", "model", "reasoning", "effort", "fast", "speed", "default"],
  perHarness: true,
  Component: FinsSection,
} as const satisfies SettingsSection
