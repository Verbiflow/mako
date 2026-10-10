import { homedir } from "node:os"
import { join } from "node:path"
import type { MethodTable } from "../base/methods.js"
import { UsageReader } from "./reader.js"
import type { HostEvent } from "../contracts/host-events-boot.js"

export { declareTelemetryMethods } from "./telemetry-methods.js"
export { declareCloudAccountMethods, type CloudAccount } from "./cloud-account-methods.js"
export type { HostTelemetry } from "./host-telemetry.js"
export type { UsageHarness } from "./summary.js"
export type { UsageTokenCounts } from "./pricing.js"
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
  /** The script the ledger is read in, off the host; see `UsageReader`. */
  worker: URL
}

export function declareUsageMethods(methods: MethodTable, { dataRoot, worker }: UsageDeps): Usage {
  let reader: UsageReader | undefined
  methods.handle("mako:usage", () => {
    reader ??= new UsageReader(worker, {
      ledgerPath: join(dataRoot, "usage-ledger.sqlite"),
      sessionsRoot: join(homedir(), ".mako", "sessions"),
      homeRoot: homedir(),
      conversationsRoot: join(dataRoot, "conversations"),
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
 */
export function spendWatch(
  harnessOf: (conversationId: string) => string | undefined,
  spent: (harness: string, throttle?: number) => boolean,
): (event: HostEvent) => HostEvent | undefined {
  /** Live sessions mid-turn, by id, with the harness that is spending. */
  const spending = new Map<string, string>()
  return (event) => {
    let ended: string | undefined
    let throttle: number | undefined
    const status = event.type === "live-batch" ? (event.batch.session ?? event.batch.sessionChanges)?.status : undefined
    if (event.type === "live-batch" && status) {
      const harness = event.batch.session?.harness ?? harnessOf(event.batch.id)
      if (status === "running" && harness) spending.set(event.batch.id, harness)
      else if (status !== "running") { ended = spending.get(event.batch.id); spending.delete(event.batch.id) }
    } else if (event.type === "thread-run" && event.run.status !== "running") {
      ended = event.run.harness
    } else if (event.type === "thread-ref" && Date.now() - Date.parse(event.ref.updatedAt ?? "") < RECENT_WRITE_MS) {
      ended = event.ref.harness
      throttle = STORE_SPEND_THROTTLE_MS
    }
    return ended !== undefined && spent(ended, throttle) ? { type: "account-usage-spent", harness: ended } : undefined
  }
}
