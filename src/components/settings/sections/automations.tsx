import { WorkflowIcon } from "lucide-react"
import { AutomationsSection } from "@/components/settings/automations-section"
import type { SettingsSection } from "./manifest"

export const section = {
  id: "automations",
  title: "Automations",
  group: "Project",
  icon: WorkflowIcon,
  keywords: [
    "prompt",
    "trigger",
    "manual",
    "files",
    "commit",
    "run",
    "schedule",
    "background",
  ],
  Component: AutomationsSection,
} as const satisfies SettingsSection
