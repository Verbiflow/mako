import { randomUUID } from "node:crypto"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir, homedir } from "node:os"
import { join } from "node:path"
import { query } from "@anthropic-ai/claude-agent-sdk"
import { z } from "zod"
import { assertAccountLaunch, resolveAccountLaunch } from "../electron/accounts.ts"
import { claudeAccountCapability } from "../electron/providers/claude/accounts.ts"
import { claudeSdkOptions } from "../electron/providers/claude/sdk-options.ts"
import { spawnClaudeProcess } from "../electron/providers/claude/sdk-process.ts"
import { ClaudeInput } from "../electron/providers/claude/input.ts"
import { traceProviderLaunch } from "../electron/provider-launch.ts"

// Opt-in native initialization, not a test gate. --authenticated submits one
// bounded nonce question; the default submits nothing. Only our child closes.
const authenticated = process.argv.includes("--authenticated")
interface IdentityReceipt {
  checkedAt: string
  scope: string
  configuredHomeIsOrdinary?: boolean
  reportsPrincipal?: boolean
  identityMatchesSelectedMetadata?: boolean
  backend?: string
  errorClass?: string
  authenticatedRequest?: { kind: "pending" } | { kind: "passed" | "failed"; estimatedCostUsd: number; resultSubtype: string; resultError: boolean; assistantEchoedNonce: boolean }
}
const destination = z.string().min(1).parse(process.env.MAKO_THREAD_DATA_DIR)
const cwd = await mkdtemp(join(tmpdir(), "mako-claude-identity-"))
const id = randomUUID()
const input = new ClaudeInput()
let childClosed: Promise<void> | undefined
let closed = false
const abortController = new AbortController()
const timer = setTimeout(() => abortController.abort(), authenticated ? 60_000 : 20_000)
let receipt: IdentityReceipt | undefined
try {
  const launch = await resolveAccountLaunch("claude", process.env)
  const accounts = await claudeAccountCapability.listAccounts(launch.selection.kind === "selectable" ? launch.selection.name : null)
  const selected = accounts.find(account => account.active)
  const configuration = await traceProviderLaunch("claude", id, trace => claudeSdkOptions(cwd, {
    conversationId: id, accountLaunch: launch,
    mcpSnapshot: async () => ({ cwd, generatedAt: Date.now(), servers: [], providers: [] }),
  }, trace))
  await assertAccountLaunch("claude", launch)
  const native = query({ prompt: input, options: {
    ...configuration.options,
    abortController,
    // Avoid hooks, local sessions, skills, tools and MCP startup in the probe.
    settingSources: [], settings: { disableAllHooks: true }, tools: [],
    strictMcpConfig: true, persistSession: false,
    maxTurns: 2, maxBudgetUsd: authenticated ? 0.1 : undefined,
    spawnClaudeCodeProcess: options => {
      const { child } = spawnClaudeProcess(options)
      childClosed = new Promise<void>(resolve => child.once("close", () => { closed = true; resolve() }))
      return child
    },
  } })
  try {
    const result = await native.initializationResult()
    await assertAccountLaunch("claude", launch)
    receipt = {
      checkedAt: new Date().toISOString(),
      scope: "Actual SDK initialization with production account/options preparation; no prompt, model request, session persistence, hooks or tools. Native-reported identity only, not authenticated API or OAuth refresh proof.",
      configuredHomeIsOrdinary: (launch.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude")) === join(homedir(), ".claude"),
      reportsPrincipal: Boolean(result.account.email),
      identityMatchesSelectedMetadata: result.account.email && selected?.email
        ? result.account.email.toLowerCase() === selected.email.toLowerCase() : undefined,
      backend: result.account.apiProvider && /^[a-zA-Z0-9_.-]{1,40}$/.test(result.account.apiProvider) ? result.account.apiProvider : undefined,
      authenticatedRequest: authenticated ? { kind: "pending" as const } : undefined,
    }
    if (authenticated) {
      const models = await native.supportedModels()
      const small = models.find(model => model.value.toLowerCase().includes("haiku"))
      if (small) await native.setModel(small.value)
      await assertAccountLaunch("claude", launch)
      const nonce = `MAKO_AUTH_${randomUUID()}`
      input.send({ type: "user", session_id: id, parent_tool_use_id: null,
        message: { role: "user", content: `Reply with exactly ${nonce}. No tools or extra text.` } })
      let assistantEchoedNonce = false
      for await (const message of native) {
        if (message.type === "assistant" && !message.parent_tool_use_id)
          assistantEchoedNonce ||= message.message.content.some(block => block.type === "text" && block.text.includes(nonce))
        if (message.type !== "result") continue
        const echoed = message.subtype === "success" && !message.is_error && message.result.includes(nonce)
        receipt = { ...receipt, scope: "Actual SDK initialization plus one nonce response in a disposable workspace through the routed account; tools/hooks/MCP and session persistence disabled. Does not prove credential rotation, OAuth refresh or installed acceptance.",
          authenticatedRequest: { kind: echoed ? "passed" : "failed", estimatedCostUsd: message.total_cost_usd,
            resultSubtype: message.subtype, resultError: message.is_error, assistantEchoedNonce } }
        break
      }
    }
  } finally { input.close(); native.close(); await childClosed }
} catch (error) {
  receipt = { ...receipt, checkedAt: new Date().toISOString(), errorClass: error instanceof Error ? error.name : "unknown", scope: "Native initialization or requested nonce check failed; raw diagnostics omitted. Do not replay an unknown request." }
} finally {
  clearTimeout(timer)
  abortController.abort()
  input.close()
  await rm(cwd, { recursive: true, force: true })
}
const result = { ...receipt, ownedChildClosed: closed }
await writeFile(join(destination, authenticated ? "native-claude-authenticated.json" : "native-claude-initialization.json"), JSON.stringify(result, null, 2) + "\n", { mode: 0o600 })
console.log(JSON.stringify(result))
if (!closed || !receipt || "errorClass" in receipt || (authenticated && receipt.authenticatedRequest?.kind !== "passed")) process.exitCode = 1
