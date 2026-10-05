import type { AccountConfirmation, ExecutionContext, NativeIdentityCapability } from "./contracts/execution-context.js"

export function launchContext(
  transport: string,
  identity: NativeIdentityCapability,
  account?: { name: string; dir?: string },
  executable?: string
): ExecutionContext {
  return {
    transport, executable,
    runtime: { kind: "unavailable", reason: "The native process has not reported its runtime version." },
    account: account
      ? { kind: "configured", name: account.name, managed: Boolean(account.dir) }
      : { kind: "unavailable", reason: "This launch resolves credentials without a managed account selection." },
    identity: identity.kind === "reported" ? { kind: "pending" } : identity,
    credential: { kind: "unavailable", reason: "This launch has not reported its credential source and revision." },
    service: { kind: "unavailable", reason: "The native process has not reported its service authority." },
    store: { kind: "unavailable", reason: "The native session source has not been located." },
  }
}

/** Missing versions remain missing; never substitute the host's package version. */
export function reportedRuntime(version: string | undefined, via: string): ExecutionContext["runtime"] {
  return version?.trim()
    ? { kind: "reported", version, via }
    : { kind: "unavailable", reason: `The native ${via} response did not report a runtime version.` }
}

/** An API key/backend is not a named native principal. */
export function reportedIdentity(principal: string | null | undefined, backend: string, via: string): ExecutionContext["identity"] {
  return principal?.trim()
    ? { kind: "reported", principal, backend, via }
    : { kind: "unavailable", backend, reason: `The native ${via} response did not report a named identity.` }
}

/** Whether the reported identity is the launch account, by email. Pending identity has no answer yet. */
export function confirmAccount(identity: ExecutionContext["identity"], expected: string | undefined): AccountConfirmation | undefined {
  if (identity.kind === "pending") return undefined
  if (identity.kind === "unavailable") return { kind: "unavailable", reason: identity.reason }
  if (!expected) return { kind: "unavailable", reason: "Mako has no email for this account to compare with what the agent reported." }
  return identity.principal.trim().toLowerCase() === expected.trim().toLowerCase()
    ? { kind: "matches", principal: identity.principal }
    : { kind: "differs", principal: identity.principal, expected }
}

export function disconnectedContext(context: ExecutionContext | undefined): ExecutionContext | undefined {
  return context?.identity.kind === "pending"
    ? { ...context, identity: { kind: "unavailable", reason: "The native process disconnected before reporting its identity." } }
    : context
}

export type ContextCompatibility =
  | { kind: "compatible" }
  | { kind: "incompatible"; reason: string }
  | { kind: "unverified"; missing: string[] }

/** Account selection is global. A principal changing with a deliberate
 * account change is allowed; a known backend change is not silently treated
 * as the same execution context. Version equality is not a schema guarantee. */
export function assessExecutionContext(saved: ExecutionContext | undefined, opened: ExecutionContext | undefined, imported: boolean): ContextCompatibility {
  if (!saved || !opened) return { kind: "unverified", missing: ["execution-context"] }
  if (saved.transport !== opened.transport && !imported)
    return { kind: "incompatible", reason: "The native transport changed without a verified source import." }
  const backend = (identity: ExecutionContext["identity"]) => identity.kind === "pending" ? undefined : identity.backend
  const previousBackend = backend(saved.identity)
  const currentBackend = backend(opened.identity)
  if (previousBackend && currentBackend && previousBackend !== currentBackend)
    return { kind: "incompatible", reason: "The native authentication backend changed. Reconcile the selected account before resuming." }
  if (saved.service?.kind === "reported" && opened.service?.kind === "reported" && saved.service.authority !== opened.service.authority)
    return { kind: "incompatible", reason: "The native service authority changed. Reconcile the selected service before resuming." }
  if (saved.service?.kind === "reported" && opened.service?.kind !== "reported")
    return { kind: "incompatible", reason: "The runtime could not verify the reopened native service authority. No prompt was dispatched." }
  if (saved.identity.kind === "reported" && opened.identity.kind !== "reported")
    return { kind: "incompatible", reason: "The runtime could not verify the reopened account's native identity. Retry after sign-in is available; the saved conversation was preserved." }
  if (saved.account.kind === "configured" && opened.account.kind !== "configured")
    return { kind: "incompatible", reason: "The runtime could not verify the reopened account selection. No prompt was dispatched." }
  if (saved.account.kind === "configured" && opened.account.kind === "configured" && saved.account.managed === opened.account.managed && saved.account.name === opened.account.name && saved.identity.kind === "reported" && opened.identity.kind === "reported" && saved.identity.principal !== opened.identity.principal)
    return { kind: "incompatible", reason: "The unchanged account selection reported a different native identity. No prompt was dispatched." }
  const missing: string[] = []
  if (saved.runtime.kind !== "reported" || opened.runtime.kind !== "reported") missing.push("runtime-version")
  else if (saved.runtime.version !== opened.runtime.version) missing.push("runtime-version-compatibility")
  if (saved.identity.kind !== "reported" || opened.identity.kind !== "reported") missing.push("effective-identity")
  if (saved.account.kind !== "configured" || opened.account.kind !== "configured") missing.push("configured-account")
  if (saved.credential?.kind !== "configured" || opened.credential?.kind !== "configured" || saved.credential.revision.kind !== "reported" || opened.credential.revision.kind !== "reported")
    missing.push("credential-revision")
  else if (saved.credential.source !== opened.credential.source || saved.credential.revision.value !== opened.credential.revision.value)
    missing.push("credential-compatibility")
  if (saved.service?.kind !== "reported" || opened.service?.kind !== "reported") missing.push("service-authority")
  return missing.length ? { kind: "unverified", missing } : { kind: "compatible" }
}

/** One bounded read per launch. Recovery waits before admitting input. A late result cannot modify
 * a closed/replaced process, and timeout is never an identity confirmation. */
export async function observeNativeIdentity(
  read: () => Promise<ExecutionContext["identity"]>,
  current: () => boolean,
  publish: (identity: ExecutionContext["identity"]) => void,
  timeoutMs = 5_000
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const identity = await Promise.race([
      Promise.resolve().then(read),
      new Promise<ExecutionContext["identity"]>(resolve => {
        timer = setTimeout(() => resolve({ kind: "unavailable", reason: "The native identity request timed out." }), timeoutMs)
      }),
    ])
    if (current()) publish(identity)
  } catch {
    if (current()) publish({ kind: "unavailable", reason: "The native process could not report its identity." })
  } finally {
    clearTimeout(timer)
  }
}
