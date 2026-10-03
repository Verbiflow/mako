import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { z } from "zod"
import { claudeAccountCapability } from "../electron/providers/claude/accounts.ts"
import { claudeRuntime } from "../electron/providers/claude/runtime.ts"
import { childProcessEnv, withAccountMutation, readSelection } from "../electron/accounts-common.ts"

const directory = z.string().min(1).parse(process.env.MAKO_THREAD_DATA_DIR)
const execute = promisify(execFile)
const runtime = claudeRuntime()
if (!runtime) throw new Error("Claude runtime is unavailable")
const Status = z.object({ loggedIn: z.boolean(), authMethod: z.string(), email: z.string().optional(), configDirectory: z.string().optional() })
const results: { source: string; selected: boolean; loggedIn?: boolean; method?: string; identityMatches?: boolean; configuredMetadataMatchesNative?: boolean; configuredHomeMatches?: boolean; credentialsChanged?: boolean; error?: string }[] = []
const selection = await readSelection("claude")
const accounts = await claudeAccountCapability.listAccounts(selection)
const version = (await execute(runtime.executable, ["--version"], { timeout: 10_000, maxBuffer: 64 * 1024 })).stdout.trim()
for (const account of accounts.slice(0, 12)) {
  const result = await withAccountMutation("claude", async () => {
    try {
      const before = await claudeAccountCapability.credentialRevision(account.name)
      const env = await claudeAccountCapability.accountEnv(account.name === "default" ? null : account.name, childProcessEnv(process.env))
      const output = await execute(runtime.executable, ["auth", "status", "--json"], { env, timeout: 15_000, maxBuffer: 64 * 1024 })
      const native = Status.parse(JSON.parse(output.stdout))
      const config = await readFile(join(env.CLAUDE_CONFIG_DIR ?? account.dir, ".claude.json"), "utf8")
        .then((text) => z.object({ oauthAccount: z.object({ emailAddress: z.string().optional() }).optional() }).parse(JSON.parse(text)))
        .catch(() => undefined)
      const after = await claudeAccountCapability.credentialRevision(account.name)
      return {
        source: account.source ?? (account.name === "default" ? "cli" : "mako"),
        selected: account.active, loggedIn: native.loggedIn, method: native.authMethod,
        identityMatches: native.email && account.email ? native.email.toLowerCase() === account.email.toLowerCase() : undefined,
        configuredMetadataMatchesNative: native.email && config?.oauthAccount?.emailAddress ? native.email.toLowerCase() === config.oauthAccount.emailAddress.toLowerCase() : undefined,
        configuredHomeMatches: native.configDirectory ? native.configDirectory === (env.CLAUDE_CONFIG_DIR ?? account.dir) : undefined,
        credentialsChanged: before !== after,
      }
    } catch (error) {
      // Never persist CLI stdout/stderr, account names, emails or raw error messages.
      const missing = error instanceof Error && error.message.includes("has no valid credentials")
      return { source: account.source ?? "mako", selected: account.active, error: missing ? "missing-credentials" : error instanceof Error ? error.name : "unknown" }
    }
  })
  results.push(result)
}
const receipt = {
  checkedAt: new Date().toISOString(), runtime: runtime.kind, version,
  scope: "Native auth status with each adapter-resolved environment; no global selection changes or model prompts. Metadata proof only, not authenticated requests or in-flight switching.",
  totalAccounts: accounts.length, testedAccounts: results.length, results,
}
await writeFile(join(directory, "native-claude-identity.json"), JSON.stringify(receipt, null, 2) + "\n", { mode: 0o600 })
console.log(JSON.stringify(receipt))
