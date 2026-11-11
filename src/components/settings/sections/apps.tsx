import { AppWindowIcon } from "lucide-react"
import { AppsSection } from "@/components/settings/apps-section"
import { APPS_SECTION, appSetupStore } from "@/state/app-setup"
import type { SettingsSection } from "./manifest"

const SETUP_KEYWORDS = ["setup", "set up", "drive", "files", "packages", "grants", "credentials", "secrets", ".env", "environment", "carry", "linked"]

export const section = {
  id: APPS_SECTION,
  title: "Apps",
  group: "Project",
  icon: AppWindowIcon,
  keywords: [
    "app",
    "run",
    "recipe",
    ...SETUP_KEYWORDS,
    "install",
    "checks",
    "port",
  ],
  onSearch: (query) => appSetupStore.set({ tab: SETUP_KEYWORDS.some((keyword) => keyword.includes(query)) ? "setup" : "recipe" }),
  Component: AppsSection,
} as const satisfies SettingsSection
