import { toast } from "sonner"
import { getMako, hasBridge } from "@/lib/bridge"
import type { ExternalEditor } from "@/lib/types"
import { store } from "@/state/session"

export const desktop = {
  available(): boolean {
    return hasBridge()
  },

  /** Whether the host's machine has a file manager to show a path in. Components use `IfCanReveal`. */
  canReveal(): boolean {
    return store.get().machine.fileManager !== null
  },

  openUrl(url: string): Promise<void> {
    return getMako().openUrl(url)
  },

  /** Shows the path in the host's file manager; where there is none, says why instead of failing. */
  async revealPath(path: string): Promise<void> {
    const { machine } = store.get()
    if (machine.fileManager === null) {
      toast(machine.missing ?? "This machine has no file manager to show it in.", { id: "machine-missing" })
      return
    }
    return getMako().revealPath(path)
  },

  externalEditors(): Promise<ExternalEditor[]> {
    return getMako().externalEditors()
  },

  openInEditor(path: string, editor?: string): Promise<void> {
    return getMako().openInEditor(path, editor)
  },
}
