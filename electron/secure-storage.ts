import { createCipheriv, createDecipheriv, pbkdf2 } from "node:crypto"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import type { Keychain, KeychainItem } from "./keychain.js"
import { nodePlatform, onMac } from "./platform.js"

export interface SecretEncryption {
  available(): Promise<boolean>
  encrypt(value: string): Promise<Buffer>
  decrypt(value: Buffer): Promise<string>
}

/**
 * The keychain didn't give the key: it refused, is locked, or has no item yet.
 * Unlike a value that won't open, waiting or asking elsewhere can fix it.
 */
export class KeychainUnavailable extends Error {}

/**
 * Whether macOS has a login keychain to hold the key `safeStorage` wraps
 * secrets with. A host started with a temporary `HOME`, like a review
 * profile, has none. Asking for the key there makes macOS show "A keychain
 * cannot be found to store …" on every attempt, and the commit box asks
 * each time its window gains focus.
 */
export function keychainReachable(home = homedir()): boolean {
  return !onMac() || existsSync(join(home, "Library", "Keychains"))
}

/** Where Electron's `safeStorage` keeps its password on macOS, named after the app (`HostEnvironment.appName`). */
export function safeStorageItem(appName: string): KeychainItem {
  return { service: `${appName} Safe Storage`, account: `${appName} Key` }
}

const SEALED_PREFIX = Buffer.from("v10")
const SALT = "saltysalt"
const ROUNDS = 1003
const IV = Buffer.alloc(16, " ")
const derive = promisify(pbkdf2)

export interface ChromiumSafeStorageInput {
  appName: string
  keychain: Keychain
  platform?: NodeJS.Platform
  home?: string
}

/**
 * Electron's `safeStorage` on macOS, for a process that has none: Electron's
 * Helper in Node mode, or Node. Chromium keeps one password in the login
 * keychain ({@link safeStorageItem}), derives an AES-128 key from it with
 * PBKDF2, and seals each value as `v10` then AES-128-CBC. This reads that
 * password and seals the same way, so each opens what the other sealed.
 *
 * It never makes the password. Electron does, the first time it seals
 * anything, and a second writer could replace it and leave everything sealed
 * before unreadable. Until then a key is unavailable.
 *
 * The keychain is read once per process. macOS asks the person the first time
 * a binary other than the item's maker reads it (Mako Helper, for a host in
 * Node mode), and "Always Allow" adds it to the item's access list. A refusal
 * holds for the rest of the process: nothing is available after it, so nothing
 * asks again.
 */
export function chromiumSafeStorage({ appName, keychain, platform = nodePlatform(), home }: ChromiumSafeStorageInput): SecretEncryption {
  const item = safeStorageItem(appName)
  let key: Promise<Buffer> | undefined
  let refused = false
  const available = async () => platform === "darwin" && !refused && keychainReachable(home)
  const read = async (): Promise<Buffer> => {
    const answer = await keychain.read(item)
    if (answer.kind === "failed") {
      refused = true
      throw new KeychainUnavailable(`The keychain didn't give "${item.service}": ${answer.reason}`)
    }
    if (answer.kind === "missing") throw new KeychainUnavailable(`The keychain has no "${item.service}" yet`)
    return derive(answer.value, SALT, ROUNDS, 16, "sha1")
  }
  const sealingKey = async (): Promise<Buffer> => {
    if (!(await available())) throw new KeychainUnavailable(`"${item.service}" can't be read here`)
    key ??= read()
    try {
      return await key
    } catch (error) {
      key = undefined
      throw error
    }
  }
  return {
    available,
    async encrypt(value) {
      const cipher = createCipheriv("aes-128-cbc", await sealingKey(), IV)
      return Buffer.concat([SEALED_PREFIX, cipher.update(value, "utf8"), cipher.final()])
    },
    async decrypt(value) {
      if (!value.subarray(0, SEALED_PREFIX.length).equals(SEALED_PREFIX)) throw new Error("This wasn't sealed by safeStorage on macOS")
      const decipher = createDecipheriv("aes-128-cbc", await sealingKey(), IV)
      return Buffer.concat([decipher.update(value.subarray(SEALED_PREFIX.length)), decipher.final()]).toString("utf8")
    },
  }
}

/** No keychain: Node off macOS. */
export const NO_ENCRYPTION: SecretEncryption = {
  available: async () => false,
  encrypt: async () => { throw new KeychainUnavailable("This process can't reach a keychain") },
  decrypt: async () => { throw new KeychainUnavailable("This process can't reach a keychain") },
}
