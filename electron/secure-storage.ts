import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

export interface SecretEncryption {
  available(): Promise<boolean>
  encrypt(value: string): Promise<Buffer>
  decrypt(value: Buffer): Promise<string>
}

/**
 * Whether macOS has a login keychain to hold the key `safeStorage` wraps
 * secrets with. A host started with a temporary `HOME`, like a review
 * profile, has none. Asking for the key there makes macOS show "A keychain
 * cannot be found to store …" on every attempt, and the commit box asks
 * each time its window gains focus.
 */
export function keychainReachable(home = homedir()): boolean {
  return process.platform !== "darwin" || existsSync(join(home, "Library", "Keychains"))
}

/**
 * Electron's `safeStorage`, reached lazily so callers also load in a plain
 * Node test. A `basic_text` backend is not encryption and is refused. Under
 * Node, or Electron's Helper in Node mode, there is no `safeStorage`: nothing
 * is available, rather than a crash.
 */
export function electronSecretEncryption(): SecretEncryption {
  const electron = import("electron")
  return {
    async available() {
      if (!keychainReachable()) return false
      const { safeStorage } = await electron
      if (!safeStorage) return false
      if (process.platform === "darwin") return safeStorage.isAsyncEncryptionAvailable()
      return (
        safeStorage.isEncryptionAvailable() &&
        (process.platform !== "linux" || safeStorage.getSelectedStorageBackend() !== "basic_text")
      )
    },
    async encrypt(value) {
      const { safeStorage } = await electron
      return process.platform === "darwin" ? safeStorage.encryptStringAsync(value) : safeStorage.encryptString(value)
    },
    async decrypt(value) {
      const { safeStorage } = await electron
      return process.platform === "darwin" ? (await safeStorage.decryptStringAsync(value)).result : safeStorage.decryptString(value)
    },
  }
}
