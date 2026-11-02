import { HardDriveIcon } from "lucide-react"
import { StorageSection } from "@/components/settings/storage-section"
import type { SettingsSection } from "./manifest"

export const section = {
  id: "storage",
  title: "Storage",
  group: "Application",
  icon: HardDriveIcon,
  keywords: [
    "disk",
    "space",
    "full",
    "free up",
    "size",
    "gigabytes",
    "clean up",
    "Cursor",
    "checkpoints",
    "records",
  ],
  Component: StorageSection,
} as const satisfies SettingsSection
