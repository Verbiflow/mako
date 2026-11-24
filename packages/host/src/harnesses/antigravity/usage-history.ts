import { basename, join } from "node:path"
import { AntigravityProvider } from "@mako/sessions"
import type { NativeStores } from "@mako/sessions/read-only-sqlite"
import { usageCounts, yieldToMain, type ProviderUsageHistory, type UsageScan } from "../../usage/index.js"

/** Antigravity's usage, read from each conversation's database in every data directory the CLI and Mako's keys use. */
export function antigravityUsageHistory(stores: NativeStores): ProviderUsageHistory {
  return { provider: "antigravity", scan: (usage) => scan(stores, usage) }
}

/** Rows read between yields to the host's event loop: a generation's row can be megabytes. */
const ROWS_PER_YIELD = 16

/**
 * A conversation's database changes in place, so one changed since the last
 * read is read whole again; its calls keep their keys and merge.
 */
async function scan(stores: NativeStores, scan: UsageScan): Promise<void> {
  const provider = new AntigravityProvider(stores, scan.env.GEMINI_HOME || join(scan.homeRoot, ".gemini"))
  for (const file of await provider.discover()) {
    if (file.mtimeMs < scan.since) continue
    await scan.store(file.path, async (cursor) => {
      if (cursor === file.mtimeMs) return cursor
      const session = basename(file.path, ".db")
      const cwd = (await provider.peek(file).catch(() => null))?.cwd ?? "unknown"
      let rows = 0
      let unnamed = 0
      for (const calls of provider.calls(file.path)) {
        for (const call of calls) scan.record({
          ...usageCounts(call.tokens),
          // A call with no id of its own is keyed by its place in the database.
          key: `${scan.source}:${call.ids[0] ?? `${session}:${unnamed++}`}`,
          source: scan.source,
          session,
          timestamp: new Date(call.at ?? file.mtimeMs).toISOString(),
          model: call.model || "unknown",
          cwd,
        })
        if (++rows % ROWS_PER_YIELD === 0) await yieldToMain()
      }
      return file.mtimeMs
    })
  }
}
