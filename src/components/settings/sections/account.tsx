import { CircleUserRoundIcon } from "lucide-react"
import { AccountSection } from "@/components/settings/account-section"
import type { SettingsSection } from "./manifest"

export const section = {
  id: "account",
  title: "Account",
  group: "Application",
  icon: CircleUserRoundIcon,
  keywords: ["sign in", "sign out", "log in", "mako account", "devices", "cloud", "github", "google"],
  Component: AccountSection,
} as const satisfies SettingsSection
