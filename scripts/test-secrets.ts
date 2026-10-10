import assert from "node:assert/strict"
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  adoptingLegacy,
  aesSealer,
  fileSecrets,
  handedKey,
  memorySecrets,
  plainSealer,
  SecretUnavailable,
  wrappedKey,
  type SecretKey,
  type SecretKind,
  type Secrets,
} from "../electron/secrets.ts"
import type { SecretEncryption } from "../electron/secure-storage.ts"

const root = await mkdtemp(join(tmpdir(), "mako-secrets-"))

/** A stand-in keychain: reversible, refusing what another keychain sealed, counting every unwrap. */
function keychain(id = "one"): SecretEncryption & { open: boolean; decrypts: number } {
  const state = {
    open: true,
    decrypts: 0,
    available: async () => state.open,
    encrypt: async (value: string) => Buffer.from(`${id}:${Buffer.from(value).toString("base64")}`),
    async decrypt(value: Buffer) {
      state.decrypts++
      if (!state.open) throw new Error("keychain locked")
      const [owner, body] = value.toString().split(":")
      if (owner !== id || body === undefined) throw new Error("not this keychain's")
      return Buffer.from(body, "base64").toString()
    },
  }
  return state
}

function memoryKey(): SecretKey {
  const key = Buffer.alloc(32, 7)
  return { available: async () => true, key: async () => key }
}

const isLocked = (reason: "unavailable" | "unreadable") => ({ name: "SecretLocked", reason })

/** What every backend promises, the same for all of them. */
async function contract(label: string, secrets: Secrets): Promise<void> {
  assert.equal(await secrets.durable(), true, `${label}: durable`)
  assert.equal(await secrets.read("saved-key", "cursor"), null, `${label}: nothing saved reads as null`)
  assert.deepEqual(await secrets.list("saved-key"), [])

  const first = await secrets.write("saved-key", "cursor", "key-one", { expiresAt: "2027-01-01T00:00:00.000Z" })
  assert.match(first.version, /^[0-9a-f-]{36}$/, `${label}: a version is opaque`)
  const read = await secrets.read("saved-key", "cursor")
  assert.deepEqual(read, first, `${label}: a write reads back whole`)
  assert.equal(read?.expiresAt, "2027-01-01T00:00:00.000Z")

  const second = await secrets.write("saved-key", "cursor", "key-two")
  assert.notEqual(second.version, first.version, `${label}: every write is a new version`)
  assert.equal((await secrets.read("saved-key", "cursor"))?.value, "key-two")
  assert.equal((await secrets.read("saved-key", "cursor"))?.expiresAt, null, `${label}: a write without expiry clears it`)

  await secrets.write("saved-key", "utility/openai", "sk-🔑-unicode")
  await secrets.write("saved-key", "cursor/work", "work-key")
  await secrets.write("mako-sign-in", "cloud/dev", JSON.stringify({ token: "t" }))
  const listed = await secrets.list("saved-key")
  assert.deepEqual(listed.map((entry) => entry.name), ["cursor", "cursor/work", "utility/openai"], `${label}: listed by name, one kind`)
  for (const entry of listed) assert.equal("value" in entry, false, `${label}: a listing never carries the value`)
  assert.equal((await secrets.read("saved-key", "utility/openai"))?.value, "sk-🔑-unicode")

  await secrets.delete("saved-key", "cursor")
  assert.equal(await secrets.read("saved-key", "cursor"), null, `${label}: deleted`)
  await secrets.delete("saved-key", "cursor")
  assert.equal((await secrets.read("saved-key", "cursor/work"))?.value, "work-key", `${label}: deleting one leaves the names below it`)

  for (const name of ["", "Cursor", "../escape", "a/../b", "/abs", "a//b", "a/b/c/d/e", "x".repeat(65)])
    await assert.rejects(secrets.write("saved-key", name, "v"), `${label}: "${name}" is not a name`)
  // SAFETY: deliberately not a kind, to prove the store checks kinds at run time too.
  await assert.rejects(secrets.read("password" as SecretKind, "cursor"), `${label}: an unknown kind is refused`)
  await assert.rejects(secrets.write("saved-key", "big", "x".repeat(1024 * 1024 + 1)), /1 MiB/)
  await assert.rejects(secrets.write("saved-key", "expiry", "v", { expiresAt: "soon" }), `${label}: an expiry is a time`)

  const racing = await Promise.all(Array.from({ length: 12 }, (_, i) => secrets.write("saved-key", "race", `v${i}`)))
  assert.equal((await secrets.read("saved-key", "race"))?.value, racing.at(-1)?.value, `${label}: writes land in order`)
}

