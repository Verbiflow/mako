import { useEffect } from "react"
import type { SetupView } from "@mako/host/contracts/setup"
import { readSetup, useSetup } from "@/state/setup"

/** Reads the folder's Setup when shown, and again when the window comes back to the front. */
export type SetupViewRead = { view: SetupView | undefined; failed: string | undefined }

export function useSetupView(folder: string | undefined): SetupViewRead {
  const view = useSetup((state) => (folder ? state.byFolder[folder] : undefined))
  const failed = useSetup((state) => (folder ? state.failed[folder] : undefined))
  useEffect(() => {
    if (!folder) return
    void readSetup(folder)
    const again = () => {
      if (document.visibilityState === "visible") void readSetup(folder)
    }
    window.addEventListener("focus", again)
    return () => window.removeEventListener("focus", again)
  }, [folder])
  return { view, failed }
}
