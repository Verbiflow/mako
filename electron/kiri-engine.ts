import { randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import type { KiriClient, KiriRepository, ModelCall } from "@kiri/client"
import { hostLog } from "./host-log.js"

type ModelHandler = (call: ModelCall, signal: AbortSignal) => Promise<string>
interface RepositoryLease { value: Promise<KiriRepository | null>; transport: Promise<KiriClient>; users: number }
const models = new Map<string, ModelHandler>()
const repositories = new Map<string, RepositoryLease>()
let connection: Promise<KiriClient> | null = null
let cacheDirectory: string | undefined

export function configureKiriCache(path: string): void { cacheDirectory = path }
function binaryPath(): string {
  if (process.env.MAKO_KIRI_BINARY) return process.env.MAKO_KIRI_BINARY
  const filename = process.platform === "win32" ? "kiri-engine.exe" : "kiri-engine"
  const platform = `${process.platform}-${process.arch}`
  const packaged = process.resourcesPath ? join(process.resourcesPath, "kiri", platform, filename) : null
  if (packaged && existsSync(packaged)) return packaged
  const local = join(dirname(fileURLToPath(import.meta.url)), "..", "vendor", "kiri", platform, filename)
  if (!existsSync(local)) throw new Error("Kiri's Git engine is missing. Run npm run prepare:kiri, then restart the idle Mako host.")
  return local
}
function client(): Promise<KiriClient> {
  if (connection) return connection
  connection = (async () => {
    try {
      const { KiriClient, KiriError } = await import("@kiri/client")
      return await KiriClient.connect({ binary: binaryPath(), cacheDirectory, model: async (call, signal) => {
        const model = models.get(call.model)
        if (!model) throw new KiriError("model_unavailable", "The selected model connection is no longer active.")
        return model(call, signal)
      } })
    } catch (error) {
      connection = null
      throw error
    }
  })()
  return connection
}
export function registerKiriModel(handler: ModelHandler) {
  const handle = randomUUID()
  models.set(handle, handler)
  return { handle, release: () => models.delete(handle) }
}
export async function withKiriRepository<T>(cwd: string, action: (repo: KiriRepository | null, client: KiriClient) => Promise<T>): Promise<T> {
  let entry = repositories.get(cwd)
  if (!entry) {
    const closing: Promise<void>[] = []
    for (const [key, candidate] of repositories) {
      if (repositories.size < 48) break
      if (candidate.users) continue
      repositories.delete(key)
      closing.push(candidate.value.then(async (repo) => { await repo?.close() }))
    }
    const transport = client()
    entry = { value: Promise.all(closing).then(() => transport).then((engine) => engine.discover(cwd)), transport, users: 0 }
    repositories.set(cwd, entry)
  }
  entry.users += 1
  let opened = false
  try {
    const repo = await entry.value
    opened = true
    if (!repo) repositories.delete(cwd)
    return await action(repo, await entry.transport)
  } catch (error) {
    if (!opened && repositories.get(cwd) === entry) repositories.delete(cwd)
    const { KiriError } = await import("@kiri/client")
    if (error instanceof KiriError) hostLog("git", "Kiri request failed", { cwd, code: error.code, message: error.message })
    if (error instanceof KiriError && (error.code === "disconnected" || error.code === "outcome_unknown") && connection === entry.transport) {
      connection = null
      repositories.clear()
    }
    throw error
  } finally { entry.users -= 1 }
}
export async function closeKiriEngine(): Promise<void> {
  const current = connection
  connection = null
  repositories.clear()
  models.clear()
  if (current) (await current).dispose()
}
