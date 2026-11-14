import { join, resolve } from "node:path"
import { HostJobs } from "../../packages/host/src/base/host-jobs.ts"
import { setupStep, type SetupFix, type SimulatorSetup } from "../../packages/host/src/contracts/simulator-setup.ts"
import type { SimulatorSummary } from "../../packages/host/src/contracts/simulators.ts"
import { iosAvailability, LocalSimulatorHost, localDriving } from "../../packages/host/src/control/simulators/local-host.ts"
import { SimulatorSetupFollower } from "../../packages/host/src/control/simulators/setup.ts"

/*
 * This Mac's simulators for the mobile-behavior runner, through the same host the app runs: the runner loads it with
 * tsx (`tsImport`), since it runs host source, while the runner itself stays plain Node for what it sends the page.
 */

export interface LocalSimulators {
  host: LocalSimulatorHost
  /** Mako's iPhone and iPad, as the host lists them. */
  simulators: SimulatorSummary[]
  /** Each one's device type, by its UDID, as setup made it. */
  types: ReadonlyMap<string, string>
  close(): Promise<void>
}

/** The steps the runner may take for the person: those that need no password and no App Store. */
const RUNNER_FIXES: readonly SetupFix[] = ["install-tools", "create-simulators"]

/**
 * The host over `dataRoot` (its own tools and hub, not the app's), once its setup line says it can run: the tools are
 * installed and Mako's two simulators made if they aren't. Otherwise the line's reason it can't.
 */
export async function localSimulators(dataRoot: string, say: (line: string) => void): Promise<LocalSimulators | { blocked: string }> {
  const setup = new SimulatorSetupFollower({ dataRoot, jobs: new HostJobs(), emit: () => undefined })
  let line: SimulatorSetup = await setup.read(true)
  const before = iosAvailability(line)
  if (!before.ready && before.blocker !== "no-tools") {
    setup.stop()
    return { blocked: before.why }
  }
  for (const fix of RUNNER_FIXES) {
    if (!line.steps.some((step) => "fix" in step && step.fix === fix && step.state === "yours")) continue
    say(fix === "install-tools" ? "Installing the simulator tools…" : "Making Mako's iPhone and iPad…")
    await setup.press(fix)
    await setup.settled()
    line = await setup.read(true)
  }
  const availability = iosAvailability(line)
  if (!availability.ready) {
    setup.stop()
    return { blocked: line.failure?.message ?? availability.why }
  }
  const host = new LocalSimulatorHost({
    setup: (refresh) => setup.read(refresh),
    folder: join(dataRoot, "simulators"),
    driving: localDriving({ dataRoot, hub: { entry: resolve("electron/simulator-hub-entry.ts"), execArgv: ["--import", "tsx"] } }),
  })
  const made = setupStep(line, "simulators")?.simulators ?? []
  return {
    host,
    simulators: await host.list(),
    types: new Map(made.flatMap((simulator) => (simulator.udid ? [[simulator.udid, simulator.type] as const] : []))),
    async close() {
      await host.close()
      setup.stop()
    },
  }
}
