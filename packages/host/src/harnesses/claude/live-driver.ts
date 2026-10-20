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
      kind: "process",
      via: "The Claude Code build a session runs, in the SDK's stream-JSON mode, through `initialize`.",
      async launch(env) {
        const runtime = claudeRuntime(env)
        return runtime ? { command: claudeExecutablePath(runtime.executable), args: CLAUDE_SDK_ARGS, env, first: CLAUDE_INITIALIZE } : undefined
      },
    },
  }
}
