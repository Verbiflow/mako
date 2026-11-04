import type { MethodTable } from "../../base/methods.js"
import { hostClient } from "../../base/host-client.js"
import type { SetupFix } from "../../contracts/simulator-setup.js"
import type {
  SimulatorCaller,
  SimulatorsActInput,
  SimulatorsOpenInput,
  SimulatorsReadInput,
  SimulatorsRecordInput,
  SimulatorsReleaseInput,
  SimulatorsShotInput,
  SimulatorsWatchInput,
} from "../../contracts/simulators.js"
import type { SimulatorSetupFollower } from "./setup.js"
import type { Simulators } from "./simulators.js"

/** What `gatewayClientId` names a caller through the gateway: `gateway:<client kind>:<device>` or `gateway:runtime:<runtime>`. */
const THROUGH_GATEWAY = "gateway:"

/**
 * The caller as this host knows it: one whose call came through the gateway is from another of the account's devices
 * or machines, whatever it says, and carries which (`via`); one from this Mac's own windows and doors carries none.
 */
export function stampedCaller(caller: SimulatorCaller, client = hostClient()): SimulatorCaller {
  const rest =
    caller.kind === "agent"
      ? { kind: "agent" as const, session: caller.session, ...(caller.agent && { agent: caller.agent }) }
      : { kind: "person" as const }
  return client.startsWith(THROUGH_GATEWAY) ? { ...rest, via: { from: client.slice(THROUGH_GATEWAY.length) } } : rest
}

/** Settings › Simulators' setup line, and `mako:simulators-<verb>`: every door's one way to a simulator. */
export function declareSimulatorMethods(methods: MethodTable, setup: Pick<SimulatorSetupFollower, "read" | "press">, simulators: Simulators): void {
  methods.handle("mako:simulator-setup", (refresh?: boolean) => setup.read(refresh === true))
  methods.handle("mako:simulator-setup-press", (fix: SetupFix, input?: { folder?: string; allowed?: boolean }) => setup.press(fix, input))
  methods.handle("mako:simulators-list", (caller: SimulatorCaller) => simulators.list(stampedCaller(caller)))
  methods.handle("mako:simulators-open", (caller: SimulatorCaller, input: SimulatorsOpenInput) => simulators.open(stampedCaller(caller), input))
  methods.handle("mako:simulators-act", (caller: SimulatorCaller, input: SimulatorsActInput) => simulators.act(stampedCaller(caller), input))
  methods.handle("mako:simulators-read", (caller: SimulatorCaller, input: SimulatorsReadInput) => simulators.read(stampedCaller(caller), input))
  methods.handle("mako:simulators-shot", (caller: SimulatorCaller, input: SimulatorsShotInput) => simulators.shot(stampedCaller(caller), input))
  methods.handle("mako:simulators-record", (caller: SimulatorCaller, input: SimulatorsRecordInput) => simulators.record(stampedCaller(caller), input))
  methods.handle("mako:simulators-release", (caller: SimulatorCaller, input: SimulatorsReleaseInput) => simulators.release(stampedCaller(caller), input))
  methods.handle("mako:simulators-watch", (caller: SimulatorCaller, input: SimulatorsWatchInput) => simulators.watch(stampedCaller(caller), input))
}
