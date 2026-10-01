import { AppWindowIcon } from "lucide-react"
import { AppsSection } from "@/components/settings/apps-section"
import { APPS_SECTION } from "@/state/app-setup"
import type { SettingsSection } from "./manifest"

export const section = {
  id: APPS_SECTION,
  title: "Apps",
  group: "Project",
  icon: AppWindowIcon,
  keywords: [
    "app",
    "run",
    "recipe",
    "setup",
    "set up",
    "install",
    "checks",
    "port",
    "credentials",
    "secrets",
    ".env",
    "environment",
  ],
  Component: AppsSection,
} as const satisfies SettingsSection
