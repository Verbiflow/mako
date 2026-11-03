import type { MethodTable } from "../../base/methods.js"
import type { SetupFix } from "../../contracts/simulator-setup.js"
import type {
  SimulatorCaller,
  SimulatorsActInput,
  SimulatorsOpenInput,
  SimulatorsReadInput,
  SimulatorsRecordInput,
  SimulatorsReleaseInput,
  SimulatorsShotInput,
} from "../../contracts/simulators.js"
import type { SimulatorSetupFollower } from "./setup.js"
import type { Simulators } from "./simulators.js"

/** Settings › Simulators' setup line, and `mako:simulators-<verb>`: every door's one way to a simulator. */
export function declareSimulatorMethods(methods: MethodTable, setup: SimulatorSetupFollower, simulators: Simulators): void {
  methods.handle("mako:simulator-setup", (refresh?: boolean) => setup.read(refresh === true))
  methods.handle("mako:simulator-setup-press", (fix: SetupFix, input?: { folder?: string; allowed?: boolean }) => setup.press(fix, input))
  methods.handle("mako:simulators-list", (caller: SimulatorCaller) => simulators.list(caller))
  methods.handle("mako:simulators-open", (caller: SimulatorCaller, input: SimulatorsOpenInput) => simulators.open(caller, input))
  methods.handle("mako:simulators-act", (caller: SimulatorCaller, input: SimulatorsActInput) => simulators.act(caller, input))
  methods.handle("mako:simulators-read", (caller: SimulatorCaller, input: SimulatorsReadInput) => simulators.read(caller, input))
  methods.handle("mako:simulators-shot", (caller: SimulatorCaller, input: SimulatorsShotInput) => simulators.shot(caller, input))
  methods.handle("mako:simulators-record", (caller: SimulatorCaller, input: SimulatorsRecordInput) => simulators.record(caller, input))
  methods.handle("mako:simulators-release", (caller: SimulatorCaller, input: SimulatorsReleaseInput) => simulators.release(caller, input))
}
