import { randomUUID } from "node:crypto"
import type { Secrets } from "../base/secrets.js"
import { GrantedSecrets } from "../base/secret-grants.js"
import type { SelectableAccountCapability } from "./account-capability.js"
import type { AccountRoot } from "./accounts-common.js"

export const isApiKeyAccount = (name: string) => /^key\.[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(name)
export const apiKeyAccountName = () => `key.${randomUUID()}`

/** Each pasted key is a separate selectable account. Existing work keeps its credential lease
 * until the shared account owner can switch it. No key is written to settings or account metadata. */
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
      if (!name || !isApiKeyAccount(name)) return native.accountEnv(name, base)
      const thread = base.MAKO_THREAD_ID
      const lent = thread && secrets instanceof GrantedSecrets
        ? await secrets.lend("saved-key", prefix + name, { thread, repository: base.PWD || "this-device" }, `Run ${native.label} with its API key`, randomUUID()) : undefined
      if (lent && "refusal" in lent) throw new Error(`Access to the ${native.label} API key was refused.`)
      const record = lent ? lent.record : await secrets.read("saved-key", prefix + name)
      if (!record) throw new Error(`The selected ${native.label} API key is missing. Choose an account in Settings.`)
      return configure(record.value, { ...base }, root.dir(native.provider, name))
    },
    selectedAccount: (name, env) => name && isApiKeyAccount(name) ? { name, dir: root.dir(native.provider, name) } : native.selectedAccount(name, env),
    credentialRevision: async (name, env, hold) => isApiKeyAccount(name)
      ? (await records()).find((r) => r.name === prefix + name)?.version ?? "missing" : native.credentialRevision(name, env, hold),
    accountUsage: (name) => isApiKeyAccount(name) ? keyUsage() : native.accountUsage(name),
    async removeAccount(name) {
      if (!isApiKeyAccount(name)) return native.removeAccount(name)
      await secrets.delete("saved-key", prefix + name)
      return {}
    },
  }
}
