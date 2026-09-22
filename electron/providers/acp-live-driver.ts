import { acpDefaultMode, acpSessionModes } from "../acp-access.js"
import type { ProviderAcpSource } from "./acp-source.js"
import type { ProviderLiveDriver } from "./live-driver.js"

/** Shared ACP transport; each provider contributes its own launch capability. */
export function acpLiveDriver(source: ProviderAcpSource): ProviderLiveDriver {
  return {
    provider: source.provider,
    observesNativeAgents: source.observeAgents ? true : undefined,
    canResume: source.canResume,
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
    permission: async (...args) => {
      ;(await import("../acp.js")).acpRespondPermission(...args)
    },
    cancel: async (id) => (await import("../acp.js")).liveCancel(id),
    close: async (id) => (await import("../acp.js")).liveClose(id),
    setMode: async (...args) => {
      await (await import("../acp.js")).liveSetMode(...args)
    },
  }
}
