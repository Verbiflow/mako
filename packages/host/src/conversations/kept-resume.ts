import type { KeptRestore, ThreadRef } from "@mako/sessions"
import { outdatedOf, outdatedText, OutdatedRuntimeSchema, restoreGate, type InstalledReading, type OutdatedRuntime, type SessionWriters } from "@mako/sessions/record-writers"
import type { ProviderBinding, ResumeVerdict } from "../contracts/conversation-control.js"
import type { OutdatedRestore, RestorePlan, RuntimeUpdateOffer } from "../contracts/restore-plan.js"
import { keptByRecords } from "../contracts/thread-continuation.js"
import { hostLog, hostWarn } from "../base/host-log.js"

/** The installed version a restore here resumes under, and how it's updated (`RuntimeUpdates.restoreRuntime`). */
export interface InstalledRuntime {
  version: string | null
  /** When its binary was put there, unchanged since, and whether it's the only install: what proves it new enough for a session nothing names the writer of. */
  since?: number
  sole?: boolean
  /** Other programs of the harness, for records they wrote (`cursor-agent`). */
  lines?: Record<string, InstalledReading>
  offer: RuntimeUpdateOffer
}

/** The install as the restore gate reads it, or null when its version is unknown (which blocks nothing). */
export function installedReading(installed: InstalledRuntime): InstalledReading | null {
  if (installed.version === null) return null
  return {
    version: installed.version,
    ...installed.since !== undefined && { since: installed.since },
    ...installed.sole !== undefined && { sole: installed.sole },
    ...installed.lines && { lines: installed.lines },
  }
}

export interface KeptResumeDeps {
  /** The harness's own verdict (`Harnesses.assessResume`). */
  assess(binding: ProviderBinding): Promise<ResumeVerdict>
  /** The catalog's row at `path`, kept rows included. */
  ref(path: string): ThreadRef | undefined
  /** The Mako host that holds the session live, named for the person, or null when none other does. */
  heldElsewhere(provider: string, nativeId: string): string | null
  /** The harness installed here, as a restore weighs it. */
  installed(harness: string): InstalledRuntime
  /** Puts the session back into its harness's store from Mako's records, unless `installed` may not read them (`SessionCatalog.restoreKept`, `restoreGate`). */
  restore(path: string, installed: InstalledReading | null): Promise<KeptRestore>
  /** What the record store knows of who wrote the session at `path` (`SessionCatalog.recordWriters`). */
  writers(path: string): SessionWriters | null
  label(harness: string): string
}

/**
 * Whether the session's records are another program's that the harness's
 * runtime imports to continue them (`InstalledReading.reader`: the Cursor
 * SDK imports `cursor-agent`'s stores), so the restore gate applies to the
 * import as it does to a restore, while its harness still holds them.
 */
function imported(writers: SessionWriters | null, installed: InstalledRuntime): boolean {
  const line = writers?.evidence?.line
  return line !== undefined && installed.lines?.[line]?.reader !== undefined
}

/** The verdict for records the installed runtime may not read: the conversation goes on from its transcript, with the update offer. */
function outdatedVerdict(binding: ProviderBinding, label: string, installed: InstalledRuntime, refused: OutdatedRuntime, what: string): ResumeVerdict {
  const outdated: OutdatedRestore = { harness: binding.provider, ...refused, offer: installed.offer }
  hostLog("records", what, { harness: binding.provider, nativeId: binding.nativeId, wrote: refused.wrote?.version ?? null, source: refused.wrote?.source ?? null, upTo: refused.upTo ?? null, installed: refused.installed, reader: refused.reader ?? null })
  return { kind: "closed", reason: `${outdatedText(label, refused)} It goes on from its transcript.`, outdated }
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
 *
 * The restore takes the version of the harness installed here, and writes
 * nothing when that's older than the newest version that wrote the records
 * (`restoreGate`, the rule `restorePlan` shows before a reply): the verdict
 * is then `closed` with what the update would be, and the conversation
 * continues from its transcript unless the person updates first.
 */
export function restoringResume(deps: KeptResumeDeps): (binding: ProviderBinding) => Promise<ResumeVerdict> {
  return async (binding) => {
    const ref = binding.path ? deps.ref(binding.path) : undefined
    if (!ref || ref.harness !== binding.provider || ref.nativeId !== binding.nativeId) return deps.assess(binding)
    if (!keptByRecords(ref)) {
      // Records the runtime imports rather than resumes in place go through the same gate.
      const writers = deps.writers(ref.path)
      const installed = deps.installed(binding.provider)
      const refused = imported(writers, installed) ? outdatedOf(restoreGate(writers, installedReading(installed))) : null
      return refused ? outdatedVerdict(binding, deps.label(binding.provider), installed, refused, "a session's records may be newer than what imports them here, so they weren't imported") : deps.assess(binding)
    }
    const before = await deps.assess(binding)
    if (before.kind !== "unavailable") return before
    const holder = deps.heldElsewhere(binding.provider, binding.nativeId)
    if (holder) return { kind: "held", by: holder }
    const label = deps.label(binding.provider)
    const installed = deps.installed(binding.provider)
    // A store that failed as it was written: the person reads what failed, the log the store's own words too.
    let failure: string | undefined
    const restored = await deps.restore(ref.path, installedReading(installed)).catch((error: Error): KeptRestore => {
      failure = error.message
      return { kind: "refused", reason: `Mako couldn't put this session back into ${label}'s store here.` }
    })
    switch (restored.kind) {
      case "restored":
        hostLog("records", "a session its harness deleted was restored for it to resume", { harness: binding.provider, nativeId: binding.nativeId, files: restored.files, rows: restored.rows, ms: restored.ms })
        return deps.assess({ ...binding, path: restored.path })
      case "present":
        return deps.assess({ ...binding, path: restored.path })
      case "forked":
        hostLog("records", "a session its harness kept otherwise was restored as a fork", { harness: binding.provider, nativeId: binding.nativeId, fork: restored.nativeId })
        return { kind: "unavailable", reason: `${label} holds a copy of this session that went on without Mako, so Mako restored its own beside it as a new ${label} session. Open that one from the rail to go on from Mako's copy.` }
      case "outdated": {
        return outdatedVerdict(binding, label, installed, OutdatedRuntimeSchema.parse(restored), "a session's records may be newer than its harness here, so they weren't restored")
      }
      case "refused":
        hostWarn("records", "a session its harness deleted could not be restored", { harness: binding.provider, nativeId: binding.nativeId, reason: restored.reason, ...failure !== undefined && { error: failure } })
        return { kind: "unavailable", reason: restored.reason }
    }
  }
}

/**
 * What a reply to `ref` will do, before it's sent: restore and resume
 * natively, or wait for the update the gate asks for. The same rule the
 * restore applies (`restoreGate`), on the writers the record store keeps,
 * so the composer's offer and the reply never disagree.
 */
export function restorePlan(ref: ThreadRef | undefined, writers: SessionWriters | null, installed: InstalledRuntime): RestorePlan {
  if (!ref || (!keptByRecords(ref) && !imported(writers, installed))) return { kind: "none" }
  const refused = outdatedOf(restoreGate(writers, installedReading(installed)))
  return refused ? { kind: "update", outdated: { harness: ref.harness, ...refused, offer: installed.offer } } : { kind: "native" }
}
