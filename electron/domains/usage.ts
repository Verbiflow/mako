import { homedir } from "node:os"
import { join } from "node:path"
import type { MethodTable } from "../host-methods.js"
import { UsageReader } from "../usage-reader.js"
import { accountUsageSpent } from "../accounts.js"
import type { HostEvent } from "../shared.js"

/** A session write older than this is the catalog catching up, not use. */
const RECENT_WRITE_MS = 2 * 60_000
/** A harness busy outside Mako writes constantly; its limits are read again at most this often. */
const STORE_SPEND_THROTTLE_MS = 60_000

/** The usage ledger, read on first ask. Returns what closes it. */
/** The usage ledger, opened by the first `mako:usage` call. */
export interface Usage {
  close(): Promise<void>
}

export function declareUsageMethods(methods: MethodTable, dataRoot: string): Usage {
  let reader: UsageReader | undefined
  methods.handle("mako:usage", () => {
    reader ??= new UsageReader({
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
 * Returns the event to send when a harness's limits are worth reading again.
 */
export function spendWatch(harnessOf: (conversationId: string) => string | undefined): (event: HostEvent) => HostEvent | undefined {
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
    return ended !== undefined && accountUsageSpent(ended, throttle) ? { type: "account-usage-spent", harness: ended } : undefined
  }
}
