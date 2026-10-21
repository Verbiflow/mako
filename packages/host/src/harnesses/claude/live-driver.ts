import { realpath } from "node:fs/promises"
import { z } from "zod"
import { prefetchProcess } from "../start-prefetch.js"
import { claudeRuntime } from "./runtime.js"
import { createClaudeSdkDriver } from "./sdk-driver.js"
import { claudeExecutablePath } from "./sdk-process.js"
import type { ProviderLiveDriver } from "../live-driver.js"
import { prepareClaudePermissionObserver } from "./permission-observer.js"
import { ClaudeSettingsReader } from "./approval-settings.js"
import { approvalRoot, type HarnessContext } from "../host.js"
import { heavy } from "../../base/heavy-packages.js"
import { homedir } from "node:os"
import { KeptOutputs, keptOutputsPath } from "@mako/sessions"

/** The SDK's stream-JSON mode, which its sessions run in, and its first control request. */
const CLAUDE_SDK_ARGS = ["--output-format", "stream-json", "--verbose", "--input-format", "stream-json"]
const CLAUDE_INITIALIZE = JSON.stringify({ type: "control_request", request_id: "prefetch", request: { subtype: "initialize" } })
const ControlResponse = z.object({ type: z.literal("control_response") }).loose()

export function createClaudeLiveDriver(context: Pick<HarnessContext, "dataRoot" | "stores" | "streams">): ProviderLiveDriver {
  const settings = new ClaudeSettingsReader()
  const driver = createClaudeSdkDriver({
    available: () => claudeRuntime() !== null,
    configure: async (...args) =>
      (await import("./sdk-options.js")).claudeSdkOptions(...args),
    query: async (input) => (await heavy.claudeAgentSdk.load("claude session")).query(input),
    prepareApprovals: input =>
      prepareClaudePermissionObserver({ ...input, root: approvalRoot(context), settings }),
    streams: context.streams,
    // Per user beside the session archive, as the history reader keeps them.
    outputs: new KeptOutputs(keptOutputsPath(homedir()), context.stores),
  })
  return {
    ...driver,
    startPrefetch: {
      via: "The Claude Code build a session runs, in the SDK's stream-JSON mode, through `initialize`, with its binary read alongside: its first `initialize` on a copy took 3.5 s alone, 0.9 s so (2026-10-20); and the settings reader each start checks before it spawns, its SDK loaded.",
      files: async (env) => {
        const runtime = claudeRuntime(env)
        return runtime ? [await realpath(claudeExecutablePath(runtime.executable)).catch(() => runtime.executable)] : []
      },
      run: async (env, cwd, owner, stop) => {
        const runtime = claudeRuntime(env)
        const exchange = [{ send: CLAUDE_INITIALIZE, answer: ControlResponse }]
        // Beside it, the settings reader every start checks before it spawns loads the SDK, kept for the start.
        // And what the start loads into the host before it spawns: the Agent SDK and its options (0.1 s before the
        // spawn, the event loop held 0.28 s, on a copy).
        const [answered] = await Promise.all([
          prefetchProcess(runtime ? { command: claudeExecutablePath(runtime.executable), args: CLAUDE_SDK_ARGS, env, exchange } : undefined, cwd, owner, stop),
          settings.warm(),
          heavy.claudeAgentSdk.load("read a start ahead").catch(() => undefined),
          import("./sdk-options.js").catch(() => undefined),
        ])
        return answered
      },
    },
  }
}
