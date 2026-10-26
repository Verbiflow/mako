import { homedir } from "node:os"
import { join } from "node:path"
import type { MethodTable } from "../base/methods.js"
import { UsageReader } from "./reader.js"
import { helperRunsRoot } from "./helper-runs.js"
import type { HostEvent } from "../contracts/host-events-boot.js"
import { classifyProviderFailure, type ProviderFailureKind } from "../contracts/provider-failure.js"

export { declareTelemetryMethods } from "./telemetry-methods.js"
export { declareCloudAccountMethods, type CloudAccount, type ThreadListHeard } from "./cloud-account-methods.js"
export type { CloudThreadMaking } from "./cloud-account.js"
export type { MachineRuntime, MachineGatewayLink } from "./machine-runtime.js"
export { MachineWorkspace, WORKSPACE_RETRY_MS, type MachineWorkspaceOutcome } from "./machine-workspace.js"
/** A cloud machine's runtime, loaded only by a host its machine's agent started. */
export const loadMachineRuntime = () => import("./machine-runtime.js")
export type { HostTelemetry } from "./host-telemetry.js"
export { usageSummary, type UsageHarness } from "./summary.js"
export { UsageLedger } from "./ledger.js"
export { HelperRuns, helperRunsRoot, helperSource } from "./helper-runs.js"
export { UsageWorkerDataSchema, type UsageWorkerReply } from "./worker-contract.js"
export { priceEstimate, type UsageTokenCounts } from "./pricing.js"
export {
  fingerprint,
  parseObject,
  tokenTotal,
  usageCounts,
  validTimestamp,
  yieldToMain,
  type JsonlReader,
  type ProviderUsageHistory,
  type UsageEvent,
  type UsageScan,
} from "./scan.js"

/** A session write older than this is the catalog catching up, not use. */
const RECENT_WRITE_MS = 2 * 60_000
/** A harness busy outside Mako writes constantly; its limits are read again at most this often. */
const STORE_SPEND_THROTTLE_MS = 60_000

/** The usage ledger, opened by the first `mako:usage` call. */
export interface Usage {
  close(): Promise<void>
}

export interface UsageDeps {
  dataRoot: string
  /** `HostEnvironment.userRoot`, whose `sessions` the built-in runtime's old sessions were kept in. */
  userRoot: string
  /** The script the ledger is read in, off the host; see `UsageReader`. */
  worker: URL
  /** Whether the worker opens the harnesses' stores strictly (`NativeStores`). */
  strictStores: boolean
}

export function declareUsageMethods(methods: MethodTable, { dataRoot, userRoot, worker, strictStores }: UsageDeps): Usage {
  let reader: UsageReader | undefined
  methods.handle("mako:usage", () => {
    reader ??= new UsageReader(worker, {
      ledgerPath: join(dataRoot, "usage-ledger.sqlite"),
      strictStores,
      sessionsRoot: join(userRoot, "sessions"),
      homeRoot: homedir(),
      conversationsRoot: join(dataRoot, "conversations"),
      helperRuns: helperRunsRoot(dataRoot),
    })
    return reader.read()
  })
  return { close: async () => reader?.close() }
}

/**
 * Every harness's turn ends here, live or headless; its limits moved. So
 * does any write to its session store, from Mako or a terminal elsewhere.
 * Returns the event to send when a harness's limits are worth reading again:
 * `spent` drops its readings and says whether, at most once per `throttle` ms.
 * `turnEnded` hears every live turn's end, with whether the harness refused
 * it on a limit or the plan, so another account can be offered.
 */
export function spendWatch(
  harnessOf: (conversationId: string) => string | undefined,
  spent: (harness: string, throttle?: number) => boolean,
  turnEnded?: (harness: string, refused: boolean) => void,
): (event: HostEvent) => HostEvent | undefined {
  /** Live sessions mid-turn, by id, with the harness that is spending. */
  const spending = new Map<string, string>()
  return (event) => {
    let ended: string | undefined
    let throttle: number | undefined
    const session = event.type === "live-batch" ? event.batch.session ?? event.batch.sessionChanges : undefined
    const status = session?.status
    if (event.type === "live-batch" && status) {
      const harness = event.batch.session?.harness ?? harnessOf(event.batch.id)
      if (status === "running" && harness) spending.set(event.batch.id, harness)
      else if (status !== "running") {
        ended = spending.get(event.batch.id)
        spending.delete(event.batch.id)
        if (ended) turnEnded?.(ended, status === "failed" && LIMIT_FAILURES.has(classifyProviderFailure(session.error).kind))
      }
    } else if (event.type === "thread-run" && event.run.status !== "running") {
      ended = event.run.harness
    } else if (event.type === "thread-ref" && Date.now() - Date.parse(event.ref.updatedAt ?? "") < RECENT_WRITE_MS) {
      ended = event.ref.harness
      throttle = STORE_SPEND_THROTTLE_MS
    }
    return ended !== undefined && spent(ended, throttle) ? { type: "account-usage-spent", harness: ended } : undefined
  }
}

/** Failures that say the account ran out: its rate or usage limit, or what its plan allows. */
const LIMIT_FAILURES: ReadonlySet<ProviderFailureKind> = new Set(["rate-limited", "plan"])
