import { randomUUID } from "node:crypto"
import { readFile, rm, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { z } from "zod"
import type { Secrets } from "../base/secrets.js"
import type { SelectableAccountCapability } from "./account-capability.js"
import type { AccountRoot } from "./accounts-common.js"
import { placeSecret, removeSecret, type CloudSignInCapability, type CloudSignInPayload, type CloudSignInPlace } from "./cloud-sign-in.js"

export const isApiKeyAccount = (name: string) => /^key\.[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(name)
export const apiKeyAccountName = () => `key.${randomUUID()}`

/**
 * A key as a cloud machine is given it, in every key-taking harness's one shape: the key the account's selected key
 * account runs on, which the machine hands that harness the way the Mac does (`configure`), not a harness's own file.
 */
const CloudKeyPayloadSchema = z.object({ savedApiKey: z.string().min(1).max(4096) }).strict()
export const cloudKeyPayload = (key: string): CloudSignInPayload => ({ savedApiKey: key })
const isCloudKey = (payload: CloudSignInPayload) => CloudKeyPayloadSchema.safeParse(payload).success

/** Where a machine keeps a harness's key: in its folder in memory, linked from the machine user's home. */
const cloudKeyPath = (provider: string) => join(".mako", "cloud-keys", provider)
/** The account folder a cloud key's harness keeps its own state in, as a saved key's does on the Mac. */
const CLOUD_KEY_ACCOUNT = "cloud-key"

/** The key a machine was given for `provider`, or null on a Mac and on a machine given none. Read as the harness launches. */
async function cloudKey(provider: string): Promise<{ key: string; revision: string } | null> {
  const path = join(homedir(), cloudKeyPath(provider))
  const [text, stamp] = await Promise.all([readFile(path, "utf8").catch(() => null), stat(path).catch(() => null)])
  if (!text || !stamp) return null
  // The file's own times stand for the key in the revision: a key is never fingerprinted.
  return { key: text.trim(), revision: `cloud-key:${stamp.mtimeMs}:${stamp.ino}` }
}

/**
 * A cloud machine's half for a harness that runs on keys: a key payload goes where `cloudKey` reads it, and whatever the
 * harness's own adapter had written goes, as its own sign-in goes when a key arrives; anything else is the adapter's.
 */
function withCloudKeys(provider: string, native: CloudSignInCapability | undefined, secrets: Secrets): CloudSignInCapability {
  const prefix = `provider/${provider}/`
  const removeNative = async (place: CloudSignInPlace) => (native ? native.remove(place) : false)
  const adapter: CloudSignInCapability = {
    export: async (env) => (native ? native.export(env) : null),
    async keySignIn(name) {
      if (!isApiKeyAccount(name)) return null
      const record = await secrets.read("saved-key", prefix + name)
      return record ? { label: null, expiresAt: null, payload: cloudKeyPayload(record.value) } : null
    },
    async install(payload, place) {
      if (isCloudKey(payload)) {
        await removeNative(place)
        await placeSecret(place, cloudKeyPath(provider), CloudKeyPayloadSchema.parse(payload).savedApiKey)
        return
      }
      if (!native) throw new Error("This harness's sign-in on a machine is a key")
      await removeSecret(place, cloudKeyPath(provider))
      await native.install(payload, place)
    },
    async remove(place) {
      const [key, own] = await Promise.all([removeSecret(place, cloudKeyPath(provider)), removeNative(place)])
      return key || own
    },
  }
  if (native?.chain) adapter.chain = native.chain.bind(native)
  if (native?.mirror) adapter.mirror = native.mirror
  if (native?.unshared) adapter.unshared = native.unshared
  return adapter
}

/** Each pasted key is a separate selectable account, its key in the keychain alone: never in settings or account metadata. */
export function withApiKeyAccounts(
  native: SelectableAccountCapability,
  root: AccountRoot,
  secrets: Secrets,
  configure: (key: string, env: NodeJS.ProcessEnv, dir: string) => Promise<NodeJS.ProcessEnv>,
): SelectableAccountCapability {
  const prefix = `provider/${native.provider}/`
  const records = async () => (await secrets.list("saved-key")).filter((r) => r.name.startsWith(prefix))
  const keyUsage = async () => ({ status: "unavailable" as const, detail: "Usage is billed to your API key." })
  return {
    ...native,
    usedElsewhere: native.usedElsewhere && { ...native.usedElsewhere, read: (name) =>
      isApiKeyAccount(name) ? keyUsage() : native.usedElsewhere!.read(name) },
    async addApiKey(name, key) {
      if (!await secrets.durable()) throw new Error("Unlock your keychain to save an API key.")
      await secrets.write("saved-key", prefix + name, key)
    },
    async listAccounts(selection) {
      const [ordinary, keys] = await Promise.all([native.listAccounts(selection), records()])
      return [...ordinary.filter((a) => !isApiKeyAccount(a.name)), ...keys.map((record) => {
        const name = record.name.slice(prefix.length)
        return { harness: native.provider, name, dir: root.dir(native.provider, name), active: selection === name,
          source: "mako" as const, route: "managed" as const, authType: "api" as const }
      })]
    },
    async accountEnv(name, base) {
      if (!name || !isApiKeyAccount(name)) {
        // A cloud machine given a key runs its default account on it, as the Mac runs the key account it came from.
        const given = !name || name === "default" ? await cloudKey(native.provider) : null
        return given ? configure(given.key, { ...base }, root.dir(native.provider, CLOUD_KEY_ACCOUNT)) : native.accountEnv(name, base)
      }
      // The device reads its own saved key for a launch, as Cursor's are read. `base` is the host's environment: a
      // MAKO_THREAD_ID or PWD in it came from whatever started the host, never the launching Thread, so no lease names it.
      const record = await secrets.read("saved-key", prefix + name)
      if (!record) throw new Error(`The selected ${native.label} API key is missing. Choose an account in Settings.`)
      return configure(record.value, { ...base }, root.dir(native.provider, name))
    },
    selectedAccount: (name, env) => name && isApiKeyAccount(name) ? { name, dir: root.dir(native.provider, name) } : native.selectedAccount(name, env),
    credentialRevision: async (name, env, hold) => {
      if (isApiKeyAccount(name)) return (await records()).find((r) => r.name === prefix + name)?.version ?? "missing"
      const given = name === "default" ? await cloudKey(native.provider) : null
      return given ? given.revision : native.credentialRevision(name, env, hold)
    },
    accountUsage: (name) => isApiKeyAccount(name) ? keyUsage() : native.accountUsage(name),
    async removeAccount(name) {
      if (!isApiKeyAccount(name)) return native.removeAccount(name)
      await secrets.delete("saved-key", prefix + name)
      // What the harness kept in the key's own folder (Claude Code's config, Grok's sign-in file) goes with it.
      await rm(root.dir(native.provider, name), { recursive: true, force: true })
      return {}
    },
    cloudSignIn: withCloudKeys(native.provider, native.cloudSignIn, secrets),
  }
}
