import { join } from "node:path"
import { heavy } from "./heavy-packages.js"
import { hostEnvironment } from "./host-environment.js"
import { processKeychain } from "./keychain.js"
import { adoptingLegacy, aesSealer, fileSecrets, handedKey, legacyFiles, wrappedKey, type LegacyFiles, type SecretKey, type Secrets } from "./secrets.js"
import { chromiumSafeStorage, NO_ENCRYPTION, preferring, type SecretEncryption } from "./secure-storage.js"

/** How long a host in Node mode waits after it starts for the desktop's handover before reading the keychain itself. */
const HANDOVER_GRACE_MS = 5_000

export interface HostSecretsInput {
  /** `HostEnvironment.userRoot`: the store is `<userRoot>/secrets`. */
  userRoot: string
  /** Electron's `safeStorage`, while Electron runs the host. */
  encryption: SecretEncryption
  /**
   * The same keychain item read in this process, for a host without
   * `safeStorage`: Electron's Helper in Node mode (`chromiumSafeStorage`).
   */
  keychain?: SecretEncryption
  /** Each domain's older files; read as they are when a record is first asked for. */
  legacy: readonly LegacyFiles[]
  /**
   * Until when (epoch ms) a read without `safeStorage` waits for the
   * desktop's handover before asking `keychain`.
   */
  handoverUntil?: number
}

/**
 * How a host without `safeStorage` gets its data key from the desktop app,
 * which has it, on the host's private socket (`/secret-key`).
 */
export interface SecretKeyHandover {
  /** This host has no `safeStorage` and holds no handed key. */
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
 * Under Electron, `safeStorage` unwraps it. In Node mode the desktop hands it
 * over, since its `safeStorage` reads the item without asking the person; the
 * host reads the item itself only without one, as Mako Helper, after giving a
 * desktop that started it a moment to hand the key over. Either way each older
 * file is taken over the first time its record is read, opened by the same
 * keychain.
 */
export function openHostSecrets({ userRoot, encryption, keychain = NO_ENCRYPTION, legacy, handoverUntil = 0 }: HostSecretsInput): HostSecrets {
  const path = dataKeyPath(userRoot)
  const sealing = preferring(encryption, keychain)
  const wrapped = wrappedKey(path, sealing)
  const handed = handedKey(path)
  const key: SecretKey = {
    available: async () => handed.held() || (await sealing.available()),
    async key(create) {
      if (await encryption.available()) return wrapped.key(create)
      if (!handed.held() && (await keychain.available())) await handed.arrival(handoverUntil - Date.now())
      if (handed.held() || !(await keychain.available())) return handed.key(create)
      return wrapped.key(create)
    },
  }
  return {
    secrets: adoptingLegacy(fileSecrets(join(userRoot, "secrets"), aesSealer(key)), {
      encryption: sealing,
      ...legacyFiles(legacy),
    }),
    handover: {
      wanted: async () => !handed.held() && !(await encryption.available()),
      offer: (value) => handed.offer(value),
    },
  }
}

const legacy: LegacyFiles[] = []
let opened: HostSecrets | undefined
let safeStorage: SecretEncryption | undefined

/** Electron's `safeStorage`, which the Electron shell gives the host before any secret is read. */
export function provideSafeStorage(encryption: SecretEncryption): void {
  if (opened) throw new Error("The host's secrets opened before Electron's safeStorage was given")
  safeStorage = encryption
}

function host(): HostSecrets {
  const environment = hostEnvironment()
  opened ??= openHostSecrets({
    userRoot: environment.userRoot,
    encryption: safeStorage ?? NO_ENCRYPTION,
    // A process with `safeStorage` reading its item again here would ask the person twice.
    keychain: safeStorage ? undefined : chromiumSafeStorage({ appName: environment.appName, keychain: processKeychain(() => heavy.keyring.load("keychain")) }),
    legacy,
    handoverUntil: performance.timeOrigin + HANDOVER_GRACE_MS,
  })
  return opened
}

/**
 * This host's one `Secrets`, every domain's. It opens on its first use, not
 * here: providers take it while the host's modules load, before the Electron
 * shell gives `safeStorage`.
 */
export function hostSecrets(): Secrets {
  return {
    durable: () => host().secrets.durable(),
    read: (kind, name) => host().secrets.read(kind, name),
    write: (kind, name, value, options) => host().secrets.write(kind, name, value, options),
    delete: (kind, name) => host().secrets.delete(kind, name),
    list: (kind) => host().secrets.list(kind),
  }
}

export function hostSecretKeyHandover(): SecretKeyHandover {
  return {
    wanted: () => host().handover.wanted(),
    offer: (key) => host().handover.offer(key),
  }
}

/** Where a domain's older builds kept its secrets; declared as it's installed, before it reads them. */
export function adoptLegacySecrets(files: LegacyFiles): void {
  legacy.push(files)
}
