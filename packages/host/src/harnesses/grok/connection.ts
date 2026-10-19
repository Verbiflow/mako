import { homedir } from "node:os"
import { z } from "zod"
import type { InitializeResponse } from "@agentclientprotocol/sdk"
import { acpReadable, acpWritable } from "../acp-stream.js"
import { resolveExecutable } from "../../base/executable.js"
import type { ProviderConnectionState } from "../../contracts/provider-connection.js"
import type { ProviderConnectionCapability } from "../connection-capability.js"
import type { DiscoveryProcesses } from "../discovery-process.js"
import type { ProviderProfileLoader } from "../profile-loader.js"
import { heavy } from "../../base/heavy-packages.js"

/** Grok refreshes its own credentials before advertising cached_token at initialize.
 * Never call authenticate during a status check: upstream can fall through to a browser.
 * Source: xai-grok-shell/src/agent/{auth_method,mvp_agent/acp_agent}.rs.
 */
export function grokConnectionState(
  initialized: InitializeResponse
): ProviderConnectionState {
  const methods = initialized.authMethods ?? []
  const preferred = z
    .object({ defaultAuthMethodId: z.string().optional() })
    .parse(initialized._meta ?? {}).defaultAuthMethodId
  const method =
    preferred !== undefined
      ? methods.find((entry) => entry.id === preferred)
      : (methods.find((entry) => entry.id === "cached_token") ??
        methods.find((entry) => entry.id === "xai.api_key"))
  if (method?.id === "cached_token")
    return { status: "signed-in", source: "cli" }
  if (method?.id === "xai.api_key")
    return { status: "signed-in", source: "env" }
  return { status: "signed-out" }
}

export async function readGrokConnection(
  processes: DiscoveryProcesses,
  env: NodeJS.ProcessEnv
): Promise<ProviderConnectionState> {
  if (!resolveExecutable("grok", env))
    return {
      status: "unavailable",
      message: "Install Grok to connect it to Mako.",
    }
  const { ClientSideConnection, ndJsonStream, PROTOCOL_VERSION } = await heavy.acpSdk.load("grok connection")
  return processes.run(
    {
      command: "grok",
      args: ["agent", "--no-leader", "stdio"],
      env: { ...env, GROK_DISABLE_AUTOUPDATER: "1" },
      cwd: homedir(),
      timeoutMs: 20_000,
      deadline: "started",
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
      return grokConnectionState(
        await connection.initialize({
          protocolVersion: PROTOCOL_VERSION,
          clientInfo: { name: "mako", version: "0.0.1" },
          clientCapabilities: {},
        })
      )
    }
  )
}

async function runLoginCommand(
  processes: DiscoveryProcesses,
  args: string[],
  env: NodeJS.ProcessEnv
): Promise<void> {
  await processes.run(
    {
      command: "grok",
      args,
      env: { ...env, GROK_DISABLE_AUTOUPDATER: "1" },
      cwd: homedir(),
      timeoutMs: 120_000,
      // The person is waiting in their browser: never behind background discovery.
      priority: "launch",
      deadline: "started",
    },
    async ({ child, exited }) => {
      // The provider opens its browser and owns credential persistence. Do not relay auth output.
      child.stdout.resume()
      child.stdin.end()
      const result = await exited
      if (result.code !== 0)
        throw new Error(
          "Grok did not finish signing in. Try again to reopen the browser."
        )
    }
  )
}

/** Grok's sign-in, as its CLI reports it, checked at most once a minute. */
export function createGrokConnection(
  processes: DiscoveryProcesses,
  profile: ProviderProfileLoader,
  options: {
    env?: () => NodeJS.ProcessEnv
    read?: (env: NodeJS.ProcessEnv) => Promise<ProviderConnectionState>
    run?: (args: string[], env: NodeJS.ProcessEnv) => Promise<void>
    verifyModels?: (env: NodeJS.ProcessEnv) => Promise<void>
  } = {}
): ProviderConnectionCapability {
  const read = options.read ?? ((env: NodeJS.ProcessEnv) => readGrokConnection(processes, env))
  const run = options.run ?? ((args: string[], env: NodeJS.ProcessEnv) => runLoginCommand(processes, args, env))
  const verifyModels = options.verifyModels ?? (async (env: NodeJS.ProcessEnv) => { await profile.load(env, homedir()) })
  const listeners = new Set<() => void>()
  let cached: (ProviderConnectionState & { checkedAt: string }) | undefined
  let pending:
    Promise<ProviderConnectionState & { checkedAt: string }> | undefined
  let acting = false
  const env = options.env ?? (() => process.env)
  const status = async (refresh = false) => {
    if (
      !refresh &&
      cached &&
      Date.now() - Date.parse(cached.checkedAt) < 60_000
    )
      return cached
    pending ??= read(env())
      .catch((): ProviderConnectionState => ({
        status: "unavailable",
        message: "Couldn’t check Grok’s connection. Refresh to try again.",
      }))
      .then((state) => {
        cached = { ...state, checkedAt: new Date().toISOString() }
        return cached
      })
      .finally(() => {
        pending = undefined
      })
    return pending
  }
  return {
    provider: "grok",
    label: "Grok",
    description:
      "Sign in with Grok in your browser. Mako uses the same login as your Grok CLI.",
    actions: ["sign-in-browser", "sign-out"],
    secureStorage: async () => false,
    status,
    async act(action) {
      if (action.kind === "sign-in-key")
        throw new Error("Grok manages API keys through its CLI configuration.")
      if (acting) throw new Error("Grok sign-in is already in progress.")
      acting = true
      try {
        await pending
        await run(
          action.kind === "sign-out" ? ["logout"] : ["login", "--oauth"],
          env()
        )
        cached = undefined
        const state = await status(true)
        if (action.kind === "sign-in-browser") {
          if (state.status !== "signed-in")
            throw new Error(
              "Grok sign-in could not be verified. Refresh or try signing in again."
            )
          await verifyModels(env())
        }
        for (const listener of listeners) listener()
        return state
      } finally {
        acting = false
      }
    },
    onChange(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}
