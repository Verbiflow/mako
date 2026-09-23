import { SquareCodeIcon } from "lucide-react"
import { EditorSection } from "@/components/settings/editor-section"
import type { SettingsSection } from "@/components/settings/sections/manifest"

export const section = {
  id: "editor",
  title: "Editor",
  group: "Desk",
  icon: SquareCodeIcon,
  keywords: [
    "zed",
    "cursor",
    "visual studio code",
    "vscode",
    "windsurf",
    "sublime",
    "xcode",
    "open file",
  ],
  Component: EditorSection,
} as const satisfies SettingsSection
