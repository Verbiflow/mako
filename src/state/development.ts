import { acpStore } from "@/state/acp-state"
import { getMako, hasBridge } from "@/lib/bridge"
import { toast } from "sonner"

export const manualReload = import.meta.env.DEV && import.meta.env.MAKO_MANUAL_RELOAD === true
export const interfacePreview = new URLSearchParams(globalThis.location?.search).has("preview")
export const sharedRuntime = new URLSearchParams(globalThis.location?.search).get("runtime") === "shared" ||
  (!import.meta.env.DEV && /^https?:$/.test(globalThis.location?.protocol ?? ""))
export const sandboxProfile = new URLSearchParams(globalThis.location?.search).get("profile")

export function reloadInterface(): void {
  sessionStorage.setItem("mako:reload-conversation", acpStore.get().activeKey ?? "new")
  location.reload()
}

export async function openInterfacePreview(): Promise<void> {
  if (hasBridge()) {
    try {
      await getMako().openPreviewWindow()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    }
    return
  }
  const url = new URL(location.href)
  url.searchParams.set("preview", crypto.randomUUID())
  window.open(url.href, "_blank", "noopener")
}
