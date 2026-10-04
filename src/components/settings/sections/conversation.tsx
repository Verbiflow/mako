import { MessagesSquareIcon } from "lucide-react"
import { ConversationSection } from "@/components/settings/conversation-section"
import type { SettingsSection } from "./manifest"

export const section = {
  id: "transcript",
  title: "Conversation",
  group: "Desk",
  icon: MessagesSquareIcon,
  keywords: [
    "transcript",
    "reasoning",
    "thinking",
    "diff",
    "changes",
    "turns",
    "steer",
    "queue",
    "enter",
    "title",
    "name",
    "rename",
    "light model",
  ],
  Component: ConversationSection,
} as const satisfies SettingsSection
