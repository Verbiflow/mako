import { MonitorSmartphoneIcon } from "lucide-react"
import { DevicesSection } from "@/components/settings/devices-section"
import type { SettingsSection } from "./manifest"

export const section = {
  id: "devices",
  title: "Devices",
  group: "Application",
  icon: MonitorSmartphoneIcon,
  keywords: ["devices", "machine", "linux", "server", "add a machine", "mako-host", "join", "docker", "remove device", "online", "quiet", "mac"],
  Component: DevicesSection,
} as const satisfies SettingsSection
