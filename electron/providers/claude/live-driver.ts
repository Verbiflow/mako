import { claudeRuntime } from "./runtime.js"
import { createClaudeSdkDriver } from "./sdk-driver.js"
import { join } from "node:path"
import { prepareClaudePermissionObserver } from "./permission-observer.js"
import { hostEnvironment } from "@mako/host/base/host-environment"
import { heavy } from "@mako/host/base/heavy-packages"

export function createClaudeLiveDriver() {
  return createClaudeSdkDriver({
    available: () => claudeRuntime() !== null,
    configure: async (...args) =>
      (await import("./sdk-options.js")).claudeSdkOptions(...args),
    query: async (input) => (await heavy.claudeAgentSdk.load("claude session")).query(input),
    prepareApprovals: input =>
      prepareClaudePermissionObserver({ ...input, root: join(hostEnvironment().dataRoot, "approval-evidence") }),
  })
}
