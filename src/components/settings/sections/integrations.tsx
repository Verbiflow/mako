import { PlugIcon } from "lucide-react"
import { IntegrationsSection } from "@/components/settings/integrations-section"
import type { SettingsSection } from "./manifest"

export const section = {
  id: "integrations",
  title: "Integrations",
  group: "Extensions",
  icon: PlugIcon,
  keywords: [
    "slack",
    "gmail",
    "google",
    "calendar",
    "linear",
    "github",
    "jira",
    "atlassian",
    "notion",
    "teams",
    "sentry",
    "messages",
    "mail",
    "browser",
    "computer",
    "connectors",
  ],
  Component: IntegrationsSection,
} as const satisfies SettingsSection
