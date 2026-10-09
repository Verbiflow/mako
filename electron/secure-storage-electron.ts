import { keychainReachable, type SecretEncryption } from "./secure-storage.js"
import { onLinux, onMac } from "./platform.js"

/**
 * Electron's `safeStorage`, reached lazily so callers also load in a plain
 * Node test. A `basic_text` backend is not encryption and is refused. Under
 * Node, or Electron's Helper in Node mode, there is no `safeStorage`: nothing
 * is available, rather than a crash.
 */
export function electronSecretEncryption(): SecretEncryption {
  // A packaged Helper in Node mode has no `electron` module at all.
  const electron: Promise<Partial<typeof import("electron")>> = import("electron").catch(() => ({}))
  return {
    async available() {
      if (!keychainReachable()) return false
      const { safeStorage } = await electron
      if (!safeStorage) return false
      if (onMac()) return safeStorage.isAsyncEncryptionAvailable()
      return (
        safeStorage.isEncryptionAvailable() &&
        (!onLinux() || safeStorage.getSelectedStorageBackend() !== "basic_text")
      )
    },
    async encrypt(value) {
      const { safeStorage } = await electron
      if (!safeStorage) throw new Error("Electron's safeStorage isn't in this process")
      return onMac() ? safeStorage.encryptStringAsync(value) : safeStorage.encryptString(value)
    },
    async decrypt(value) {
      const { safeStorage } = await electron
      if (!safeStorage) throw new Error("Electron's safeStorage isn't in this process")
      return onMac() ? (await safeStorage.decryptStringAsync(value)).result : safeStorage.decryptString(value)
    },
  }
}

