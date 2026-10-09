import assert from "node:assert/strict"
import { createCipheriv, pbkdf2Sync } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openHostSecrets } from "../electron/host-secrets.ts"
import type { Keychain, KeychainItem, KeychainRead } from "../electron/keychain.ts"
import { securityValue } from "../electron/keychain.ts"
import { chromiumSafeStorage, KeychainUnavailable, NO_ENCRYPTION, safeStorageItem } from "../electron/secure-storage.ts"

/**
 * A host in Node mode reads the keychain item behind Electron's `safeStorage`
 * itself, and seals as Chromium does. A stand-in keychain here; the real one
 * is proven by test-secrets-keychain.mjs against a scratch item.
 */
const root = await mkdtemp(join(tmpdir(), "mako-keychain-safe-storage-"))
const home = join(root, "home")
await mkdir(join(home, "Library", "Keychains"), { recursive: true })

/** The login keychain: counts reads, can refuse. */
function keychain(items: Record<string, string> = {}) {
  const state = {
    items: new Map(Object.entries(items)),
    reads: 0,
    refuse: false,
  }
  const keychain: Keychain = {
    async read(item): Promise<KeychainRead> {
      state.reads++
      if (state.refuse) return { kind: "failed", reason: "User canceled the operation." }
      const value = state.items.get(`${item.service}/${item.account}`)
      return value === undefined ? { kind: "missing" } : { kind: "found", value }
    },
    async write(item: KeychainItem, value: string) { state.items.set(`${item.service}/${item.account}`, value) },
    async delete(item: KeychainItem) { return state.items.delete(`${item.service}/${item.account}`) },
  }
  return { state, keychain }
}

const password = "a7Lh3eT6UjvF4qZ2bW9xNg=="
const item = safeStorageItem("mako")
const itemKey = `${item.service}/${item.account}`

