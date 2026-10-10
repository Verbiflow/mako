import type { AccountLaunch } from "@mako/host/harnesses/accounts"
import type { AdmittedStartOptions, ProviderStartOptions } from "@mako/host/harnesses/live-driver"
import { ProviderLaunchTrace } from "@mako/host/harnesses/provider-launch"

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
