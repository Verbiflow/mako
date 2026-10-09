import assert from "node:assert/strict"
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { userRootFor } from "../electron/host-environment.ts"
import { cloudLegacyFiles, cloudSignInName } from "../electron/cloud-account.ts"
import { openHostSecrets } from "../electron/host-secrets.ts"
import { CursorAccountKeys, CursorCredentialStore, cursorLegacyFiles } from "../electron/providers/cursor/sdk/credentials.ts"
import type { SecretEncryption } from "../electron/secure-storage.ts"
import { utilityModelDirectory } from "../electron/utility-model-location.ts"
import { UtilityModelStore, utilityLegacyFiles } from "../electron/utility-model-store.ts"

/**
 * The host's one store, on a profile laid out as the installed app and
 * `npm run dev` lay it out: what older builds sealed in files of their own,
 * at their real paths, is read through `Secrets` and the files retire.
 */
const root = await mkdtemp(join(tmpdir(), "mako-host-secrets-"))
const keychain: SecretEncryption = {
  available: async () => true,
  encrypt: async (value) => Buffer.from(`sealed:${Buffer.from(value).toString("base64")}`),
  decrypt: async (value) => Buffer.from(value.toString().slice("sealed:".length), "base64").toString(),
}
const seal = async (path: string, value: Record<string, string | number>) => {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, await keychain.encrypt(JSON.stringify(value)))
}

try {
  const home = join(root, "home")
  const appData = join(home, "Library", "Application Support")
  const dataRoot = join(appData, "Mako-dev")
  const userRoot = userRootFor({ dataRoot, appData, home })
  const cursorRoot = join(userRoot, "cursor-sdk")
  assert.equal(userRoot, join(home, ".mako"), "a profile's host shares the user's secrets")
  assert.equal(cloudSignInName(dataRoot), "cloud/mako-dev")
  assert.equal(cloudSignInName(join(appData, "Mako")), "cloud/mako", "the installed app's sign-in is its own")
  assert.equal(cloudSignInName("/tmp/Weird Name!"), "cloud/weird-name-")

  const cursorKey = { version: 1, apiKey: "key_default_0123456789abcdef", method: "pasted", savedAt: "2026-10-01T00:00:00Z" }
  const workKey = { ...cursorKey, apiKey: "key_work_0123456789abcdef" }
  const utility = { provider: "openai", model: "gpt-test", contextTokens: 32_000, apiKey: "sk-test-utility" }
  await seal(join(cursorRoot, "credential.bin"), cursorKey)
  await seal(join(cursorRoot, "accounts", "work.bin"), workKey)
  await seal(join(utilityModelDirectory({ dataRoot, appData, home }), "openai.enc"), utility)
  await seal(join(dataRoot, "cloud-account"), { version: 1, cloud: "https://cloud.example", credential: "mako_dc_x" })

  const domains = [cursorLegacyFiles(cursorRoot), utilityLegacyFiles(utilityModelDirectory({ dataRoot, appData, home })), cloudLegacyFiles(dataRoot)]
  const secrets = openHostSecrets({ userRoot, encryption: keychain, legacy: domains }).secrets
  assert.equal((await new CursorCredentialStore(secrets).load())?.apiKey, cursorKey.apiKey, "Cursor's key reads from its older file")
  const accounts = new CursorAccountKeys(secrets)
  assert.deepEqual(await accounts.names(), ["work"], "an added account's older file is listed")
  assert.equal((await accounts.store("work").load())?.apiKey, workKey.apiKey)
  const models = new UtilityModelStore(utilityModelDirectory({ dataRoot, appData, home }), secrets)
  assert.equal((await models.load("openai"))?.apiKey, utility.apiKey, "a utility connection reads from its older file")
  assert.equal(JSON.parse((await secrets.read("mako-sign-in", cloudSignInName(dataRoot)))?.value ?? "{}").credential, "mako_dc_x")

  for (const path of [join(cursorRoot, "credential.bin"), join(cursorRoot, "accounts", "work.bin"), join(userRoot, "utility-models", "openai.enc"), join(dataRoot, "cloud-account")])
    await assert.rejects(stat(path), `${path} retired`)
  const kept = await readdir(join(userRoot, "secrets"), { recursive: true })
  assert.deepEqual(kept.filter((entry) => entry.endsWith(".json")).sort(), [
    join("mako-sign-in", "cloud", "mako-dev.json"),
    join("saved-key", "cursor", "work.json"),
    join("saved-key", "cursor.json"),
    join("saved-key", "utility", "openai.json"),
  ].sort(), "every secret is one record in the user's store")
  for (const entry of kept.filter((name) => name.endsWith(".json")))
    for (const value of [cursorKey.apiKey, workKey.apiKey, utility.apiKey, "mako_dc_x"])
      assert.equal((await readFile(join(userRoot, "secrets", entry), "utf8")).includes(value), false, "no value in the clear")

  const again = openHostSecrets({ userRoot, encryption: keychain, legacy: domains }).secrets
  assert.equal((await new CursorCredentialStore(again).load())?.apiKey, cursorKey.apiKey, "the next start reads the record")

  const isolated = join(root, "isolated")
  assert.equal(userRootFor({ dataRoot: isolated, appData, home }), isolated, "a test's host keeps its own")
  const apart = openHostSecrets({ userRoot: isolated, encryption: keychain, legacy: [cursorLegacyFiles(join(isolated, "cursor"))] }).secrets
  assert.equal(await new CursorCredentialStore(apart).load(), null, "and never sees the user's keys")

  console.log("Host secrets: one store per user, older Cursor, account, utility and cloud files taken over at their real paths, nothing in the clear, isolated hosts apart")
} finally {
  await rm(root, { recursive: true, force: true })
}
