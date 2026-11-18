import { stat } from "node:fs/promises"
import type { ProviderAccountCapability } from "./account-capability.js"

/**
 * How long a credential revision read stands for the asks that follow it. Within it, a sign-in changed outside Mako
 * that moved none of the files the revision reads (a Keychain item alone) isn't seen; every other change is seen at
 * once. A few seconds, as a check and the send it admits were never one step: the read itself took a fraction of one.
 */
export const CREDENTIAL_HOLD_MS = 3_000

interface Held {
  /** The files the revision reads, as they stood when the read began. */
  stamp: string
  at: number
  reading: Promise<string>
}

/** Size, change time and identity of each file, or that it is absent: a write or a replacement moves one of them. */
async function sourceStamp(paths: readonly string[]): Promise<string> {
  const stamps = await Promise.all(paths.map(async (path) => {
    try {
      const info = await stat(path, { bigint: true })
      return `${info.size}:${info.mtimeNs}:${info.ctimeNs}:${info.ino}`
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return "absent"
      throw error
    }
  }))
  return stamps.join("|")
}

/**
 * The credential revisions the host's accounts read, held a short time. Each warm prompt and each steer asks for its
 * launch account's revision, and Claude's is read from the Keychain by a `security` process: one spawn before every
 * message. A read here serves every ask for `CREDENTIAL_HOLD_MS`, and concurrent asks share the one under way.
 *
 * What ends a held read at once: an account change made in Mako (`forget`, called as the change begins and as it
 * ends), and any change to the files the adapter says its revision reads (`credentialSources`), which are stat'ed on
 * every ask. An adapter that names no sources is read every time, as before.
 */
export class CredentialRevisions {
  private readonly held = new Map<string, Held>()
  /** Counts the account changes made here per harness: a read that spans one isn't returned. */
  private readonly changes = new Map<string, number>()
  private readonly holdMs: number
  private readonly now: () => number

  constructor(holdMs = CREDENTIAL_HOLD_MS, now: () => number = Date.now) {
    this.holdMs = holdMs
    this.now = now
  }

  /** An account of `provider` changed in Mako: nothing read before now answers an ask from now on. */
  forget(provider: string): void {
    this.changes.set(provider, (this.changes.get(provider) ?? 0) + 1)
    for (const key of this.held.keys()) if (key.startsWith(`${provider}\0`)) this.held.delete(key)
  }

  async read(capability: ProviderAccountCapability, name: string, env?: NodeJS.ProcessEnv): Promise<string> {
    const sources = capability.credentialSources?.(name, env)
    if (!sources) return capability.credentialRevision(name, env)
    const provider = capability.provider
    const key = [provider, name, ...sources].join("\0")
    for (;;) {
      const change = this.changes.get(provider) ?? 0
      const stamp = await sourceStamp(sources)
      let held = this.held.get(key)
      if (!held || held.stamp !== stamp || this.now() - held.at >= this.holdMs) {
        const reading = capability.credentialRevision(name, env)
        const entry: Held = { stamp, at: this.now(), reading }
        held = entry
        this.held.set(key, entry)
        // A failed read answers only those already waiting on it.
        reading.catch(() => { if (this.held.get(key) === entry) this.held.delete(key) })
      }
      const revision = await held.reading
      // An account changed in Mako while this was read or waited on: what was read may be the account before it.
      if ((this.changes.get(provider) ?? 0) === change) return revision
    }
  }
}
