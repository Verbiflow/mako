import { realpath } from "node:fs/promises"
import { z } from "zod"
import { prefetchProcess } from "../start-prefetch.js"
import { claudeRuntime } from "./runtime.js"
import { createClaudeSdkDriver } from "./sdk-driver.js"
import { claudeExecutablePath } from "./sdk-process.js"
import type { ProviderLiveDriver } from "../live-driver.js"
import { prepareClaudePermissionObserver } from "./permission-observer.js"
import { approvalRoot, type HarnessContext } from "../host.js"
import { heavy } from "../../base/heavy-packages.js"
import { homedir } from "node:os"
import { KeptOutputs, keptOutputsPath } from "@mako/sessions"

/** The SDK's stream-JSON mode, which its sessions run in, and its first control request. */
const CLAUDE_SDK_ARGS = ["--output-format", "stream-json", "--verbose", "--input-format", "stream-json"]
const CLAUDE_INITIALIZE = JSON.stringify({ type: "control_request", request_id: "prefetch", request: { subtype: "initialize" } })
const ControlResponse = z.object({ type: z.literal("control_response") }).loose()

export function createClaudeLiveDriver(context: Pick<HarnessContext, "dataRoot" | "stores" | "streams">): ProviderLiveDriver {
  const driver = createClaudeSdkDriver({
    available: () => claudeRuntime() !== null,
    configure: async (...args) =>
      (await import("./sdk-options.js")).claudeSdkOptions(...args),
    query: async (input) => (await heavy.claudeAgentSdk.load("claude session")).query(input),
    prepareApprovals: input =>
      prepareClaudePermissionObserver({ ...input, root: approvalRoot(context) }),
    streams: context.streams,
    // Per user beside the session archive, as the history reader keeps them.
    outputs: new KeptOutputs(keptOutputsPath(homedir()), context.stores),
  })
  return {
    ...driver,
    startPrefetch: {
      via: "The Claude Code build a session runs, in the SDK's stream-JSON mode, through `initialize`, with its binary read alongside: its first `initialize` on a copy took 3.5 s alone, 0.9 s so (2026-10-20).",
      files: async (env) => {
        const runtime = claudeRuntime(env)
        return runtime ? [await realpath(claudeExecutablePath(runtime.executable)).catch(() => runtime.executable)] : []
      },
      run: async (env, cwd, owner) => {
        const runtime = claudeRuntime(env)
        const exchange = [{ send: CLAUDE_INITIALIZE, answer: ControlResponse }]
        return prefetchProcess(runtime ? { command: claudeExecutablePath(runtime.executable), args: CLAUDE_SDK_ARGS, env, exchange } : undefined, cwd, owner)
      },
    },
  }
}
