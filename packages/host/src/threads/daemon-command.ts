export const DAEMON_NODE_ARGS = ["--expose-gc", "--max-old-space-size=128"]
/**
 * Match the worker fallback's heap budget for interactive, paged history reads. The young generation is capped at
 * 8 MB a semi-space: V8 sizes it from the old generation's limit, and at 768 MB it grew to 128 MB, resident, while the
 * sync daemon held 40 to 100 MB of live heap. Capped, a 60 MiB catch-up peaked about 100 MB lower, its latencies the
 * same.
 */
export const ON_DEMAND_CATALOG_NODE_ARGS = ["--expose-gc", "--max-old-space-size=768", "--max-semi-space-size=8"]
/**
 * What the sync daemon's environment adds. `MallocLargeCache=0`: macOS's malloc otherwise keeps freed large blocks
 * (each pack an upload encodes, each copy `fetch` makes of it) resident for reuse; a 146 MiB catch-up left 554 MB of
 * them, which counted against the daemon until its memory guard retired it. Elsewhere it means nothing.
 */
export const ON_DEMAND_CATALOG_ENV = { MallocLargeCache: "0" }
