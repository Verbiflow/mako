import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { homedir } from "node:os"
import { z } from "zod"
import { claudeAccountCapability } from "../electron/providers/claude/accounts.ts"
import { claudeRuntime, terminalClaudeExecutable } from "../electron/providers/claude/runtime.ts"
import { childProcessEnv, withAccountMutation, readSelection } from "../electron/accounts-common.ts"

const directory = z.string().min(1).parse(process.env.MAKO_THREAD_DATA_DIR)
const execute = promisify(execFile)
const runtime = claudeRuntime()
if (!runtime) throw new Error("Claude runtime is unavailable")
const Status = z.object({ loggedIn: z.boolean(), authMethod: z.string(), email: z.string().optional(), configDirectory: z.string().optional() })
const SignedOutExit = z.object({ code: z.literal(1), stdout: z.string() })
const NumericExit = z.object({ code: z.number().int() })
const results: { source: string; selected: boolean; loggedIn?: boolean; method?: string; identityMatches?: boolean; configuredMetadataMatchesNative?: boolean; configuredHomeMatches?: boolean; credentialsChanged?: boolean; error?: string; phase?: string; code?: number }[] = []
const selection = await readSelection("claude")
const accounts = await claudeAccountCapability.listAccounts(selection)
const version = (await execute(runtime.executable, ["--version"], { timeout: 10_000, maxBuffer: 64 * 1024 })).stdout.trim()
for (const account of accounts.slice(0, 12)) {
  const result = await withAccountMutation("claude", async () => {
    let phase = "credential-before"
    try {
      const before = await claudeAccountCapability.credentialRevision(account.name)
      phase = "environment"
      const env = await claudeAccountCapability.accountEnv(account.name === "default" ? null : account.name, childProcessEnv(process.env))
      phase = "native-status"
      const output = await execute(runtime.executable, ["auth", "status", "--json"], { env, timeout: 15_000, maxBuffer: 64 * 1024 })
        .then(value => ({ stdout: value.stdout, code: 0 }))
        .catch(error => {
          // Native status exits 1 when signed out. Only its validated negative
          // status is evidence; other nonzero output remains a failed query.
          const signedOut = SignedOutExit.safeParse(error)
          if (signedOut.success) return signedOut.data
          throw error
        })
      const native = Status.parse(JSON.parse(output.stdout))
      if (output.code !== 0 && native.loggedIn) throw new Error("Inconsistent native status")
      phase = "metadata"
      const config = await readFile(join(env.CLAUDE_CONFIG_DIR ?? account.dir, ".claude.json"), "utf8")
        .then((text) => z.object({ oauthAccount: z.object({ emailAddress: z.string().optional() }).optional() }).parse(JSON.parse(text)))
        .catch(() => undefined)
      phase = "credential-after"
      const after = await claudeAccountCapability.credentialRevision(account.name)
      return {
        source: account.source ?? (account.name === "default" ? "cli" : "mako"),
        selected: account.active, loggedIn: native.loggedIn, method: /^[a-zA-Z0-9_.-]{1,40}$/.test(native.authMethod) ? native.authMethod : "unrecognized",
        identityMatches: native.email && account.email ? native.email.toLowerCase() === account.email.toLowerCase() : undefined,
        configuredMetadataMatchesNative: native.email && config?.oauthAccount?.emailAddress ? native.email.toLowerCase() === config.oauthAccount.emailAddress.toLowerCase() : undefined,
        configuredHomeMatches: native.configDirectory ? native.configDirectory === (env.CLAUDE_CONFIG_DIR ?? account.dir) : undefined,
        credentialsChanged: before !== after,
      }
    } catch (error) {
      // Never persist CLI stdout/stderr, account names, emails or raw error messages.
      const missing = error instanceof Error && error.message.includes("has no valid credentials")
      const exit = NumericExit.safeParse(error)
      const code = exit.success ? exit.data.code : undefined
      return { source: account.source ?? "mako", selected: account.active, error: missing ? "missing-credentials" : error instanceof Error ? error.name : "unknown", phase, code }
    }
  })
  results.push(result)
}
const receipt = {
  checkedAt: new Date().toISOString(), runtime: runtime.kind, version,
  scope: "Native auth status with each adapter-resolved environment; no global selection changes or model prompts. Metadata proof only, not authenticated requests or in-flight switching.",
  totalAccounts: accounts.length, testedAccounts: results.length, results,
}
// Compare the inherited route to the ordinary CLI home without changing the
// user's selection or removing any credentials. Keep only public booleans.
const contexts = []
const inherited = childProcessEnv(process.env)
const ordinary = { ...inherited }
delete ordinary.CLAUDE_CONFIG_DIR
delete ordinary.CLAUDE_SECURESTORAGE_CONFIG_DIR
const terminal = terminalClaudeExecutable(inherited)
for (const candidate of [
  { label: "sdk-inherited", executable: runtime.executable, env: inherited },
  { label: "sdk-ordinary-home", executable: runtime.executable, env: ordinary },
  ...(terminal ? [{ label: "terminal-ordinary-home", executable: terminal, env: ordinary }] : []),
]) {
  try {
    const output = await execute(candidate.executable, ["auth", "status", "--json"], { env: candidate.env, timeout: 15_000, maxBuffer: 64 * 1024 })
      .then(value => ({ stdout: value.stdout, code: 0 }))
      .catch(error => { const status = SignedOutExit.safeParse(error); if (status.success) return status.data; throw error })
    const native = Status.parse(JSON.parse(output.stdout))
    if (output.code !== 0 && native.loggedIn) throw new Error("Inconsistent native status")
    contexts.push({ label: candidate.label, loggedIn: native.loggedIn, configuredHomeIsOrdinary: (candidate.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude")) === join(homedir(), ".claude"), secureStorageOverride: Boolean(candidate.env.CLAUDE_SECURESTORAGE_CONFIG_DIR), reportsPrincipal: Boolean(native.email), method: /^[a-zA-Z0-9_.-]{1,40}$/.test(native.authMethod) ? native.authMethod : "unrecognized" })
  } catch (error) { contexts.push({ label: candidate.label, error: error instanceof Error ? error.name : "unknown" }) }
}
await writeFile(join(directory, "native-claude-identity.json"), JSON.stringify({ ...receipt, contexts }, null, 2) + "\n", { mode: 0o600 })
console.log(JSON.stringify({ ...receipt, contexts }))
