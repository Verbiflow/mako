import type { TelemetryChoice, TelemetryState } from "@mako/host/contracts/telemetry"
import { getMako } from "@/lib/bridge"

export const telemetry = {
  state(): Promise<TelemetryState> {
    return getMako().telemetry()
  },

  choose(choice: Partial<TelemetryChoice>): Promise<TelemetryState> {
    return getMako().chooseTelemetry(choice)
  },
}
