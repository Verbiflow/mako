import { normalizeCursorSdkModels } from "@mako/sessions"
import type { SdkModelListItem } from "./sdk/wire.js"
import {
  availableProviderProfile,
  type ProviderProfileLoader,
} from "../profile-loader.js"

export interface CursorProfileOptions {
  /** The SDK's model list for the account the host is signed in as. */
  sdkModels(env: NodeJS.ProcessEnv, cwd?: string): Promise<SdkModelListItem[]>
  /** Names the account, so a sign-in change invalidates the catalog. */
  accountKey(): string
}

const CAPABILITIES = [
  "start",
  "resume-acp",
  "stream",
  "interrupt",
  "steer",
  "permissions",
  "images",
  "mcp",
  "models",
]

/**
 * Cursor's model catalog: what the SDK offers this account, under the SDK's
 * own ids, with reasoning and speed as parameters. The cache key names the
 * account, so signing in as someone else discards the previous list instead
 * of serving it for a thread that will run under the new key.
 */
export function createCursorProfileLoader(options: CursorProfileOptions): ProviderProfileLoader {
  const loader: ProviderProfileLoader = {
    provider: "cursor",
    label: "Cursor",
    transport: "sdk",
    capabilities: CAPABILITIES,
    cacheKey: () => options.accountKey(),
    async load(env, cwd) {
      const catalog = normalizeCursorSdkModels(await options.sdkModels(env, cwd))
      return availableProviderProfile(loader, catalog)
    },
  }
  return loader
}

/** The loader as fixtures see it: the SDK's list is whatever the test supplies. */
export function cursorProfileLoaderWith(models: SdkModelListItem[]): ProviderProfileLoader {
  return createCursorProfileLoader({ sdkModels: async () => models, accountKey: () => "fixture" })
}
