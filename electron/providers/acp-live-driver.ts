import { acpDefaultMode, acpSessionModes } from "../acp-access.js"
import type { ProviderAcpSource } from "./acp-source.js"
import type { ProviderLiveDriver } from "./live-driver.js"

/** Shared ACP transport; each provider contributes its own launch capability. */
export function acpLiveDriver(source: ProviderAcpSource): ProviderLiveDriver {
  if (source.backgroundStop.kind === "ends-on-stop" && !source.observeBackground)
    throw new Error(`${source.provider}: Stop can end background work only through the provider's background observer`)
  if (source.canResume && !source.locateSession)
    throw new Error(`${source.provider}: a resumable ACP source must locate its sessions, or a new session's dropped first turn cannot be continued`)
  return {
    provider: source.provider,
    approvalEvidence: source.approvalEvidence,
    planning: source.planning,
    backgroundStop: source.backgroundStop,
    approvalAnswerDigest: source.approvalAnswerDigest,
    observesNativeAgents: source.observeAgents ? true : undefined,
    canResume: source.canResume,
    turnRecovery: source.canResume
      ? {
          kind: "continues",
          accepted: "The agent's first output of the turn, or the session/prompt response when nothing streams first.",
          exit: "The connection's close aborts the turn, whose failed result then waits for the process exit, which settles the session failed and disconnected in one update, with the session's source located by its ID.",
          tests: ["scripts/test-acp-provider-turn.mjs", "scripts/test-turn-recovery-live.mjs"],
        }
      : { kind: "manual", reason: `${source.provider} cannot reopen its sessions, so a turn its process dropped is left to the user.` },
    compaction: source.compaction?.kind === "supported"
      ? { kind: "supported", start: async (id, actionId) => (await import("../acp.js")).liveCompact(id, actionId) }
      : source.compaction,
    checkpoint: source.checkpoint,
    resumeVerdict: source.resumeVerdict,
    available: (appPath) => source.available(appPath),
    start: async (cwd, options) =>
      (await import("../acp.js")).liveStart(source.provider, cwd, options),
    prompt: async (...args) => (await import("../acp.js")).livePrompt(...args),
    steer: source.steering
      ? async (...args) => (await import("../acp.js")).liveSteer(...args)
      : undefined,
    steering: source.steering === "interrupting-prompt" ? "interrupt" : source.steering ? "step" : undefined,
    modes: acpSessionModes(
      source.access,
      source.nativeModes ? { availableModes: [...source.nativeModes] } : null
    ),
    defaultMode: acpDefaultMode(source.access),
    permission: async (id, requestId, response, dispatch) => {
      const { acpRespondPermission } = await import("../acp.js")
      dispatch.assertCurrent()
      dispatch.report(acpRespondPermission(id, requestId, response))
    },
    cancel: async (id) => (await import("../acp.js")).liveCancel(id),
    close: async (id) => (await import("../acp.js")).liveClose(id),
    setMode: async (...args) => {
      await (await import("../acp.js")).liveSetMode(...args)
    },
  }
}
