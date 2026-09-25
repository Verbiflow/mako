import { createHash } from "node:crypto"
import { CursorSdkClient } from "./client.js"
import type { CursorSdkProbeClient, CursorSdkSpawnOptions } from "./auth.js"
import type { SdkModelListItem } from "./wire.js"

export interface CursorSdkModelsOptions {
  env: NodeJS.ProcessEnv
  cwd?: string
  /** Test hook: a client other than the real child. */
  client?(options: CursorSdkSpawnOptions): CursorSdkProbeClient
}

/**
 * The models Cursor's SDK offers this account, asked of a short-lived child.
 * Discovery has no session to piggyback on, so this is its own spawn; the
 * provider-owned cache shares successful lists with startup for ten minutes.
 * A display refresh asks natively again and concurrent loads share that request.
 */
export async function listCursorSdkModels(options: CursorSdkModelsOptions): Promise<SdkModelListItem[]> {
  const spawn: CursorSdkSpawnOptions = {
    owner: "cursor-sdk-models",
    cwd: options.cwd ?? process.cwd(),
    env: options.env,
    onEvent: () => undefined,
  }
  const client = options.client ? options.client(spawn) : new CursorSdkClient(spawn)
  try {
    await client.hello()
    return (await client.request("models", undefined)).models
  } finally {
    await client.close(2_000)
  }
}

interface ModelEntry {
  cached?: { models: SdkModelListItem[]; expiresAt: number }
  pending?: Promise<SdkModelListItem[]>
}

/** Account/endpoint-scoped native results shared by display and startup. Never cache failures. */
export function createCursorModelCache(now: () => number = Date.now) {
  const entries = new Map<string, ModelEntry>()
  return async (env: NodeJS.ProcessEnv, load: () => Promise<SdkModelListItem[]>, refresh = false): Promise<SdkModelListItem[]> => {
    // With no resolved key the SDK reads mutable native storage itself. We do
    // not know its credential identity, so no cross-call reuse is authoritative.
    if (!env.CURSOR_API_KEY) return load()
    const key = createHash("sha256").update(JSON.stringify(Object.entries(env)
      .filter(([, value]) => value !== undefined).sort(([a], [b]) => a.localeCompare(b)))).digest("hex")
    for (const [key, entry] of entries)
      if (!entry.pending && (!entry.cached || entry.cached.expiresAt <= now())) entries.delete(key)
    let entry = entries.get(key)
    // A display refresh must not hold a launch behind another network call
    // while this exact credential scope still has a valid native result.
    if (!refresh && entry?.cached && entry.cached.expiresAt > now()) return structuredClone(entry.cached.models)
    if (!entry) {
      entry = {}
      if (entries.size >= 4) {
        const settled = [...entries].find(([, entry]) => !entry.pending)
        if (settled) entries.delete(settled[0])
      }
      if (entries.size < 4) entries.set(key, entry)
    }
    let pending = entry.pending
    if (!pending) {
      const current = entry
      pending = Promise.resolve().then(load).then(models => {
        if (!models.length) throw new Error("Cursor's SDK listed no models for this account")
        return structuredClone(models)
      })
      current.pending = pending
      void pending.then(models => {
        current.cached = { models, expiresAt: now() + 10 * 60_000 }
        current.pending = undefined
      }, () => {
        current.pending = undefined
        if ((!current.cached || current.cached.expiresAt <= now()) && entries.get(key) === current) entries.delete(key)
      })
    }
    return structuredClone(await pending)
  }
}
export type CursorModelCache = ReturnType<typeof createCursorModelCache>
