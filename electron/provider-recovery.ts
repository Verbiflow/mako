import type { ProviderBinding, ResumeVerdict } from "./contracts/conversation-control.js"
import { assessResumeEvidence } from "./native-continuation.js"
import type { ProviderLiveDriver } from "./providers/live-driver.js"
import { hostLog, hostWarn } from "./host-log.js"
import type { LiveSessionState } from "./shared.js"
import { sameNativeSource } from "./native-source.js"
import { assessExecutionContext } from "./execution-context.js"

/** Validate what actually opened before any prompt or saved-binding replacement.
 * Account selection may change intentionally; a reused native ID must still
 * name the admitted source. Only an adapter's explicit copy evidence permits
 * migration to a different store (for example an imported SDK store).
 */
export async function verifyRecoveredSession(binding: ProviderBinding, session: LiveSessionState, driver: ProviderLiveDriver): Promise<void> {
  if (session.harness !== binding.provider || driver.provider !== binding.provider || session.nativeId !== binding.nativeId)
    throw new Error("The provider opened a different native session. The saved conversation was not replaced.")
  const sameSource = (left: string, right: string) => sameNativeSource(driver, left, right, binding.nativeId)
  const savedStore = binding.executionContext?.store
  if (binding.path && savedStore?.kind === "located" && !await sameSource(binding.path, savedStore.path))
    throw new Error("The saved native source disagrees with its execution context. No prompt was dispatched.")
  const openedStore = session.executionContext?.store
  if (session.nativePath && openedStore?.kind === "located" && !await sameSource(session.nativePath, openedStore.path))
    throw new Error("The opened native source disagrees with its execution context. No prompt was dispatched.")
  const openedPath = session.nativePath ?? (openedStore?.kind === "located" ? openedStore.path : undefined)
  if (binding.path && !openedPath)
    throw new Error("The selected runtime did not locate the reopened native source. No prompt was dispatched.")
  let imported = false
  if (binding.path && openedPath && !await sameSource(binding.path, openedPath)) {
    const receipt = session.executionContext?.sourceImport
    if (!receipt || receipt.nativeId !== binding.nativeId || !await sameSource(receipt.source, binding.path) || !await sameSource(receipt.destination, openedPath))
      throw new Error("The selected runtime or account opened a different native store without an exact import receipt. No prompt was dispatched; the saved binding was preserved.")
    const evidence = await driver.inspectNativeSession?.(binding)
    if (evidence?.kind !== "available" || evidence.strategy !== "copy")
      throw new Error("The adapter could not verify the imported native source. No prompt was dispatched; the saved binding was preserved.")
    imported = true
    hostLog("recovery", "native source import verified", { harness: binding.provider, binding: binding.id, via: receipt.via })
  }
  const compatibility = assessExecutionContext(binding.executionContext, session.executionContext, imported)
  if (compatibility.kind === "incompatible") throw new Error(compatibility.reason)
  hostLog("recovery", "opened execution context assessed", {
    harness: binding.provider, binding: binding.id, outcome: compatibility.kind,
    missing: compatibility.kind === "unverified" ? compatibility.missing.join(",") : undefined,
    nativeExclusion: driver.nativeExclusion?.kind ?? "undeclared",
  })
}

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
    const store = binding.executionContext?.store
    if (store?.kind === "located" && !await sameNativeSource(driver, binding.path, store.path, binding.nativeId))
      return { kind: "unavailable", reason: "The saved native source disagrees with its execution context." }
    const evidence = await driver.inspectNativeSession(binding)
    const verdict = assessResumeEvidence(binding, evidence)
    hostLog("recovery", "native session assessed", {
      harness: binding.provider, binding: binding.id, nativeId: binding.nativeId,
      outcome: verdict.kind,
      strategy: evidence.kind === "available" ? evidence.strategy : undefined,
      nativeExclusion: driver.nativeExclusion?.kind ?? "undeclared",
      contextRetained: binding.executionContext !== undefined,
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
