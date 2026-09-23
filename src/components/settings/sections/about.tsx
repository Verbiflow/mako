import { InfoIcon } from "lucide-react"
import { AboutSection } from "@/components/settings/about-section"
import type { SettingsSection } from "@/components/settings/sections/manifest"

export const section = {
  id: "about",
  title: "About",
  group: "Application",
  icon: InfoIcon,
  keywords: ["version", "github", "source available", "license", "alpha", "apple silicon"],
  Component: AboutSection,
} as const satisfies SettingsSection
