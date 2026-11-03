import type { SimulatorSetup } from "../../contracts/simulator-setup.js"
import { setupStep } from "../../contracts/simulator-setup.js"
import type { SimulatorAvailability, SimulatorHostSummary, SimulatorsShot, SimulatorSummary } from "../../contracts/simulators.js"
import { SimulatorUnsupported, type SimulatorHost } from "./host.js"

/** Every operation past listing waits for a Mac with Xcode to be built and checked on, rather than being guessed at. */
const NOT_BUILT = "Driving a simulator on this Mac comes next: it's built once it can be checked against a real Xcode."

/**
 * This Mac, through Xcode's own tools. It reads what the setup line read (Xcode, its license, the runtime, Mako's two
 * simulators), so the panel, Settings and an agent's `simulator_list` say the same thing.
 */
export class LocalSimulatorHost implements SimulatorHost {
  readonly id = "local"
  readonly label = "This Mac"
  readonly kind = "local" as const
  readonly #setup: () => Promise<SimulatorSetup>

  constructor(setup: () => Promise<SimulatorSetup>) {
    this.#setup = setup
  }

  async summary(): Promise<SimulatorHostSummary> {
    const setup = await this.#setup()
    const xcode = setupStep(setup, "xcode")
    return {
      id: this.id,
      label: this.label,
      kind: this.kind,
      platforms: {
        ios: iosAvailability(setup),
        android: { ready: false, blocker: "not-built", why: "Android emulators come after iOS." },
      },
      ...(xcode && { detail: [xcode.developerDir && `developer folder ${xcode.developerDir}`, xcode.xcode && `Xcode ${xcode.xcode.version}${xcode.xcode.build ? ` (${xcode.xcode.build})` : ""}`].filter(Boolean).join(", ") }),
    }
  }

  async list(): Promise<SimulatorSummary[]> {
    const setup = await this.#setup()
    const runtime = setupStep(setup, "runtime")?.runtime
    return (setupStep(setup, "simulators")?.simulators ?? []).flatMap((simulator): SimulatorSummary[] =>
      simulator.udid
        ? [{ hostId: this.id, id: simulator.udid, name: simulator.name, platform: "ios", runtime: runtime?.name ?? simulator.runtime ?? "iOS", form: simulator.form, state: simulator.state ?? "shutdown" }]
        : []
    )
  }

  boot(): Promise<void> {
    return this.#refuse()
  }

  act(): Promise<void> {
    return this.#refuse()
  }

  read(): Promise<{ state: unknown }> {
    return this.#refuse()
  }

  screenshot(): Promise<SimulatorsShot> {
    return this.#refuse()
  }

  record(): Promise<{ path?: string }> {
    return this.#refuse()
  }

  async #refuse(): Promise<never> {
    const ios = iosAvailability(await this.#setup())
    throw new SimulatorUnsupported(ios.ready ? NOT_BUILT : ios.why)
  }
}

/** Whether this Mac can run an iPhone simulator, and if not the first thing missing, from the setup line. */
export function iosAvailability(setup: SimulatorSetup): SimulatorAvailability {
  if (setup.phase === "unavailable") return { ready: false, blocker: "not-macos", why: "iPhone and iPad simulators run on macOS alone." }
  if (setupStep(setup, "xcode")?.state !== "done") return { ready: false, blocker: "no-xcode", why: "This Mac has no Xcode, so no iOS Simulator.", fix: "Settings › Simulators" }
  if (setupStep(setup, "finish")?.state !== "done") return { ready: false, blocker: "no-xcode", why: "Xcode's first-run setup isn't finished.", fix: "Settings › Simulators" }
  if (setupStep(setup, "runtime")?.state !== "done") return { ready: false, blocker: "no-runtime", why: "Xcode has no iOS simulator runtime yet.", fix: "Settings › Simulators" }
  return { ready: false, blocker: "not-built", why: NOT_BUILT }
}
