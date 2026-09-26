import { join } from "node:path"
import { accountEnv } from "../../accounts.js"
import type { ProviderModule } from "../host.js"
import { openCodeAccountCapability } from "./accounts.js"
import { createOpenCodeDriver } from "./live-driver.js"
import { openCodeMcpSource } from "./mcp.js"
import { openCodeNativeRunner } from "./native-runner.js"
import { openCodeProcessProbe } from "./process-probe.js"
import { openCodeProfileLoader } from "./profile.js"
import { openCodeSkillSource } from "./skills.js"
import { openCodeUpdateSource } from "./updates.js"

/**
 * OpenCode v2 runs through its native API: one `opencode serve --stdio` per
 * conversation, typed by `@opencode/client`. `opencode acp` was the transport
 * before; its bridge dropped native questions, could not bind a turn to the
 * message it sent, and needed a plugin to see permission decisions.
 */
export const installOpenCode: ProviderModule = (host) => {
  host.accountCapabilities.register(openCodeAccountCapability)
  host.nativeRunners.register(openCodeNativeRunner)
  host.liveDrivers.register(createOpenCodeDriver({
    env: () => accountEnv("opencode", process.env),
    approvalRoot: async () => {
      const { app } = await import("electron")
      return join(app.getPath("userData"), "approval-evidence")
    },
  }))
  host.profiles.register(openCodeProfileLoader)
  host.processProbes.register(openCodeProcessProbe)
  host.mcpSources.register(openCodeMcpSource)
  host.skillSources.register(openCodeSkillSource)
  host.updateSources.register(openCodeUpdateSource)
}
