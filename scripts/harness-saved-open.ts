/**
 * How long this machine's largest saved sessions take to open, per harness:
 * the tail preview the viewer paints first, then the full first page, cold
 * and warm. Reads the native stores read-only and prints only sizes, entry
 * counts and times. `test:performance` holds the same path to a budget on
 * kept pair stores; this is what it costs on real ones.
 *
 *   npm run harness:saved-open                 the three largest per harness
 *   npm run harness:saved-open -- cursor 5     the five largest Cursor sessions
 */
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { defaultCatalog, VIEWER_PAGE, type ThreadRef } from "@mako/sessions"

const [only, count = "3"] = process.argv.slice(2)
const scratch = await mkdtemp(join(tmpdir(), "mako-saved-open-"))
try {
  const catalog = defaultCatalog({ readOnly: true, cachePath: join(scratch, "cache.json") })
  const started = performance.now()
  await catalog.scan()
  console.log(`Found ${catalog.list().length} sessions in ${Math.round(performance.now() - started)} ms\n`)
  const byHarness = new Map<string, ThreadRef[]>()
  for (const ref of catalog.list(only ? { harness: only } : {})) byHarness.set(ref.harness, [...(byHarness.get(ref.harness) ?? []), ref])
  for (const [harness, refs] of byHarness) {
    // OpenCode's `bytes` is a revision stamp, not a size, so its order is by recency there.
    const largest = refs.sort((left, right) => (right.bytes ?? 0) - (left.bytes ?? 0)).slice(0, Number(count))
    for (const ref of largest) {
      const preview = await timed(() => catalog.page(ref.path, undefined, 100, { ...VIEWER_PAGE, preview: true }))
      const cold = await timed(() => catalog.page(ref.path, undefined, 100, VIEWER_PAGE))
      const warm = await timed(() => catalog.page(ref.path, undefined, 100, VIEWER_PAGE))
      const size = harness === "opencode" ? "" : `${((ref.bytes ?? 0) / 1e6).toFixed(1)} MB`
      console.log(`${harness.padEnd(9)} ${size.padStart(11)}  preview ${preview}  first page ${cold}  warm ${warm}`)
    }
  }
} finally {
  await rm(scratch, { recursive: true, force: true })
}

async function timed(open: () => Promise<{ entries: unknown[] } | null>): Promise<string> {
  const started = performance.now()
  const page = await open().catch((error: Error) => error)
  const ms = `${Math.round(performance.now() - started)} ms`.padStart(8)
  return page instanceof Error ? `${ms} (${page.name})` : page ? `${ms} (${page.entries.length} entries)` : `${ms} (none)`
}
