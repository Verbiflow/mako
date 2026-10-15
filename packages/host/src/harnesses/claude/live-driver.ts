import { claudeRuntime } from "./runtime.js"
import { createClaudeSdkDriver } from "./sdk-driver.js"
import { prepareClaudePermissionObserver } from "./permission-observer.js"
import { approvalRoot, type HarnessContext } from "../host.js"
import { heavy } from "../../base/heavy-packages.js"
import { homedir } from "node:os"
import { KeptOutputs, keptOutputsPath } from "@mako/sessions"

export function createClaudeLiveDriver(context: Pick<HarnessContext, "dataRoot" | "stores" | "streams">) {
  return createClaudeSdkDriver({
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
}
