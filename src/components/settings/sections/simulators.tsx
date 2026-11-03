import { SmartphoneIcon } from "lucide-react"
import { SimulatorsSection } from "@/components/settings/simulators-section"
import type { SettingsSection } from "./manifest"

export const section = {
  id: "simulators",
  title: "Simulators",
  group: "Extensions",
  icon: SmartphoneIcon,
  keywords: ["simulator", "iphone", "ipad", "ios", "xcode", "safari", "mobile", "phone", "tablet", "devices", "runtime"],
  Component: SimulatorsSection,
} as const satisfies SettingsSection
