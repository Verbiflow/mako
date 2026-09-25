import { configureOpenCodePermissions } from "./permissions.js"
import { prepareOpenCodeApprovals } from "./approval-observer.js"
import { OpenCodeAgents } from "./agents.js"
import { openCodeCheckpoint, openCodeResumeVerdict } from "./resume.js"
import type { ProviderAcpSource } from "../acp-source.js"
import {
  openCodeExecutable,
  verifyOpenCodeSession,
  resolveOpenCodeInstallation,
} from "./installation.js"

export const openCodeAcpSource: ProviderAcpSource = {
  provider: "opencode",
  approvalEvidence: { kind: "native-decisions", recovery: "retained-observer", nativeRequests: ["tool-permission"], coverage: "Native v2 tool permission asked/replied events with exact scoped identities. Structured forms still need native bridge forwarding and answer integration; retained observation is bounded and may have gaps." },
  async observeAgents(input) {
    const observer = new OpenCodeAgents(input)
    await observer.ready
    return {
      observe({ sessionId, update }) {
        if (update.sessionUpdate !== "tool_call" && update.sessionUpdate !== "tool_call_update") return
        observer.observe({ sessionId, toolCallId: update.toolCallId, title: update.title ?? undefined, rawInput: update.rawInput, rawOutput: update.rawOutput, status: update.status ?? undefined })
      },
      dispose: () => observer.dispose(),
    }
  },
  compaction: { kind: "supported", command: "/compact", completion: { kind: "response" } },
  canResume: true,
  checkpoint: openCodeCheckpoint,
  resumeVerdict: openCodeResumeVerdict,
  launchOptionIds: ["effort"],
  access: {
    native: { plan: "plan" },
    launch: ["ask", "edits", "full"],
    base: "build",
    default: "ask",
  },
  nativeModes: [
    { id: "build", name: "build" },
    { id: "plan", name: "plan" },
  ],
  available: () => openCodeExecutable() !== null,
  async launch(options) {
    const env = options.env ?? process.env
    if (options.resume) await verifyOpenCodeSession(options.resume, options.nativePath, env)
    const installation = await resolveOpenCodeInstallation(env)
    const access = options.access ?? "ask"
    return {
      command: installation.command,
      args: ["acp"],
      configureEnvironment(env) { configureOpenCodePermissions(env, access) },
      prepareApprovals: prepareOpenCodeApprovals,
    }
  },
}
