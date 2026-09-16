import { DiagnosticsSection } from "@/components/settings/diagnostics-section"
import type { SettingsSection } from "./manifest"

export const section = {
  id: "diagnostics",
  title: "Diagnostics",
  group: "Application",
  keywords: [
    "crash",
    "error",
    "stack",
    "troubleshoot",
    "report",
    "diagnostics",
    "logs",
  ],
  Component: DiagnosticsSection,
} as const satisfies SettingsSection