try {
  assert.deepEqual(item, { service: "mako Safe Storage", account: "mako Key" }, "Electron's item for an app named mako")

  // Chromium's format on macOS, from its own recipe.
  const chromium = (value: string) => {
    const key = pbkdf2Sync(password, "saltysalt", 1003, 16, "sha1")
    const cipher = createCipheriv("aes-128-cbc", key, Buffer.alloc(16, " "))
    return Buffer.concat([Buffer.from("v10"), cipher.update(value, "utf8"), cipher.final()])
  }
  const { state, keychain: login } = keychain({ [itemKey]: password })
  const storage = chromiumSafeStorage({ appName: "mako", keychain: login, platform: "darwin", home })
  assert.equal(await storage.available(), true)
  assert.equal(state.reads, 0, "being available asks the keychain nothing")
  assert.deepEqual(await storage.encrypt("saved key ü"), chromium("saved key ü"), "sealed exactly as safeStorage seals")
  assert.equal(await storage.decrypt(chromium("from Electron")), "from Electron", "opens what safeStorage sealed")
  await Promise.all([storage.decrypt(chromium("a")), storage.decrypt(chromium("b")), storage.encrypt("c")])
  assert.equal(state.reads, 1, "the keychain is read once per process")
  await assert.rejects(storage.decrypt(Buffer.from("plain")), /wasn't sealed by safeStorage/, "only v10 values open")

  // No item yet: Electron makes it, never this.
  const empty = keychain()
  const before = chromiumSafeStorage({ appName: "mako", keychain: empty.keychain, platform: "darwin", home })
  await assert.rejects(before.encrypt("x"), KeychainUnavailable)
  assert.equal(empty.state.items.size, 0, "the password is never made here")
  assert.equal(await before.available(), true, "missing isn't refused: Electron may make it")
  empty.state.items.set(itemKey, password)
  assert.equal(await before.decrypt(chromium("now")), "now", "read once it exists")

  // A refusal holds for the process: nothing asks again.
  const refusing = keychain({ [itemKey]: password })
  refusing.state.refuse = true
  const refused = chromiumSafeStorage({ appName: "mako", keychain: refusing.keychain, platform: "darwin", home })
  await assert.rejects(refused.decrypt(chromium("x")), KeychainUnavailable)
  assert.equal(await refused.available(), false)
  await assert.rejects(refused.decrypt(chromium("x")), KeychainUnavailable)
  assert.equal(refusing.state.reads, 1, "one prompt, not one per secret")

  assert.equal(await chromiumSafeStorage({ appName: "mako", keychain: login, platform: "linux", home }).available(), false, "Linux keeps its password elsewhere")
  assert.equal(await chromiumSafeStorage({ appName: "mako", keychain: login, platform: "darwin", home: join(root, "no-home") }).available(), false, "no login keychain, no ask")

  // The host in Node mode: the desktop's handover first, the keychain itself without one.
  const userRoot = join(root, "user")
  const electronSide = keychain({ [itemKey]: password })
  const electron = openHostSecrets({ userRoot, encryption: chromiumSafeStorage({ appName: "mako", keychain: electronSide.keychain, platform: "darwin", home }), legacy: [] })
  await electron.secrets.write("saved-key", "cursor", "cursor-key")

  const alone = keychain({ [itemKey]: password })
  const nodeMode = openHostSecrets({ userRoot, encryption: NO_ENCRYPTION, keychain: chromiumSafeStorage({ appName: "mako", keychain: alone.keychain, platform: "darwin", home }), legacy: [] })
  assert.equal((await nodeMode.secrets.read("saved-key", "cursor"))?.value, "cursor-key", "a host with no desktop reads its key from the keychain")
  assert.equal(alone.state.reads, 1)
  assert.equal(await nodeMode.handover.wanted(), true, "a desktop still hands its key over, so a successor needn't ask")

  const started = keychain({ [itemKey]: password })
  const graced = openHostSecrets({ userRoot, encryption: NO_ENCRYPTION, keychain: chromiumSafeStorage({ appName: "mako", keychain: started.keychain, platform: "darwin", home }), legacy: [], handoverUntil: Date.now() + 5_000 })
  const waiting = graced.secrets.read("saved-key", "cursor")
  const desktopKey = await electronKey(userRoot, electronSide.keychain)
  await graced.handover.offer(desktopKey)
  assert.equal((await waiting)?.value, "cursor-key")
  assert.equal(started.state.reads, 0, "a desktop that started the host hands the key over before the host asks macOS as Mako Helper")

  const late = keychain({ [itemKey]: password })
  const lapsed = openHostSecrets({ userRoot, encryption: NO_ENCRYPTION, keychain: chromiumSafeStorage({ appName: "mako", keychain: late.keychain, platform: "darwin", home }), legacy: [], handoverUntil: Date.now() + 100 })
  const startedAt = Date.now()
  assert.equal((await lapsed.secrets.read("saved-key", "cursor"))?.value, "cursor-key")
  assert.ok(Date.now() - startedAt >= 90, "with no desktop, it waits out the grace once")
  assert.equal(late.state.reads, 1)

  const denied = keychain({ [itemKey]: password })
  denied.state.refuse = true
  const refusedHost = openHostSecrets({ userRoot, encryption: NO_ENCRYPTION, keychain: chromiumSafeStorage({ appName: "mako", keychain: denied.keychain, platform: "darwin", home }), legacy: [] })
  await assert.rejects(refusedHost.secrets.read("saved-key", "cursor"), { name: "SecretLocked", reason: "unavailable" }, "refused is waiting for a key, not broken")
  await assert.rejects(refusedHost.secrets.read("saved-key", "cursor"), { name: "SecretLocked", reason: "unavailable" })
  assert.equal(denied.state.reads, 1, "after a refusal the host doesn't ask again")
  await refusedHost.handover.offer(desktopKey)
  assert.equal((await refusedHost.secrets.read("saved-key", "cursor"))?.value, "cursor-key", "the desktop's handover still opens it")

  // An older file sealed by safeStorage is taken over in Node mode too.
  const legacyDirectory = join(root, "legacy")
  await mkdir(legacyDirectory)
  await writeFile(join(legacyDirectory, "openai.bin"), chromium("legacy-openai-key"))
  const adopting = openHostSecrets({
    userRoot,
    encryption: NO_ENCRYPTION,
    keychain: chromiumSafeStorage({ appName: "mako", keychain: keychain({ [itemKey]: password }).keychain, platform: "darwin", home }),
    legacy: [{
      path: (kind, name) => kind === "saved-key" ? join(legacyDirectory, `${name}.bin`) : null,
      names: async (kind) => kind === "saved-key" ? ["openai"] : [],
    }],
  })
  assert.equal((await adopting.secrets.read("saved-key", "openai"))?.value, "legacy-openai-key")
  await assert.rejects(readFile(join(legacyDirectory, "openai.bin")), { code: "ENOENT" }, "the older file is gone once its record is written")

  assert.equal(securityValue('password: "plain"\n'), "plain")
  assert.equal(securityValue(`password: 0x${Buffer.from("a\nb").toString("hex").toUpperCase()}  "a\\012b"\n`), "a\nb")
  assert.equal(securityValue("keychain: \"/Users/x/login.keychain-db\"\n"), null)

  console.log("Keychain safe storage: seals and opens exactly as safeStorage does on macOS; one keychain read per process; never makes the password; a refusal asks once; a Node-mode host takes the desktop's handover first, reads the keychain without one, and takes over older files")
} finally {
  await rm(root, { recursive: true, force: true })
}

async function electronKey(userRoot: string, login: Keychain): Promise<Buffer> {
  const { wrappedKey } = await import("../electron/secrets.ts")
  const { dataKeyPath } = await import("../electron/host-secrets.ts")
  const key = await wrappedKey(dataKeyPath(userRoot), chromiumSafeStorage({ appName: "mako", keychain: login, platform: "darwin", home })).key(false)
  assert.ok(key)
  return key
}
