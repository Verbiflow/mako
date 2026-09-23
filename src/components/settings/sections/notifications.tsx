import { BellIcon } from "lucide-react"
import { NotificationsSection } from "@/components/settings/notifications-section"
import type { SettingsSection } from "./manifest"

export const section = {
  id: "notifications",
  title: "Notifications",
  group: "Desk",
  icon: BellIcon,
  keywords: [
    "notifications",
    "alerts",
    "banner",
    "badge",
    "dock",
    "sound",
    "audio",
    "volume",
    "unread",
  ],
  Component: NotificationsSection,
} as const satisfies SettingsSection
