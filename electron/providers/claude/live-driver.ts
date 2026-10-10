import { claudeRuntime } from "./runtime.js"
import { createClaudeSdkDriver } from "./sdk-driver.js"
import { join } from "node:path"
import { prepareClaudePermissionObserver } from "./permission-observer.js"
import { hostEnvironment } from "../../host-environment.js"
import { heavy } from "../../heavy-packages.js"

export const claudeLiveDriver = createClaudeSdkDriver({
  available: () => claudeRuntime() !== null,
  configure: async (...args) =>
    (await import("./sdk-options.js")).claudeSdkOptions(...args),
  query: async (input) => (await heavy.claudeAgentSdk.load("claude session")).query(input),
  prepareApprovals: input =>
    prepareClaudePermissionObserver({ ...input, root: join(hostEnvironment().dataRoot, "approval-evidence") }),
})
