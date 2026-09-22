import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"
import { stat } from "node:fs/promises"
import { compareNativeCheckpoint, resumable, type ProviderBinding, type ResumeVerdict } from "./contracts/conversation-control.js"
import type { ProviderProcessProbe } from "./providers/process-probe.js"

/** Streaming fingerprints cover the entire native record without retaining it in memory. */
export async function nativeCheckpoint(
  path: string
): Promise<string | undefined> {
  try {
    const before = await stat(path)
    if (!before.isFile()) return undefined
    const hash = createHash("sha256")
    for await (const chunk of createReadStream(path)) hash.update(chunk)
    const after = await stat(path)
    if (
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ino !== after.ino
    )
      return undefined
    return hash.digest("hex")
  } catch {
    return undefined
  }
}

/** Native record evidence; adapters interpret stores, shared policy compares history. */
export type NativeResumeRecord =
  | { kind: "available"; checkpoint: string }
  | { kind: "unavailable"; reason: string }

export type NativeResumeReader = (binding: ProviderBinding) => Promise<NativeResumeRecord>

const readNativeFile: NativeResumeReader = async (binding) => {
  const current = binding.path ? await nativeCheckpoint(binding.path) : undefined
  return current === undefined
    ? { kind: "unavailable", reason: "The native record is missing or changed while it was being read." }
    : { kind: "available", checkpoint: current }
}

/** Shared ownership and history policy, with regular-file reading as the legacy default. */
export async function resumeVerdict(
  binding: ProviderBinding,
  probe: ProviderProcessProbe | undefined,
  readRecord: NativeResumeReader = readNativeFile
): Promise<ResumeVerdict> {
  if (!binding.nativeId)
    return { kind: "unavailable", reason: "The saved binding has no native session ID." }
  if (!binding.path)
    return { kind: "unavailable", reason: "The native session source has not been located." }
  if (!probe)
    return { kind: "unavailable", reason: "Whether another process has this session open cannot be checked for this provider." }
  const activity = await probe
    .probe(AbortSignal.timeout(probe.timeoutMs ?? 6_000))
    .catch(() => ({ kind: "unavailable" as const }))
  if (activity.kind !== "available")
    return { kind: "unavailable", reason: "Whether another process has this session open could not be checked." }
  if (
    activity.sessions.some(
      (session) =>
        session.nativeId === binding.nativeId || session.path === binding.path
    )
  )
    return { kind: "held", by: `another ${binding.provider} process` }
  const record = await readRecord(binding)
  if (record.kind === "unavailable") return record
  return { kind: "resumable", record: compareNativeCheckpoint(binding.checkpoint, record.checkpoint) }
}

/** The strict form: unowned and unchanged since the binding's checkpoint. */
export async function canResumeBinding(
  binding: ProviderBinding,
  probe: ProviderProcessProbe | undefined
): Promise<boolean> {
  return resumable(await resumeVerdict(binding, probe), "same")
}
