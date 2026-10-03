import { FileCodeIcon } from "lucide-react"
import { NativeAuthoringSection } from "@/components/settings/native-authoring-section"
import type { SettingsSection } from "./manifest"

export const section = {
  id: "native-authoring", title: "Hooks and commands", group: "Providers", icon: FileCodeIcon,
  keywords: ["native", "hook", "command", "instructions", "configuration"], Component: NativeAuthoringSection,
} as const satisfies SettingsSection
