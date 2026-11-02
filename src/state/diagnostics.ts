import type { CrashReport } from "@mako/host/contracts/crash-report"
import type { ProviderResidencySnapshot } from "@mako/host/contracts/provider-residency"
import type { AgentsDiagnostics } from "@mako/host/contracts/agents"
import type { NativeRoutingReading } from "@mako/host/contracts/native-routing"
import type { SessionReaderHistory } from "@mako/host/contracts/session-reader"
import type { SyncReadings } from "@mako/host/contracts/sync-readings"
import type { ContinueReading } from "@mako/host/contracts/cloud-continues"
import type { UnreadReport } from "@mako/host/contracts/unread-records"
import { getMako } from "@/lib/bridge"

export const diagnostics = {
  list(): Promise<CrashReport[]> {
    return getMako().crashes()
  },

  directory(): Promise<string> {
    return getMako().crashesDir()
  },

  hostLogPath(): Promise<string> {
    return getMako().hostLogPath()
  },

  /** Each time the reader behind the session list stopped or started, and where it logs. */
  sessionReader(): Promise<SessionReaderHistory> {
    return getMako().sessionReaderHistory()
  },

  providerResidency(): Promise<ProviderResidencySnapshot> {
    return getMako().providerResidency()
  },

  /** The Threads other Threads started on this host, and each tree against its budgets. */
  agents(): Promise<AgentsDiagnostics | null> {
    return getMako().agentsDiagnostics()
  },

  /** Where each harness stands on a lead's native spawns. */
  nativeRouting(): Promise<NativeRoutingReading[]> {
    return getMako().nativeRouting()
  },

  /** How this Mac follows its other devices' work, and how long it takes to arrive. */
  syncReadings(): Promise<SyncReadings> {
    return getMako().syncReadings()
  },

  /** Each Continue in the cloud this Mac pressed or its account's list says, the latest first. */
  continueReadings(): Promise<ContinueReading[]> {
    return getMako().continueReadings()
  },

  /** Records Mako couldn't read, saved and live, by harness version. */
  unreadRecords(): Promise<UnreadReport> {
    return getMako().unreadRecords()
  },

  clear(): Promise<void> {
    return getMako().clearCrashes()
  },

  report(
    kind: "renderer-error" | "renderer-rejection",
    payload: { message: string; stack?: string; source?: string }
  ): Promise<void> {
    return getMako().reportCrash(kind, payload)
  },
}
