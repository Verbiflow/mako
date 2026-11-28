import { homedir } from "node:os"
import { basename, join } from "node:path"
import { cloudKeyPayload, withApiKeyAccounts } from "../api-key-accounts.js"
import { credentialFingerprint, KeyTokens, type AccountRoot } from "../accounts-common.js"
import type { Secrets } from "../../base/secrets.js"
import type { CloudSignInCapability } from "../cloud-sign-in.js"
import { localWords } from "@mako/protocol/computer-words"

/**
 * Antigravity in the cloud runs on a Gemini API key: a key account's, through the path every key-taking harness shares
 * (`withApiKeyAccounts`), or the `GEMINI_API_KEY` this Mac's own sign-in runs under. agy keeps a Google sign-in in the
 * system keychain, which Mako doesn't read, so that one stays on this Mac.
 */
export const antigravityCloudSignIn: CloudSignInCapability = {
  async export(env) {
    const key = env.GEMINI_API_KEY?.trim()
    return key ? { label: null, expiresAt: null, payload: cloudKeyPayload(key) } : null
  },
  async install() {
    throw new Error("Antigravity's sign-in on a machine is a Gemini API key")
  },
  remove: async () => false,
  unshared: localWords("Cloud Threads run Antigravity on a Gemini API key; a Google sign-in stays on this Mac."),
}

/** OAuth remains in the official agent. Key sessions use their own ACP data directory. */
export function antigravityAccounts(root: AccountRoot, secrets: Secrets) {
  // The default account's key, if any, is the person's environment's: Mako keeps no version of it.
  const keyTokens = new KeyTokens()
  return withApiKeyAccounts({
    provider: "antigravity", label: "Antigravity", mode: "selectable",
    loginCommand: "agy acp --login",
    async listAccounts(selection) {
      return [{ harness: "antigravity", name: "default", active: !selection, source: "cli", route: "native", dir: process.env.GEMINI_HOME || join(homedir(), ".gemini") }]
    },
    async accountEnv(name, env) {
      if (name && name !== "default") throw new Error("This Antigravity account is no longer available.")
      return { ...env }
    },
    selectedAccount: () => ({ name: "default" }),
    credentialRevision: async (_name, env = process.env) => credentialFingerprint([env.GEMINI_HOME ?? null, keyTokens.of(env.GEMINI_API_KEY)]),
    accountUsage: async () => ({ status: "unavailable", detail: "Antigravity manages this account's limits." }),
    async removeAccount() { throw new Error("The terminal owns this sign-in.") },
    cloudSignIn: antigravityCloudSignIn,
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
