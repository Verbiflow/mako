import { normalizeCursorSdkModels } from "@mako/sessions"
import type { SdkModelListItem } from "./sdk/wire.js"
import {
  availableProviderProfile,
  type ProviderProfileLoader,
  type ProfileLoadContext,
} from "../profile-loader.js"

export interface CursorProfileOptions {
  /** The SDK's model list for the account the host is signed in as. */
  sdkModels(env: NodeJS.ProcessEnv, cwd?: string, context?: ProfileLoadContext): Promise<SdkModelListItem[]>
  /** Names the account, so a sign-in change invalidates the catalog. */
  accountKey(): string
}

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
    defaults: {
      work: [{ model: "claude-opus-5-5", options: { effort: "high", fast: "false" } }],
    },
    transport: "sdk",
    cacheKey: () => options.accountKey(),
    async load(env, cwd, context) {
      const catalog = normalizeCursorSdkModels(await options.sdkModels(env, cwd, context))
      return availableProviderProfile(loader, catalog)
    },
  }
  return loader
}

/** The loader as fixtures see it: the SDK's list is whatever the test supplies. */
export function cursorProfileLoaderWith(models: SdkModelListItem[]): ProviderProfileLoader {
  return createCursorProfileLoader({ sdkModels: async () => models, accountKey: () => "fixture" })
}
