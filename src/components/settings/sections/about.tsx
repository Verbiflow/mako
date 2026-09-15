import { AboutSection } from "@/components/settings/about-section"
import type { SettingsSection } from "@/components/settings/sections/manifest"

export const section = {
  id: "about",
  title: "About",
  group: "Application",
  keywords: ["version", "github", "source available", "license", "alpha", "apple silicon"],
  Component: AboutSection,
} as const satisfies SettingsSection
