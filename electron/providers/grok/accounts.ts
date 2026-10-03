import { readFile } from "node:fs/promises"
import { z } from "zod"
import { homedir } from "node:os"
import { join } from "node:path"
import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
} from "@agentclientprotocol/sdk"
import type {
  AccountUsage,
  HarnessAccount,
  UsageWindow,
} from "../../account-types.js"
import {
  credentialFileFingerprint,
  childProcessEnv,
  jsonFields,
  parseUsageReset,
  stringValue,
  valueFields,
} from "../../accounts-common.js"
import { acpReadable, acpWritable } from "../../acp-stream.js"
import type { JsonValue } from "../../codex-app-json.js"
import { resolveExecutable } from "../../executable.js"
import type { ObservedAccountCapability } from "../account-capability.js"
import { withDiscoveryProcess } from "../discovery-process.js"

function authPath(env: NodeJS.ProcessEnv): string {
  return (
    env.GROK_AUTH_PATH ??
    join(env.GROK_HOME ?? join(homedir(), ".grok"), "auth.json")
  )
}

/**
 * Grok keys its auth file by issuer and client; each entry carries the
 * signed-in email beside the token. Only the public identity is read.
 */
export function parseGrokAccounts(
  contents: string,
  path: string
): HarnessAccount[] {
  for (const [, value] of jsonFields(contents)) {
    const email = stringValue(valueFields(value)?.get("email"))
    if (email === undefined) continue
    return [
      {
        harness: "grok",
        name: "default",
        email,
        dir: path,
        active: true,
        source: "cli",
      },
    ]
  }
  return []
}

const BillingSchema = z.object({
  subscription_tier: z.string().optional(),
  config: z
    .object({
      creditUsagePercent: z.number().optional(),
      currentPeriod: z
        .object({ start: z.string().optional(), end: z.string().optional() })
        .optional(),
      billingPeriodStart: z.string().optional(),
      billingPeriodEnd: z.string().optional(),
    })
    .optional(),
})

/**
 * `_x.ai/billing`: one credit percentage over the current usage period,
 * weekly on today's subscriptions. The on-demand and prepaid amounts carry
 * no unit, so they stay unread until one is confirmed.
 */
export function parseGrokBilling(
  value: JsonValue
): Extract<AccountUsage, { status: "ok" }> {
  const billing = BillingSchema.parse(value)
  const config = billing.config
  const used = config?.creditUsagePercent
  const start = parseUsageReset(
    config?.currentPeriod?.start ?? config?.billingPeriodStart
  )
  const end = parseUsageReset(
    config?.currentPeriod?.end ?? config?.billingPeriodEnd
  )
  const windows: UsageWindow[] =
    used === undefined
      ? []
      : [
          {
            usedPercent: used,
            windowMinutes:
              start !== null && end !== null && end > start
                ? Math.round((end - start) / 60_000)
                : 0,
            resetsAt: end,
          },
        ]
  const usage: Extract<AccountUsage, { status: "ok" }> = {
    status: "ok",
    windows,
  }
  if (billing.subscription_tier !== undefined)
    usage.plan = billing.subscription_tier
  return usage
}

/**
 * Grok answers billing over its ACP agent without a session, so no session
 * is created and no MCP server starts: initialize, ask, exit.
 */
async function readGrokBilling(env: NodeJS.ProcessEnv): Promise<JsonValue> {
  return withDiscoveryProcess(
    {
      command: "grok",
      args: ["agent", "--no-leader", "stdio"],
      env: { ...env, GROK_DISABLE_AUTOUPDATER: "1" },
      cwd: homedir(),
      timeoutMs: 20_000,
      priority: "background",
    },
    async ({ child }) => {
      const connection = new ClientSideConnection(
        () => ({
          requestPermission: async () => ({
            outcome: { outcome: "cancelled" },
          }),
          sessionUpdate: async () => {},
        }),
        ndJsonStream(acpWritable(child.stdin), acpReadable(child.stdout))
      )
      await connection.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientInfo: { name: "mako", version: "0.0.1" },
        clientCapabilities: {},
      })
      // Grok's extension methods keep ACP's underscore prefix on the wire.
      return z.json().parse(await connection.extMethod("_x.ai/billing", {}))
    }
  )
}

export const grokAccountCapability: ObservedAccountCapability = {
  provider: "grok",
  mode: "observed",
  label: "Grok",
  loginCommand: "grok login",
  async listAccounts() {
    const path = authPath(process.env)
    return readFile(path, "utf8")
      .then((contents) => parseGrokAccounts(contents, path))
      .catch(() => [])
  },
  accountEnv: async (_selection, base) => ({ ...base }),
  selectedAccount: () => ({ name: "default" }),
  credentialRevision: () => credentialFileFingerprint(authPath(process.env)),
  async accountUsage() {
    const env = childProcessEnv(process.env)
    if (!resolveExecutable("grok", env))
      return { status: "unavailable", detail: "Install Grok to see its usage" }
    const accounts = await grokAccountCapability.listAccounts(null)
    if (accounts.length === 0) return { status: "missing-credentials" }
    try {
      return parseGrokBilling(await readGrokBilling(env))
    } catch (error) {
      return {
        status: "error",
        detail: error instanceof Error ? error.message : String(error),
      }
    }
  },
}
