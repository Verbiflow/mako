import type { SetupFix, SimulatorSetup } from "@mako/host/contracts/simulator-setup"
import { getMako, hasBridge } from "@/lib/bridge"
import { createHook, createStore } from "@/state/store"

/**
 * Settings › Simulators, as the host follows it (`mako:simulator-setup`, then its `simulator-setup` events): this
 * store only mirrors the line, so every window says the same. Each step is read from Xcode's own tools on the host;
 * nothing here decides a step is done.
 */
interface SimulatorSetupState {
  setup?: SimulatorSetup
  reading: boolean
  /** The press under way, until the host answers it. */
  pressing?: SetupFix
  /** A press the host couldn't take at all; a step that ran and failed says so in `setup.failure`. */
  refused?: string
}

export const simulatorSetupStore = createStore<SimulatorSetupState>({ reading: false })
export const useSimulatorSetup = createHook(simulatorSetupStore)

export const simulatorSetup = {
  /** Read once, or again when `refresh`, as on coming back to the window after installing Xcode. */
  load(refresh = false) {
    if (!hasBridge() || simulatorSetupStore.get().reading || (simulatorSetupStore.get().setup && !refresh)) return
    simulatorSetupStore.set({ reading: true })
    void getMako()
      .simulatorSetup(refresh)
      .then((setup) => simulatorSetupStore.set({ setup }))
      .catch(() => undefined)
      .finally(() => simulatorSetupStore.set({ reading: false }))
  },

  heard(setup: SimulatorSetup) {
    simulatorSetupStore.set({ setup })
  },

  async press(fix: SetupFix, input?: { folder?: string; allowed?: boolean }) {
    if (simulatorSetupStore.get().pressing) return
    simulatorSetupStore.set({ pressing: fix, refused: undefined })
    try {
      simulatorSetupStore.set({ setup: await getMako().simulatorSetupPress(fix, input) })
    } catch (error) {
      simulatorSetupStore.set({ refused: error instanceof Error ? error.message : String(error) })
    } finally {
      simulatorSetupStore.set({ pressing: undefined })
    }
  },
}
