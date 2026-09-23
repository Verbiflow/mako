import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"
import { open, stat } from "node:fs/promises"
import { compareNativeCheckpoint, resumable, type ProviderBinding, type ResumeVerdict } from "./contracts/conversation-control.js"
import type { ProviderProcessProbe } from "./providers/process-probe.js"

const TAIL_BYTES = 64 * 1024
const LEGACY_DIGEST = /^[0-9a-f]{64}$/

/**
 * Identity plus the record's last 64 KB. A native store only grows, so any
 * append moves the size and the stamp; the tail digest catches a same-size
 * rewrite inside one clock tick. Hashing whole records once took ten seconds
 * for a 3.7 GB Codex session on every thread click.
 */
export async function nativeCheckpoint(
  path: string,
  previous?: string
): Promise<string | undefined> {
  if (previous && LEGACY_DIGEST.test(previous)) return legacyDigest(path)
  try {
    const handle = await open(path, "r")
    try {
      const before = await handle.stat({ bigint: true })
      if (!before.isFile()) return undefined
      const length = Number(before.size < BigInt(TAIL_BYTES) ? before.size : BigInt(TAIL_BYTES))
      const tail = Buffer.alloc(length)
      await handle.read(tail, 0, length, Number(before.size) - length)
      const after = await handle.stat({ bigint: true })
      if (before.size !== after.size || before.mtimeNs !== after.mtimeNs) return undefined
      const digest = createHash("sha256").update(tail).digest("hex").slice(0, 32)
      return `v2:${before.size}:${before.mtimeNs}:${before.ctimeNs}:${before.ino}:${digest}`
    } finally {
      await handle.close()
    }
  } catch {
    return undefined
  }
}

/** Bindings saved before v2 hold a whole-record digest; only those pay for one. */
async function legacyDigest(path: string): Promise<string | undefined> {
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
  const current = binding.path ? await nativeCheckpoint(binding.path, binding.checkpoint) : undefined
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