try {
  await contract("memory", memorySecrets())
  await contract("file, sealed", fileSecrets(join(root, "aes"), aesSealer(memoryKey())))
  await contract("file, plain (tmpfs)", fileSecrets(join(root, "plain"), plainSealer()))
  await contract("file, keychain key", fileSecrets(join(root, "wrapped"), aesSealer(wrappedKey(join(root, "wrapped", "data-key"), keychain()))))

  // Nothing kept where nothing can be: the caller decides what to do instead.
  await assert.rejects(memorySecrets({ durable: false }).write("saved-key", "cursor", "v"), SecretUnavailable)
  const closed = keychain()
  closed.open = false
  const shut = fileSecrets(join(root, "shut"), aesSealer(wrappedKey(join(root, "shut", "data-key"), closed)))
  assert.equal(await shut.durable(), false)
  await assert.rejects(shut.write("saved-key", "cursor", "v"), SecretUnavailable)
  assert.deepEqual(await readdir(join(root, "shut")).catch(() => []), [], "a refused write leaves nothing behind")

  // The Mac's records on disk.
  {
    const directory = join(root, "disk")
    const encryption = keychain()
    const secrets = fileSecrets(directory, aesSealer(wrappedKey(join(directory, "data-key"), encryption)))
    await secrets.write("saved-key", "cursor", "the-real-value")
    await secrets.write("saved-key", "utility/openai", "other-value")
    const path = join(directory, "saved-key", "cursor.json")
    assert.equal((await stat(path)).mode & 0o777, 0o600, "a record is the user's alone")
    assert.equal((await stat(join(directory, "saved-key"))).mode & 0o777, 0o700)
    assert.equal((await stat(join(directory, "data-key"))).mode & 0o777, 0o600)
    const text = await readFile(path, "utf8")
    assert.equal(text.includes("the-real-value"), false, "the value is sealed")
    assert.match(text, /"name":"cursor"/, "what it's for stays readable")
    const keyFile = JSON.parse(await readFile(join(directory, "data-key"), "utf8"))
    assert.deepEqual(Object.keys(keyFile).sort(), ["format", "id", "wrapped"])
    assert.equal(Buffer.from(keyFile.wrapped, "base64").toString().startsWith("one:"), true, "the data key is kept wrapped by the keychain")

    // One unwrap per process, however many secrets are read.
    const reopened = keychain()
    const again = fileSecrets(directory, aesSealer(wrappedKey(join(directory, "data-key"), reopened)))
    for (let i = 0; i < 5; i++) assert.equal((await again.read("saved-key", "cursor"))?.value, "the-real-value")
    assert.equal((await again.read("saved-key", "utility/openai"))?.value, "other-value")
    assert.equal(reopened.decrypts, 1, "the keychain is asked once")

    // A record moved, relabelled or changed doesn't open.
    const swapped = join(root, "swapped")
    await mkdir(join(swapped, "saved-key", "utility"), { recursive: true })
    await copyFile(join(directory, "data-key"), join(swapped, "data-key"))
    await copyFile(join(directory, "saved-key", "utility", "openai.json"), join(swapped, "saved-key", "cursor.json"))
    const swap = fileSecrets(swapped, aesSealer(wrappedKey(join(swapped, "data-key"), keychain())))
    await assert.rejects(swap.read("saved-key", "cursor"), isLocked("unreadable"), "a record copied over another is refused")
    const record = JSON.parse(text)
    await writeFile(join(swapped, "saved-key", "cursor.json"), JSON.stringify({ ...record, version: crypto.randomUUID() }))
    await assert.rejects(swap.read("saved-key", "cursor"), isLocked("unreadable"), "a relabelled version is refused")
    const [iv, tag, data] = String(record.sealed).split(".")
    const changed = Buffer.from(data ?? "", "base64url")
    changed[0] = (changed[0] ?? 0) ^ 1
    const flipped = [iv, tag, changed.toString("base64url")].join(".")
    await writeFile(join(swapped, "saved-key", "cursor.json"), JSON.stringify({ ...record, sealed: flipped }))
    await assert.rejects(swap.read("saved-key", "cursor"), isLocked("unreadable"), "a changed value is refused")
    await writeFile(join(swapped, "saved-key", "cursor.json"), JSON.stringify({ ...record, sealer: "plain", sealed: "planted" }))
    await assert.rejects(swap.read("saved-key", "cursor"), isLocked("unreadable"), "a plain record planted in the sealed store is never trusted")
    await writeFile(join(swapped, "saved-key", "cursor.json"), "{not json")
    await assert.rejects(swap.read("saved-key", "cursor"), isLocked("unreadable"))
    assert.deepEqual((await swap.list("saved-key")).map((entry) => entry.name), [], "a broken record is left out of the list")

    // Another keychain, a locked one, or a lost data key.
    await assert.rejects(fileSecrets(directory, aesSealer(wrappedKey(join(directory, "data-key"), keychain("two")))).read("saved-key", "cursor"), isLocked("unreadable"))
    const locked = keychain()
    locked.open = false
    await assert.rejects(fileSecrets(directory, aesSealer(wrappedKey(join(directory, "data-key"), locked))).read("saved-key", "cursor"), isLocked("unavailable"))
    assert.deepEqual((await fileSecrets(directory, aesSealer(wrappedKey(join(directory, "data-key"), locked))).list("saved-key")).map((entry) => entry.name), ["cursor", "utility/openai"], "listing never needs the keychain")
    await assert.rejects(fileSecrets(directory, aesSealer(wrappedKey(join(root, "nowhere", "data-key"), keychain()))).read("saved-key", "cursor"), isLocked("unreadable"))
    const relabelled = join(root, "relabelled")
    await mkdir(relabelled)
    await writeFile(join(relabelled, "data-key"), JSON.stringify({ ...keyFile, id: "A".repeat(43) }))
    await assert.rejects(fileSecrets(directory, aesSealer(wrappedKey(join(relabelled, "data-key"), keychain()))).read("saved-key", "cursor"), isLocked("unreadable"), "a key file naming another key is refused")

    // Handed over by a process that reaches the keychain, to one that can't.
    const handed = handedKey(join(directory, "data-key"))
    const served = fileSecrets(directory, aesSealer(handed))
    assert.equal(await served.durable(), false, "nothing is kept before the key arrives")
    await assert.rejects(served.read("saved-key", "cursor"), isLocked("unavailable"), "a record waits for the key, it isn't broken")
    await assert.rejects(served.write("saved-key", "cursor", "v"), SecretUnavailable)
    assert.deepEqual((await served.list("saved-key")).map((entry) => entry.name), ["cursor", "utility/openai"])
    const real = await wrappedKey(join(directory, "data-key"), keychain()).key(false)
    assert.ok(real)
    await assert.rejects(handed.offer(Buffer.alloc(32, 9)), /isn't this store's/, "another key is refused")
    await assert.rejects(handed.offer(real.subarray(0, 16)), /32 bytes/)
    await assert.rejects(handedKey(join(root, "nowhere", "data-key")).offer(real), /no data key yet/, "the key is never made on this side")
    await assert.rejects(handedKey(join(relabelled, "data-key")).offer(real), /isn't this store's/)
    await handed.offer(real)
    real.fill(0)
    assert.equal((await served.read("saved-key", "cursor"))?.value, "the-real-value", "the key is held, not the caller's buffer")
    await served.write("saved-key", "handed", "written-under-handed")
    assert.equal((await again.read("saved-key", "handed"))?.value, "written-under-handed", "the keychain side reads what the handed side wrote")
  }

  // Two hosts sharing the user's store make one data key between them.
  {
    const shared = join(root, "shared")
    const hosts = Array.from({ length: 6 }, () => fileSecrets(shared, aesSealer(wrappedKey(join(shared, "data-key"), keychain()))))
    await Promise.all(hosts.map((host, i) => host.write("saved-key", `host-${i}`, `value-${i}`)))
    for (const host of hosts)
      for (let i = 0; i < hosts.length; i++) assert.equal((await host.read("saved-key", `host-${i}`))?.value, `value-${i}`, "every host opens every other's")
    assert.deepEqual((await readdir(shared)).filter((entry) => entry.includes("tmp")), [], "no half-made key is left behind")
  }

  // Older builds' files, taken over on first use.
  {
    const directory = join(root, "legacy")
    const old = join(directory, "old")
    await mkdir(old, { recursive: true })
    const encryption = keychain()
    const seal = async (name: string, value: string) => writeFile(join(old, `${name}.bin`), await encryption.encrypt(value))
    const legacy = (store: Secrets, files = encryption) =>
      adoptingLegacy(store, {
        encryption: files,
        path: (kind, name) => (kind === "saved-key" && /^[a-z]+$/.test(name) ? join(old, `${name}.bin`) : null),
        names: async (kind) => (kind === "saved-key" ? (await readdir(old)).map((file) => file.replace(/\.bin$/, "")) : []),
      })
    const inner = fileSecrets(join(directory, "store"), aesSealer(memoryKey()))
    const secrets = legacy(inner)
    await contract("adopting, nothing older", legacy(memorySecrets(), keychain()))

    await seal("alpha", "alpha-value")
    const reads = await Promise.all([secrets.read("saved-key", "alpha"), secrets.read("saved-key", "alpha")])
    assert.deepEqual(reads.map((record) => record?.value), ["alpha-value", "alpha-value"], "an older file reads as its record")
    assert.equal(encryption.decrypts, 1, "concurrent reads take it over once")
    await assert.rejects(stat(join(old, "alpha.bin")), "the older file is gone once its record is saved")
    assert.equal((await inner.read("saved-key", "alpha"))?.value, "alpha-value")

    await seal("beta", "beta-value")
    const shut = keychain()
    shut.open = false
    await assert.rejects(legacy(inner, shut).read("saved-key", "beta"), isLocked("unavailable"), "a locked keychain reads as locked, as before")
    await stat(join(old, "beta.bin"))
    await writeFile(join(old, "gamma.bin"), "garbage")
    await assert.rejects(secrets.read("saved-key", "gamma"), isLocked("unreadable"))
    await stat(join(old, "gamma.bin"))
    const listing = await legacy(inner, shut).list("saved-key")
    assert.deepEqual(listing.map((entry) => [entry.name, entry.version === "legacy"]), [["alpha", false], ["beta", true], ["gamma", true]], "files not yet taken over are still listed")

    await seal("delta", "older")
    await inner.write("saved-key", "delta", "newer")
    assert.equal((await secrets.read("saved-key", "delta"))?.value, "newer", "a record saved since wins")
    await assert.rejects(stat(join(old, "delta.bin")))

    await seal("epsilon", "older")
    await secrets.write("saved-key", "epsilon", "replaced")
    await assert.rejects(stat(join(old, "epsilon.bin")), "a write retires the older file")
    await seal("zeta", "older")
    await secrets.delete("saved-key", "zeta")
    await assert.rejects(stat(join(old, "zeta.bin")), "a delete removes the older file too")
    assert.equal(await secrets.read("saved-key", "zeta"), null)

    assert.equal((await secrets.read("saved-key", "beta"))?.value, "beta-value", "once the keychain answers, the file is taken over")
  }

  console.log("Secrets: one contract for memory, sealed file, tmpfs file and keychain-key stores; seals bound to kind, name and version; one unwrap per process; shared-key race; locked and unreadable kept apart; older files taken over once")
} finally {
  await rm(root, { recursive: true, force: true })
}
