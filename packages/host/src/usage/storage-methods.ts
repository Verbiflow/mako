import type { MethodTable } from "../base/methods.js"
import type { StorageReport } from "../contracts/storage.js"
import type { MakoStorage } from "./storage.js"

/** Settings › Storage: what Mako keeps, measured again when asked, and freeing what its collectors can. */
export function declareStorageMethods(methods: MethodTable, storage: MakoStorage) {
  methods.handle("mako:storage", (measure: boolean): Promise<StorageReport> | StorageReport => (measure ? storage.measure() : storage.report()))
  methods.handle("mako:storage-free", (): Promise<StorageReport> => storage.free())
}
