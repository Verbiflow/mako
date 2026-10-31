import { getMako } from "@/lib/bridge"
import { workedFolderRanks } from "@/lib/thread-folders"
import type { CloudAccount } from "@mako/host/contracts/cloud-account"
import { acpStore } from "@/state/acp-state"
import { selectAcpPresence, selectSessionOwners } from "@/state/acp-presence"
import { threadsStore } from "@/state/thread-store"

let offered = false

/**
 * Onboarding: once this Mac's account has the cloud, its recent projects, newest first, are offered for project bases,
 * so each one's first cloud Thread starts from a clone made ahead. The host offers once per account and remembers it
 * did; nothing is shown either way.
 */
export function offerCloudProjects(account: CloudAccount): void {
  if (offered || account.state.status !== "signed-in" || !account.state.account.entitlements.includes("cloud")) return
  offered = true
  const offer = () => void getMako().cloudOfferProjects(recentProjects()).catch(() => (offered = false))
  if (threadsStore.get().loaded) return offer()
  const stop = threadsStore.subscribe(() => {
    if (!threadsStore.get().loaded) return
    stop()
    offer()
  })
}

/** This Mac's projects in the rail's order (`workedFolderRanks`), by when the person last worked in each. */
function recentProjects(): string[] {
  const state = acpStore.get()
  const ranks = workedFolderRanks({
    refs: threadsStore.get().threads,
    live: selectAcpPresence(state).filter((presence) => presence.elsewhere === undefined),
    owners: selectSessionOwners(state),
  })
  return Object.entries(ranks)
    .filter(([folder]) => folder !== "~")
    .sort(([, left], [, right]) => right.localeCompare(left))
    .map(([folder]) => folder)
}
