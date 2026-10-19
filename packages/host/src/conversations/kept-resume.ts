import type { KeptRestore, ThreadRef } from "@mako/sessions"
import type { ProviderBinding, ResumeVerdict } from "../contracts/conversation-control.js"
import { keptByRecords } from "../contracts/thread-continuation.js"
import { hostLog, hostWarn } from "../base/host-log.js"

export interface KeptResumeDeps {
  /** The harness's own verdict (`Harnesses.assessResume`). */
  assess(binding: ProviderBinding): Promise<ResumeVerdict>
  /** The catalog's row at `path`, kept rows included. */
  ref(path: string): ThreadRef | undefined
  /** The Mako host that holds the session live, named for the person, or null when none other does. */
  heldElsewhere(provider: string, nativeId: string): string | null
  /** Puts the session back into its harness's store from Mako's records (`SessionCatalog.restoreKept`). */
  restore(path: string): Promise<KeptRestore>
  label(harness: string): string
}

/**
 * Every resume's verdict, for a session its harness deleted too: a catalog
 * row Mako keeps the records of (`keptByRecords`) is restored into the
 * harness's own store before the harness's verdict is asked again, so a
 * reply from the rail, a reconnect, a wake and a switch back to a binding
 * all resume the same session natively. One path, keyed by the store
 * holding the session; nothing per harness.
 *
 * It restores only once nothing holds the session: no process has it open
 * (the harness's own verdict, asked first, says `held`), and no other Mako
 * host holds it live. A restore is idempotent; one whose harness kept a
 * copy that went on without Mako leaves that copy and writes Mako's version
 * as the harness's own fork, which the person opens from the rail.
 */
export function restoringResume(deps: KeptResumeDeps): (binding: ProviderBinding) => Promise<ResumeVerdict> {
  return async (binding) => {
    const ref = binding.path ? deps.ref(binding.path) : undefined
    if (!ref || ref.harness !== binding.provider || ref.nativeId !== binding.nativeId) return deps.assess(binding)
    if (!keptByRecords(ref)) return deps.assess(binding)
    const before = await deps.assess(binding)
    if (before.kind !== "unavailable") return before
    const holder = deps.heldElsewhere(binding.provider, binding.nativeId)
    if (holder) return { kind: "held", by: holder }
    const label = deps.label(binding.provider)
    const restored = await deps.restore(ref.path).catch((error: Error): KeptRestore => ({
      kind: "refused", reason: `Mako couldn't restore this session for ${label}: ${error.message}`,
    }))
    switch (restored.kind) {
      case "restored":
        hostLog("records", "a session its harness deleted was restored for it to resume", { harness: binding.provider, nativeId: binding.nativeId, files: restored.files, rows: restored.rows, ms: restored.ms })
        return deps.assess({ ...binding, path: restored.path })
      case "present":
        return deps.assess({ ...binding, path: restored.path })
      case "forked":
        hostLog("records", "a session its harness kept otherwise was restored as a fork", { harness: binding.provider, nativeId: binding.nativeId, fork: restored.nativeId })
        return { kind: "unavailable", reason: `${label} holds a copy of this session that went on without Mako, so Mako restored its own beside it as a new ${label} session. Open that one from the rail to go on from Mako's copy.` }
      case "refused":
        hostWarn("records", "a session its harness deleted could not be restored", { harness: binding.provider, nativeId: binding.nativeId, reason: restored.reason })
        return { kind: "unavailable", reason: restored.reason }
    }
  }
}
