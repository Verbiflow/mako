import { homedir } from "node:os"
import { basename, join } from "node:path"
import { withApiKeyAccounts } from "../api-key-accounts.js"
import { credentialFingerprint, KeyTokens, type AccountRoot } from "../accounts-common.js"
import type { Secrets } from "../../base/secrets.js"

/** OAuth remains in the official agent. Key sessions use their own ACP data directory. */
export function antigravityAccounts(root: AccountRoot, secrets: Secrets) {
  // The default account's key, if any, is the person's environment's: Mako keeps no version of it.
  const keyTokens = new KeyTokens()
  return withApiKeyAccounts({
    provider: "antigravity", label: "Antigravity", mode: "selectable",
    loginCommand: "agy acp --login",
    async listAccounts(selection) {
      return [{ harness: "antigravity", name: "default", active: !selection, source: "cli", route: "native", dir: join(homedir(), ".gemini") }]
    },
    async accountEnv(name, env) {
      if (name && name !== "default") throw new Error("This Antigravity account is no longer available.")
      return { ...env }
    },
    selectedAccount: () => ({ name: "default" }),
    credentialRevision: async (_name, env = process.env) => credentialFingerprint([env.GEMINI_HOME ?? null, keyTokens.of(env.GEMINI_API_KEY)]),
    accountUsage: async () => ({ status: "unavailable", detail: "Antigravity manages this account's limits." }),
    async removeAccount() { throw new Error("The terminal owns this sign-in.") },
  }, root, secrets, async (key, env, dir) => {
    // A saved Gemini Developer API credential is scoped to Google.
    for (const name of Object.keys(env)) {
      const variable = name.toUpperCase()
      if (variable.startsWith("AGY_LLM_GATEWAY_") || ["GOOGLE_GEMINI_BASE_URL", "GOOGLE_VERTEX_BASE_URL", "GOOGLE_GENAI_USE_VERTEXAI",
        "GOOGLE_APPLICATION_CREDENTIALS", "GOOGLE_API_KEY", "GEMINI_API_KEY", "ANTIGRAVITY_HARNESS_PATH"].includes(variable)) delete env[name]
    }
    return { ...env, GEMINI_API_KEY: key, MAKO_AGY_DATA_DIRECTORY: "mako-antigravity-" + basename(dir) }
  })
}
