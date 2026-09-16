import type { CrashReport } from "../../electron/crash.ts"
import type { ProviderResidencySnapshot } from "../../electron/contracts/provider-residency.ts"
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

  providerResidency(): Promise<ProviderResidencySnapshot> {
    return getMako().providerResidency()
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
