import { ScrollTextIcon } from "lucide-react"
import { SkillsSection } from "@/components/settings/skills-section"
import type { SettingsSection } from "@/components/settings/sections/manifest"

export const section: SettingsSection = {
  id: "skills",
  title: "Skills",
  group: "Extensions",
  icon: ScrollTextIcon,
  keywords: [
    "agent skills",
    "SKILL.md",
    "agents",
    "claude",
    "codex",
    "cursor",
    "grok",
    "devin",
    "sync",
    "global",
    "project",
  ],
  Component: SkillsSection,
}
