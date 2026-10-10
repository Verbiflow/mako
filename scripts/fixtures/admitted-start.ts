import type { AccountLaunch } from "../../electron/accounts.ts"
import type { AdmittedStartOptions, ProviderStartOptions } from "../../electron/providers/live-driver.ts"
import { ProviderLaunchTrace } from "../../electron/provider-launch.ts"

/** A driver's start options as admission hands them over, launched on `env` with no account selected. */
export function admitted(
  provider: string,
  options: ProviderStartOptions,
  launch: { env?: NodeJS.ProcessEnv; account?: AccountLaunch["account"]; observeUsage?: AdmittedStartOptions["observeUsage"] } = {},
): AdmittedStartOptions {
  return {
    ...options,
    accountLaunch: { env: { ...(launch.env ?? process.env) }, account: launch.account ?? { name: "default" }, selection: { kind: "unavailable" } },
    observeUsage: launch.observeUsage ?? (() => undefined),
    trace: new ProviderLaunchTrace({ provider, conversation: options.conversationId }),
  }
}
