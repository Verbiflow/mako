import { existsSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { cursorSdkIndexPath, cursorSdkStateRoot } from "@mako/sessions/cursor-sdk-paths"
import { inclusiveTokens } from "@mako/sessions/harnesses"
import type { NativeStores } from "@mako/sessions/read-only-sqlite"
import { z } from "zod"
import { parseObject, tokenTotal, usageCounts, yieldToMain, type ProviderUsageHistory, type UsageEvent, type UsageScan } from "../../usage/index.js"

/**
 * Cursor's usage, read from the SDK's own index: `runs.usage_json` keeps
 * each run's tokens, summed over the run's model calls, as the run's `usage`
 * message streamed them (SDK 1.0.31; 733 of 733 finished runs and 22 of 41
 * failed ones in Mako's state root kept them on 2026-10-17). It reads Mako's
 * state root in the host's user root (`cursorSdkStateRoot`), which the host's
 * driver, native runner and side questions share,
 * and the stores any other `@cursor/sdk` program keeps under the SDK's
 * default root, `~/.cursor/projects/<workspace>/sdk-agent-store/<md5>/`.
 * `cursor-agent`'s own stores keep no token counts.
 */
export function cursorUsageHistory(stores: NativeStores): ProviderUsageHistory {
  return { provider: "cursor", scan: (usage) => scan(stores, usage) }
}

const UsageSchema = z.object({
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheReadTokens: z.number(),
  cacheWriteTokens: z.number(),
  reasoningTokens: z.number().optional(),
})
const RunSchema = z.object({
  run_id: z.string(),
  agent_id: z.string(),
  model: z.string().nullable(),
  usage_json: z.string(),
  updated_at: z.string(),
  finished_at: z.string().nullable(),
  workspace_ref: z.string().nullable(),
})
/** Runs read between yields to the summary's event loop. */
const RUNS_PER_READ = 1_024

/** Every SDK index this machine keeps: Mako's state root, then the SDK's default stores. */
function indexes(scan: UsageScan): string[] {
  const found = new Set([cursorSdkIndexPath(cursorSdkStateRoot(scan.userRoot))])
  const projects = join(scan.homeRoot, ".cursor", "projects")
  for (const project of entries(projects)) {
    const stores = join(projects, project, "sdk-agent-store")
    for (const store of entries(stores)) found.add(join(stores, store, "index.db"))
  }
  return [...found].filter((path) => existsSync(path))
}

function entries(folder: string): string[] {
  try {
    return readdirSync(folder)
  } catch {
    return []
  }
}

/**
 * A run gains its usage when it ends and its row is written again then, so
 * a read goes on from the latest `updated_at` the last one saw (ISO strings,
 * which order as the times do) and the window's start bounds the first.
 */
async function scan(stores: NativeStores, scan: UsageScan): Promise<void> {
  for (const path of indexes(scan)) {
    await scan.store(path, async (cursor) => {
      let db
      try {
        db = stores.open(path)
      } catch (cause) {
        scan.unreadable(path, cause instanceof Error ? cause.message : String(cause))
        return cursor
      }
      try {
        const after = cursor === undefined ? "" : new Date(cursor).toISOString()
        const since = new Date(scan.since).toISOString()
        const runs = db.prepare(
          `SELECT r.run_id, r.agent_id, r.model, r.usage_json, r.updated_at, r.finished_at, a.workspace_ref
           FROM runs r LEFT JOIN agents a ON a.agent_id = r.agent_id
           WHERE r.usage_json IS NOT NULL AND r.updated_at > ? AND coalesce(r.finished_at, r.updated_at) >= ?
           ORDER BY r.updated_at LIMIT ? OFFSET ?`
        )
        let last = cursor
        for (let offset = 0; ; offset += RUNS_PER_READ) {
          const page = runs.all(after, since, RUNS_PER_READ, offset)
          for (const row of page) {
            const run = RunSchema.safeParse(row).data
            if (!run) continue
            const event = cursorEvent(scan.source, run)
            if (event) scan.record(event)
            const updated = Date.parse(run.updated_at)
            if (Number.isFinite(updated)) last = Math.max(last ?? updated, updated)
          }
          if (page.length < RUNS_PER_READ) break
          await yieldToMain()
        }
        return last
      } catch (cause) {
        scan.unreadable(path, cause instanceof Error ? cause.message : String(cause))
        return cursor
      } finally {
        db.close()
      }
    })
  }
}

function cursorEvent(source: string, run: z.infer<typeof RunSchema>): UsageEvent | undefined {
  const usage = UsageSchema.safeParse(parseObject(run.usage_json)).data
  if (!usage) return undefined
  // Cursor's `inputTokens` includes what the cache supplied, as the live decoder reads it.
  const counts = usageCounts(inclusiveTokens({
    input: usage.inputTokens,
    cacheRead: usage.cacheReadTokens,
    cacheWrite: usage.cacheWriteTokens,
    output: usage.outputTokens,
    reasoning: usage.reasoningTokens,
  }))
  if (tokenTotal(counts) === 0) return undefined
  return {
    ...counts,
    // One run is one turn's calls summed, so long-context pricing never reads it as one call.
    summed: true,
    key: `${source}:${run.run_id}`,
    source,
    session: run.agent_id,
    timestamp: run.finished_at ?? run.updated_at,
    model: run.model ?? "unknown",
    cwd: run.workspace_ref ?? "unknown",
  }
}
