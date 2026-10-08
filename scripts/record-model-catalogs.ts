import { mkdir, writeFile } from "node:fs/promises"
import { parseArgs } from "node:util"
import { parseVersion } from "../electron/contracts/runtime-version.ts"
import { ProviderProfileCache } from "../electron/provider-profile-cache.ts"
import { providerHost } from "../electron/providers/index.ts"
import { readRuntimeVersion } from "../electron/runtime-updates.ts"
import { catalogPath, MODEL_CATALOG_ROOT, recordable, recordedCatalog, type RecordedCatalog } from "./model-catalogs.ts"

/**
 * Records each harness's model catalog from Mako's own discovery, the
 * newest working snapshot in `~/.mako/provider-profiles.json`, so recording
 * starts no harness and touches no harness's store. Open Mako with the
 * harness installed and signed in first; its discovery writes the snapshot.
 *
 *   npm run harness:catalogs -- [--harness grok]
 *
 * A harness whose defaults name no model (`defaults.none`) has nothing to
 * hold to a catalog and isn't recorded.
 */

const options = parseArgs({ options: { harness: { type: "string" } } }).values
const cache = new ProviderProfileCache()
const missing: string[] = []

await mkdir(MODEL_CATALOG_ROOT, { recursive: true })
for (const loader of providerHost.profiles.list()) {
  const { provider, label, defaults } = loader
  if (options.harness && provider !== options.harness) continue
  if (defaults.work.length === 0) {
    console.log(`${provider}: not recorded, ${defaults.none}`)
    continue
  }
  const profile = await cache.nearest(`${provider}:`)
  if (!profile?.models.length) {
    missing.push(`${provider}: Mako hasn't discovered ${label}'s models on this machine yet`)
    continue
  }
  const catalog: RecordedCatalog = {
    harness: provider,
    recorded: new Date().toISOString().slice(0, 10),
    ...await versionOf(provider),
    models: recordable(profile.models),
  }
  const before = recordedCatalog(provider)
  await writeFile(catalogPath(provider), `${JSON.stringify(catalog, null, 2)}\n`)
  console.log(`${provider}: ${catalog.models.length} models${catalog.version ? ` from ${catalog.version}` : ""}${changes(before, catalog)}`)
}
if (missing.length) {
  for (const line of missing) console.error(line)
  console.error("Open Mako with these harnesses installed and signed in, then run this again.")
  process.exitCode = 1
}

async function versionOf(provider: string): Promise<{ version?: string }> {
  const binary = await providerHost.updateSources.get(provider)?.binary(process.env)
  if (!binary) return {}
  const source = providerHost.updateSources.get(provider)
  const output = await readRuntimeVersion(binary, source?.versionArgs ?? ["--version"], process.env).catch(() => "")
  const version = parseVersion(output)
  return version ? { version } : {}
}

function changes(before: RecordedCatalog | undefined, after: RecordedCatalog): string {
  if (!before) return ""
  const was = new Set(before.models.map((model) => model.id))
  const now = new Set(after.models.map((model) => model.id))
  const added = [...now].filter((id) => !was.has(id))
  const removed = [...was].filter((id) => !now.has(id))
  return [added.length ? `, added ${added.join(", ")}` : "", removed.length ? `, removed ${removed.join(", ")}` : ""].join("")
}
