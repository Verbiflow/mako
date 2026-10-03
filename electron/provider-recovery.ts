import type { ProviderBinding, ResumeVerdict } from "./contracts/conversation-control.js"
import { assessResumeEvidence } from "./native-continuation.js"
import type { ProviderLiveDriver } from "./providers/live-driver.js"
import { hostLog, hostWarn } from "./host-log.js"

/** The admission boundary used by catalog, reconnect and wake. Never launches. */
export async function assessProviderResume(binding: ProviderBinding, driver: ProviderLiveDriver | undefined): Promise<ResumeVerdict> {
  if (!driver || driver.provider !== binding.provider)
    return { kind: "unavailable", reason: "The saved session's provider is not available." }
  if (!driver.canResume || !driver.inspectNativeSession)
    return { kind: "unavailable", reason: "This provider has not implemented native session recovery evidence." }
  if (!binding.nativeId || !binding.path)
    return { kind: "unavailable", reason: "The native session identity or source has not been located." }
  const started = performance.now()
  try {
    const evidence = await driver.inspectNativeSession(binding)
    const verdict = assessResumeEvidence(binding, evidence)
    hostLog("recovery", "native session assessed", {
      harness: binding.provider, binding: binding.id, nativeId: binding.nativeId,
      outcome: verdict.kind,
      strategy: evidence.kind === "available" ? evidence.strategy : undefined,
      record: verdict.kind === "resumable" ? verdict.record : undefined,
      elapsedMs: Math.round((performance.now() - started) * 100) / 100,
    })
    return verdict
  } catch (error) {
    hostWarn("recovery", "native session evidence failed", {
      harness: binding.provider, binding: binding.id,
      error: error instanceof Error ? error.name : "unknown",
      elapsedMs: Math.round((performance.now() - started) * 100) / 100,
    })
    return { kind: "unavailable", reason: "Native session recovery evidence could not be read. Retry after its source is available." }
  }
}
