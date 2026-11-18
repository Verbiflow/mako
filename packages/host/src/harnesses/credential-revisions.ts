/**
 * How long a held credential read stands for the asks that follow it. Within it, a sign-in changed outside Mako in
 * the store the read is of (Claude's Keychain item) isn't seen; everything else a revision reads is read on every ask.
 * A few seconds, as a check and the send it admits were never one step: the read itself took a fraction of one.
 */
export const CREDENTIAL_HOLD_MS = 3_000

/**
 * A read an adapter may have held for it while it works out a credential revision (`credentialRevision`'s `hold`):
 * the one that costs a process. `key` names what is read, so two accounts' stores are never one answer.
 */
export type CredentialHold = <Value>(key: string, read: () => Promise<Value>) => Promise<Value>

/** Reads straight through: what an adapter is given where nothing is held. */
export const unheld: CredentialHold = (_key, read) => read()

interface Held {
  at: number
  reading: Promise<unknown>
}

/**
 * The costly part of a credential revision, held a short time. Each warm prompt and each steer asks for its launch
 * account's revision, and Claude's sign-in is read from the Keychain by a `security` process: one spawn before every
 * message. A read held here serves every ask for `CREDENTIAL_HOLD_MS`, and concurrent asks share the one under way.
 *
 * Only what the adapter asks to have held is: the files a revision reads are read on every ask, as they always were,
 * so nothing here depends on a file's times moving. What ends a held read at once is an account change made in Mako
 * (`forget`, called as the change begins and as it ends). A change made outside Mako to the held store alone is seen
 * when the read ages out.
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

  /** What `provider`'s adapter holds its costly reads with. */
  holder(provider: string): CredentialHold {
    return async <Value>(key: string, read: () => Promise<Value>): Promise<Value> => {
      const id = `${provider}\0${key}`
      for (;;) {
        const change = this.changes.get(provider) ?? 0
        const held = this.held.get(id)
        let reading: Promise<Value>
        if (held && this.now() - held.at < this.holdMs) {
          // SAFETY: an entry is only ever made below, under this id, from this key's own `read`; an adapter gives one
          // key one kind of value.
          reading = held.reading as Promise<Value>
        } else {
          reading = read()
          const entry: Held = { at: this.now(), reading }
          this.held.set(id, entry)
          // A failed read answers only those already waiting on it.
          reading.catch(() => { if (this.held.get(id) === entry) this.held.delete(id) })
        }
        const value = await reading
        // An account changed in Mako while this was read or waited on: what was read may be the account before it.
        if ((this.changes.get(provider) ?? 0) === change) return value
      }
    }
  }
}
