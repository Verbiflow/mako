import { join } from "node:path"
import { accountEnv } from "../../accounts.js"
import { installHarness, lacks } from "../harness-definition.js"
import type { ProviderModule } from "../host.js"
import { openCodeAccountCapability } from "./accounts.js"
import { openCodeDecoderSource } from "./decoder-source.js"
import { createOpenCodeDriver } from "./live-driver.js"
import { openCodeMcpSource } from "./mcp.js"
import { openCodeNativeRunner } from "./native-runner.js"
import { openCodeProcessProbe } from "./process-probe.js"
import { openCodeProfileLoader } from "./profile.js"
import { emitOpenCodeSession } from "./session-emitter.js"
import { openCodeSkillSource } from "./skills.js"
import { openCodeUpdateSource } from "./updates.js"

/**
 * OpenCode v2 runs through its native API: one `opencode serve --stdio` per
 * conversation, typed by `@opencode/client`. `opencode acp` was the transport
 * before; its bridge dropped native questions, could not bind a turn to the
 * message it sent, and needed a plugin to see permission decisions.
 */
export const installOpenCode: ProviderModule = (host) => installHarness(host, {
  provider: "opencode",
  live: createOpenCodeDriver({
    env: () => accountEnv("opencode", process.env),
    approvalRoot: async () => {
      const { app } = await import("electron")
      return join(app.getPath("userData"), "approval-evidence")
    },
  }),
  decoder: openCodeDecoderSource,
  profile: openCodeProfileLoader,
  accounts: openCodeAccountCapability,
  acp: lacks("Runs on OpenCode’s native API"),
  nativeRunner: openCodeNativeRunner,
  processProbe: openCodeProcessProbe,
  mcp: openCodeMcpSource,
  skills: openCodeSkillSource,
  sessionEmitter: {
    provider: "opencode",
    emit: async (thread) => emitOpenCodeSession(thread, await accountEnv("opencode", process.env)),
  },
  connection: lacks("Signs in through OpenCode’s own providers"),
  updates: openCodeUpdateSource,
  artifactPreview: lacks("Writes no artifact Mako previews"),
})
