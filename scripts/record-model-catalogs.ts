import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseArgs } from "node:util"
import { parseVersion } from "@mako/host/contracts/runtime-version"
import { ProviderProfileCache } from "@mako/host/harnesses/provider-profile-cache"
import { createHarnessHost } from "@mako/host/harnesses/harness-host"
import type { ProviderProfileLoader } from "@mako/host/harnesses/profile-loader"
import type { HarnessProfile } from "@mako/host/contracts/providers-acp"
import { readRuntimeVersion } from "@mako/host/harnesses/runtime-updates"
import { catalogPath, MODEL_CATALOG_ROOT, recordable, recordedCatalog, type RecordedCatalog } from "./model-catalogs.ts"
import { DiscoveryProcesses } from "@mako/host/harnesses/discovery-process"

const providerHost = createHarnessHost()

const processes = new DiscoveryProcesses()

/**
 * Records each harness's model catalog from Mako's own discovery, the
 * newest working snapshot in `~/.mako/provider-profiles.json`, so recording
 * starts no harness and touches no harness's store. Open Mako with the
 * harness installed and signed in first; its discovery writes the snapshot.
 *
 *   npm run harness:catalogs -- [--harness grok] [--discover]
 *
 * `--discover` runs the harness's own discovery instead, from this shell's
 * environment in a throwaway folder: what Mako runs at startup, for a
 * harness whose snapshot is missing or older than a fix to its discovery.
 *
 * A harness whose defaults name no model (`defaults.none`) has nothing to
 * hold to a catalog and isn't recorded.
 */

const options = parseArgs({ options: { harness: { type: "string" }, discover: { type: "boolean", default: false } } }).values
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
  const profile = options.discover ? await discovered(loader) : await cache.nearest(`${provider}:`)
  if (!profile?.models.length) {
    missing.push(`${provider}: Mako hasn't discovered ${label}'s models on this machine yet`)
    continue
  }
  const before = recordedCatalog(provider)
  const found = { ...await versionOf(provider), models: recordable(profile.models) }
  const same = before && before.version === found.version && JSON.stringify(before.models) === JSON.stringify(found.models)
  const catalog: RecordedCatalog = {
    harness: provider,
    recorded: same ? before.recorded : new Date().toISOString().slice(0, 10),
    ...found,
  }
  await writeFile(catalogPath(provider), formatted(catalog))
  console.log(`${provider}: ${catalog.models.length} models${catalog.version ? ` from ${catalog.version}` : ""}${changes(before, catalog)}`)
}
if (missing.length) {
  for (const line of missing) console.error(line)
  console.error("Open Mako with these harnesses installed and signed in, then run this again.")
  process.exitCode = 1
}

async function discovered(loader: ProviderProfileLoader): Promise<HarnessProfile | undefined> {
  const cwd = await mkdtemp(join(tmpdir(), "mako-catalog-"))
  try {
    const profile = await loader.load(process.env, cwd, { signal: AbortSignal.timeout(120_000) })
    if (profile.configurationError) console.warn(`${loader.provider}: ${profile.configurationError}`)
    return profile.available ? profile : undefined
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
}

async function versionOf(provider: string): Promise<{ version?: string }> {
  const binary = await providerHost.updateSources.get(provider)?.binary(process.env)
  if (!binary) return {}
  const source = providerHost.updateSources.get(provider)
  const output = await readRuntimeVersion(processes, binary, source?.versionArgs ?? ["--version"], process.env).catch(() => "")
  const version = parseVersion(output)
  return version ? { version } : {}
}

/** One model a line, so a catalog's diff reads as models added, removed and changed. */
function formatted({ models, ...header }: RecordedCatalog): string {
  const head = JSON.stringify(header).slice(0, -1)
  return `${head},"models":[\n${models.map((model) => `  ${JSON.stringify(model)}`).join(",\n")}\n]}\n`
}

function changes(before: RecordedCatalog | undefined, after: RecordedCatalog): string {
  if (!before) return ""
  const was = new Set(before.models.map((model) => model.id))
  const now = new Set(after.models.map((model) => model.id))
  const added = [...now].filter((id) => !was.has(id))
  const removed = [...was].filter((id) => !now.has(id))
  return [added.length ? `, added ${added.join(", ")}` : "", removed.length ? `, removed ${removed.join(", ")}` : ""].join("")
}
