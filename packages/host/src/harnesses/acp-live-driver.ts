import { acpDefaultMode, acpSessionModes } from "./acp-access.js"
import type { ProviderAcpSource } from "./acp-source.js"
import type { ProviderLiveDriver } from "./live-driver.js"
import { NO_NATIVE_EXCLUSION } from "../contracts/execution-context.js"
import type { AcpEngine } from "./acp.js"
import { approvalRoot, type HarnessContext, type ProviderHost } from "./host.js"

export const ACP_NATIVE_IDENTITY = {
  kind: "unavailable",
  reason: "ACP initialize/authentication reports methods, not the effective account identity. A verified native extension is required.",
} as const

/**
 * Shared ACP transport; each provider contributes its own launch capability.
 * The engine loads with the first session, so a host that never opens one
 * never loads the protocol.
 */
export function createAcpLiveDriver(
  source: ProviderAcpSource,
  host: Pick<ProviderHost, "discovery" | "mcpSources">,
  context: Pick<HarnessContext, "dataRoot" | "appRoot">
): ProviderLiveDriver {
  let loading: Promise<AcpEngine> | undefined
  const engine = () => (loading ??= import("./acp.js").then(({ createAcpEngine }) => createAcpEngine(source, {
    processes: host.discovery,
    servesMcp: () => host.mcpSources.get(source.provider) !== undefined,
    appRoot: context.appRoot,
    approvalRoot: approvalRoot(context),
  })))
  if (source.backgroundStop.kind === "ends-on-stop" && !source.observeBackground)
    throw new Error(`${source.provider}: Stop can end background work only through the provider's background observer`)
  if (source.fork.kind === "native" && (source.fork.point !== "checkpoint" || source.resume.kind !== "native"))
    throw new Error(`${source.provider}: a native ACP fork starts at a turn's checkpoint and opens with session/load`)
  const resume = source.resume
  const fork = source.fork
  const modes = acpSessionModes(source.access, source.nativeModes ? { availableModes: [...source.nativeModes] } : null)
  return {
    provider: source.provider,
    launchEnvironment: { kind: "prepared", via: "Shared ACP launch applies the admitted account environment before native process creation." },
    nativeIdentity: ACP_NATIVE_IDENTITY,
    nativeExclusion: NO_NATIVE_EXCLUSION,
    nativePromptIdentity: source.nativePromptIdentity,
    approvalEvidence: source.approvalEvidence,
    planning: source.planning,
    backgroundStop: source.backgroundStop,
    approvalAnswerDigest: source.approvalAnswerDigest,
    nativeAgents: source.agents.kind === "observed" ? { kind: "observed", via: source.agents.via } : source.agents,
    questions: source.questions,
    fork: fork.kind === "native" ? { kind: fork.kind, point: fork.point, via: fork.via } : fork,
    contextBreakdown: { kind: "unavailable", reason: "ACP's `usage_update` carries the context used and its size, nothing itemized." },
    resume: resume.kind === "native"
      ? { ...resume, locate: async (binding, cwd, env) => binding.nativeId ? resume.locate({ nativeId: binding.nativeId, cwd, env }) : undefined }
      : resume,
    turnRecovery: resume.kind === "native"
      ? {
          kind: "continues",
          accepted: "The agent's first output of the turn, or the session/prompt response when nothing streams first.",
          exit: "The connection's close aborts the turn, whose failed result then waits for the process exit, which settles the session failed and disconnected in one update, with the session's source located by its ID.",
          tests: ["scripts/test-acp-provider-turn.mjs", "scripts/test-turn-recovery-live.mjs"],
        }
      : { kind: "manual", reason: `${source.provider} cannot reopen its sessions, so a turn its process dropped is left to the user.` },
    compaction: source.compaction.kind === "supported"
      ? { kind: "supported", start: async (id, actionId) => (await engine()).compact(id, actionId) }
      : source.compaction,
    nativeSource: source.nativeSource,
    available: (appPath) => source.available(appPath),
    start: async (cwd, options) => (await engine()).start(cwd, options),
    prompt: async (...args) => (await engine()).prompt(...args),
    steering: source.steering.kind === "supported"
      ? {
          kind: "supported",
          lands: source.steering.wire === "interrupting-prompt" ? "interrupt" : "step",
          via: source.steering.via,
          steer: async (...args) => (await engine()).steer(...args),
        }
      : source.steering,
    modes,
    modeSwitching: modes.length > 1
      ? { kind: "native", via: "ACP `session/set_mode`." }
      : { kind: "single", reason: "The agent advertises one session mode." },
    defaultMode: acpDefaultMode(source.access),
    permission: async (id, requestId, response, dispatch) => {
      const acp = await engine()
      dispatch.assertCurrent()
      dispatch.report(acp.respondPermission(id, requestId, response))
    },
    cancel: async (id) => (await engine()).cancel(id),
    close: async (id) => (await engine()).close(id),
    setMode: async (...args) => {
      await (await engine()).setMode(...args)
    },
    stop: () => {
      void loading?.then((acp) => acp.stop())
    },
  }
}
