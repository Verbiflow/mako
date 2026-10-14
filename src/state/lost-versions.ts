import { toast } from "sonner"
import type { LostVersion } from "@mako/host/contracts/thread-changes"
import { getMako, hasBridge } from "@/lib/bridge"

/** Versions of a Thread's files Mako kept from the last 14 days that the disk no longer has; none without a host. */
export async function lostVersions(thread: string): Promise<LostVersion[]> {
  if (!hasBridge()) return []
  return getMako().lostVersions({ thread }).catch(() => [])
}

/** Write a kept version back; what the file holds now is kept the same way. Says how it went. */
export async function restoreVersion(version: LostVersion): Promise<boolean> {
  try {
    const { path } = await getMako().restoreVersion(version.root, version.entry)
    toast(`Restored ${path.split("/").at(-1) ?? path}`, { description: "What the file held before is kept too, so this can be undone the same way." })
    return true
  } catch (error) {
    toast.error("Mako couldn't restore that version", { description: error instanceof Error ? error.message : String(error) })
    return false
  }
}
