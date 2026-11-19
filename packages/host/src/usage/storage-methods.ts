import type { MethodTable } from "../base/methods.js"
import { hostWarn } from "../base/host-log.js"
import { errorMessage } from "../base/error-message.js"
import type { StorageBudgetSettings, StorageReport } from "../contracts/storage.js"
import type { MakoStorage } from "./storage.js"

/**
 * Settings › Storage: what Mako keeps, measured again when asked, freeing what its collectors can, and each store's
 * folders by how expendable they are. A preview and a removal run behind the answer; the section reads the report until
 * `planning` and `reclaiming` are off.
 */
export function declareStorageMethods(methods: MethodTable, storage: MakoStorage) {
  methods.handle("mako:storage", (measure: boolean): Promise<StorageReport> | StorageReport => (measure ? storage.measure() : storage.report()))
  methods.handle("mako:storage-free", (): Promise<StorageReport> => storage.free())
  methods.handle("mako:storage-plan", async (): Promise<StorageReport> => {
    await storage.budget()
    void storage.plan().catch((error) => hostWarn("storage", "a preview failed", { error: errorMessage({ error }) }))
    return storage.report()
  })
  methods.handle("mako:storage-reclaim", (consent: "now" | "approve", ids: string[]): StorageReport => {
    void storage.reclaim(consent, ids)
      .then(() => storage.measure())
      .catch((error) => hostWarn("storage", "a removal failed", { error: errorMessage({ error }) }))
    return storage.report()
  })
  methods.handle("mako:storage-budget-set", (settings: StorageBudgetSettings): Promise<StorageReport> => storage.configureBudget(settings))
}
