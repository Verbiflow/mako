import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

/**
 * Providers take the host's secrets while its modules load; Electron's
 * `safeStorage` arrives after, from the shell, and is what seals them. In a
 * process of its own, with MAKO_DATA_ROOT set before anything resolves the
 * host's environment, so the store is a scratch one and never the person's.
 */
const root = await mkdtemp(join(tmpdir(), "mako-host-secrets-order-"))
try {
  process.env.MAKO_DATA_ROOT = root
  const { hostEnvironment } = await import("../electron/host-environment.ts")
  assert.equal(hostEnvironment().userRoot, root, "the store is this test's scratch root")
  const { hostSecrets, provideSafeStorage } = await import("../electron/host-secrets.ts")

  const taken = hostSecrets()
  let wrapped = 0
  const safeStorage = {
    available: async () => true,
    encrypt: async (value: string) => {
      wrapped++
      return Buffer.from(value)
    },
    decrypt: async (value: Buffer) => value.toString(),
  }
  provideSafeStorage(safeStorage)
  await taken.write("saved-key", "proof", "value")
  assert.equal((await taken.read("saved-key", "proof"))?.value, "value")
  assert.equal(wrapped, 1, "safeStorage wraps the data key")
  assert.throws(() => provideSafeStorage(safeStorage), /opened before/, "safeStorage can't change once the store is open")

  console.log("Host secrets order: a store taken while the host loads opens on its first use, sealed by the safeStorage the shell gave after")
} finally {
  await rm(root, { recursive: true, force: true })
}
