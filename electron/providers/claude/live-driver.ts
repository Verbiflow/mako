import { query } from "@anthropic-ai/claude-agent-sdk"
import { resolveExecutable } from "../../executable.js"
import { createClaudeSdkDriver } from "./sdk-driver.js"
import { app } from "electron"
import { join } from "node:path"
import { prepareClaudePermissionObserver } from "./permission-observer.js"

export const claudeLiveDriver = createClaudeSdkDriver({
  available: () =>
    resolveExecutable(process.env.CLAUDE_CODE_EXECUTABLE ?? "claude") !== null,
  configure: async (...args) =>
    (await import("./sdk-options.js")).claudeSdkOptions(...args),
  query,
  prepareApprovals: input => prepareClaudePermissionObserver({ ...input, root: join(app.getPath("userData"), "approval-evidence") }),
})
