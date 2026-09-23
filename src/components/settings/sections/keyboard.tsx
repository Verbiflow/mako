import { KeyboardIcon } from "lucide-react"
import { KeyboardSection } from "@/components/settings/keyboard-section"
import type { SettingsSection } from "./manifest"

export const section = {
  id: "keyboard",
  title: "Keyboard shortcuts",
  group: "Desk",
  icon: KeyboardIcon,
  keywords: [
    "keys",
    "shortcut",
    "binding",
    "chord",
    "hotkey",
    "command",
    "rebind",
  ],
  Component: KeyboardSection,
} as const satisfies SettingsSection
