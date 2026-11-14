import { useState } from "react"
import { createRoot } from "react-dom/client"
import { OceanScene } from "@/components/ui/ocean-scene"
import { SettingsDialog } from "@/components/settings/settings-dialog"
import { installMockBridge } from "./mock-bridge"
import "../index.css"

installMockBridge()

export function PerformanceScene() {
  const [open, setOpen] = useState(false)
  const [section, setSection] = useState("appearance")
  return (
    <main className="agent-surface relative isolate h-full p-8">
      <OceanScene animated />
      <button data-perf-open className="pressable bg-raised p-3" onClick={() => setOpen(true)}>Open settings</button>
      <SettingsDialog open={open} section={section} onOpenChange={setOpen} onSectionChange={setSection} />
    </main>
  )
}

createRoot(document.getElementById("root")!).render(<PerformanceScene />)
