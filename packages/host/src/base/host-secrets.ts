import { join } from "node:path"
import { heavy } from "./heavy-packages.js"
import type { HostEnvironment } from "./host-environment.js"
import { processKeychain } from "./keychain.js"
import { adoptingLegacy, aesSealer, fileSecrets, handedKey, legacyFiles, memorySecrets, wrappedKey, type LegacyFiles, type SecretKey, type Secrets } from "./secrets.js"
import { chromiumSafeStorage, type SecretEncryption } from "./secure-storage.js"

/** How long the host waits after it starts for the desktop's handover before reading the keychain itself. */
const HANDOVER_GRACE_MS = 5_000

export interface HostSecretsInput {
  /** `HostEnvironment.userRoot`: the store is `<userRoot>/secrets`. */
  userRoot: string
  /**
   * The keychain item older builds' `safeStorage` used, read in this process
   * (`chromiumSafeStorage`); none off macOS.
   */
  keychain: SecretEncryption
  /** Each domain's older files; read as they are when a record is first asked for. */
  legacy: readonly LegacyFiles[]
  /** Until when (epoch ms) a read waits for the desktop's handover before asking `keychain`. */
  handoverUntil?: number
}

/**
 * How the host gets its data key from the desktop app, whose `safeStorage`
 * has it, on the host's private socket (`/secret-key`).
 */
export interface SecretKeyHandover {
  /** This host holds no handed key. */
  wanted(): Promise<boolean>
  /** Refused unless it is this store's key. */
  offer(key: Buffer): Promise<void>
}

export interface HostSecrets {
  secrets: Secrets
  handover: SecretKeyHandover
}

export function dataKeyPath(userRoot: string): string {
  return join(userRoot, "secrets", "data-key")
}

/**
 * The secrets of every host this user runs: the installed app and
 * `npm run dev` read one Cursor key, and a host isolated in a temporary root
 * keeps its own. The data key is wrapped by the keychain item older builds
 * used through `safeStorage`, so moving onto this store asks for nothing new.
 *
 * The desktop hands the key over, since its `safeStorage` reads the item
 * without asking the person. The host reads the item itself only without
 * one, as Mako Helper, after giving a desktop that started it a moment to
 * hand the key over. Either way each older file is taken over the first time
 * its record is read, opened by the same keychain.
 */
export function openHostSecrets({ userRoot, keychain, legacy, handoverUntil = 0 }: HostSecretsInput): HostSecrets {
  const path = dataKeyPath(userRoot)
  const wrapped = wrappedKey(path, keychain)
  const handed = handedKey(path)
  const key: SecretKey = {
    available: async () => handed.held() || (await keychain.available()),
    async key(create) {
      if (!handed.held() && (await keychain.available())) await handed.arrival(handoverUntil - Date.now())
      if (handed.held() || !(await keychain.available())) return handed.key(create)
      return wrapped.key(create)
    },
  }
  return {
    secrets: adoptingLegacy(fileSecrets(join(userRoot, "secrets"), aesSealer(key)), {
      encryption: keychain,
      ...legacyFiles(legacy),
    }),
    handover: {
      wanted: async () => !handed.held(),
      offer: (value) => handed.offer(value),
    },
  }
}

/** What a domain keeps its secrets through. */
export interface DomainSecrets {
  readonly secrets: Secrets
  /** Where the domain's older builds kept its secrets; declared as it's built, before it reads them. */
  adoptLegacy(files: LegacyFiles): void
}

/** A host's secrets: every domain's, and the desktop's handover of the key that opens them. */
export interface HostSecretStore extends DomainSecrets {
  readonly handover: SecretKeyHandover
}

/**
 * This host's one store. It opens on its first read, not here: harnesses take
 * it as they are installed, before every domain has declared its older files.
 */
export function hostSecretStore({ userRoot, appName }: Pick<HostEnvironment, "userRoot" | "appName">): HostSecretStore {
  const legacy: LegacyFiles[] = []
  let opened: HostSecrets | undefined
  const host = () => (opened ??= openHostSecrets({
    userRoot,
    keychain: chromiumSafeStorage({ appName, keychain: processKeychain(() => heavy.keyring.load("keychain")) }),
    legacy,
    handoverUntil: performance.timeOrigin + HANDOVER_GRACE_MS,
  }))
  return {
    secrets: {
      durable: () => host().secrets.durable(),
      read: (kind, name) => host().secrets.read(kind, name),
      write: (kind, name, value, options) => host().secrets.write(kind, name, value, options),
      delete: (kind, name) => host().secrets.delete(kind, name),
      list: (kind) => host().secrets.list(kind),
    },
    handover: {
      wanted: () => host().handover.wanted(),
      offer: (key) => host().handover.offer(key),
    },
    adoptLegacy: (files) => {
      legacy.push(files)
    },
  }
}

/** Secrets held in memory and lost with the process, for a fixture desk or a detached host. */
export function detachedSecrets(): DomainSecrets {
  return { secrets: memorySecrets({ durable: false }), adoptLegacy: () => {} }
}
