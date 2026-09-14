import { CursorSdkClient } from "./client.js"
import type { CursorSdkProbeClient, CursorSdkSpawnOptions } from "./auth.js"
import type { SdkModelListItem } from "./wire.js"

export interface CursorSdkModelsOptions {
  env: NodeJS.ProcessEnv
  cwd?: string
  /** Test hook: a client other than the real child. */
  client?(options: CursorSdkSpawnOptions): CursorSdkProbeClient
}

/**
 * The models Cursor's SDK offers this account, asked of a short-lived child.
 * Discovery has no session to piggyback on, so this is its own spawn; the
 * driver's own start keeps a ten-minute copy so a thread does not pay it
 * again.
 */
export async function listCursorSdkModels(options: CursorSdkModelsOptions): Promise<SdkModelListItem[]> {
  const spawn: CursorSdkSpawnOptions = {
    owner: "cursor-sdk-models",
    cwd: options.cwd ?? process.cwd(),
    env: options.env,
    onEvent: () => undefined,
  }
  const client = options.client ? options.client(spawn) : new CursorSdkClient(spawn)
  try {
    await client.hello()
    return (await client.request("models", undefined)).models
  } finally {
    await client.close(2_000)
  }
}
