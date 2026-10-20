import { getMako } from "@/lib/bridge"
import type { CloudAccount } from "@mako/host/contracts/cloud-account"
import { prefsStore } from "@/state/prefs"

let offered = false

/**
 * Onboarding: once this Mac's account has the cloud, its recent projects, newest first, are offered for project bases,
 * so each one's first cloud Thread starts from a clone made ahead. The host offers once per account and remembers it
 * did; nothing is shown either way.
 */
export function offerCloudProjects(account: CloudAccount): void {
  if (offered || account.state.status !== "signed-in" || !account.state.account.entitlements.includes("cloud")) return
  offered = true
  const folders = Object.entries(prefsStore.get().folderUse)
    .sort(([, left], [, right]) => right.localeCompare(left))
    .map(([folder]) => folder)
  void getMako().cloudOfferProjects(folders).catch(() => (offered = false))
}
