// Isolated rendered check: an account event heard before the Toaster mounts.
import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { Toaster } from "@/components/ui/sonner"
import { heardAccountEvent } from "@/state/cloud-account"
import { installMockBridge } from "./mock-bridge"
import "../index.css"

installMockBridge()
window.mako!.onEvent(event => {
  if (event.type === "cloud-account-event") heardAccountEvent(event)
})
const root = createRoot(document.getElementById("root")!)
Reflect.set(window, "mountAccountToast", () => root.render(<StrictMode><Toaster /></StrictMode>))
