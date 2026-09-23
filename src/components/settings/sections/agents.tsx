import { BotIcon } from "lucide-react"
import { AgentsSection } from "@/components/settings/agents-section"
import type { SettingsSection } from "./manifest"

export const section = {
  id: "agents",
  title: "Agents",
  group: "Providers",
  icon: BotIcon,
  keywords: [
    "login",
    "capture",
    "switch",
    "usage",
    "plan",
    "account",
    "provider",
    "harness",
    "claude",
    "codex",
    "cursor",
    "grok",
    "devin",
    "opencode",
    "daemon",
    "sync",
    "conversion",
    "transcript replay",
  ],
  Component: AgentsSection,
} as const satisfies SettingsSection
