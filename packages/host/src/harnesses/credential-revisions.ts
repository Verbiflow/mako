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
export type CredentialHold = <Value>(key: string, read: () => Promise<Value>, current?: StillCurrent<Value>) => Promise<Value>

/**
 * Whether the store still stands as it did when `value` was read from it at `readAt`, told without reading the secret
 * again: from the store's own stamp of when it was last written. False wherever that can't be told surely. With it, a
 * held read is kept standing while a conversation is warm (`CredentialRevisions.refresh`); without it, a read only ages.
 */
export type StillCurrent<Value> = (value: Value, readAt: number) => Promise<boolean>

/** Reads straight through: what an adapter is given where nothing is held. */
export const unheld: CredentialHold = (_key, read) => read()

/**
 * How often a held read is checked while a conversation of its harness is warm (`refresh`): under the hold by the
 * job's own drift (a tenth) and the check's time, so a message to a warm conversation finds a read that still stands.
 * A check at 2.5 s is as good as one sooner: what matters is only that one lands inside each hold.
 */
export const CREDENTIAL_REFRESH_MS = 2_500
/**
 * How long after an ask last used it a read is still checked: two minutes, the time in which most replies to an
 * answer are sent. A conversation left longer pays for one read with its next message, as every message did, and
 * nothing is run for it meanwhile.
 */
export const CREDENTIAL_REFRESH_FOR_MS = 2 * 60_000

interface Held {
  /** When the store was last known to stand as `reading` read it: when the read began, or a later check that found it unchanged. */
  at: number
  reading: Promise<unknown>
  /** Whether the store still stands as it was read (`StillCurrent`), for `refresh`; gone once a check couldn't say so. */
  check?: () => Promise<boolean>
  /** A check of it is under way: another isn't begun beside it. */
  checking?: boolean
  /** When an ask last used this key. */
  asked: number
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
 *
 * While a conversation of a harness is warm the host checks its held reads every `CREDENTIAL_REFRESH_MS`
 * (`refresh`): the adapter says, from the store's own stamp of its last write and without reading the secret, whether
 * the store still stands as it was read, and a read it vouches for stands from that check on. So the next message
 * finds a read no older than the hold instead of paying for its own. The check never reads what the read read: where
 * the store changed, or the check failed or couldn't say, the read is left to age out and isn't checked again, and
 * the next ask reads for itself as every ask did. No check is begun beside one still under way.
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

  /**
   * Checks every read of `providers` that an ask used in the last `CREDENTIAL_REFRESH_FOR_MS` and whose adapter can
   * say whether its store still stands (`StillCurrent`): one that does stands from when this check began. One that
   * doesn't, whose check fails, or that spans an account change made in Mako, is left as it was and never checked
   * again. Returns how many are being checked, so its caller stops asking at none.
   */
  refresh(providers: ReadonlySet<string>): number {
    let checked = 0
    for (const [id, held] of this.held) {
      const provider = id.slice(0, id.indexOf("\0"))
      if (!providers.has(provider)) continue
      const began = this.now()
      if (began - held.asked >= CREDENTIAL_REFRESH_FOR_MS) {
        if (began - held.at >= this.holdMs) this.held.delete(id)
        continue
      }
      const check = held.check
      if (!check) continue
      checked += 1
      if (held.checking) continue
      held.checking = true
      const change = this.changes.get(provider) ?? 0
      void check().catch(() => false).then((current) => {
        held.checking = false
        if (current && (this.changes.get(provider) ?? 0) === change && this.held.get(id) === held) held.at = Math.max(held.at, began)
        else held.check = undefined
      })
    }
    return checked
  }

  /** What `provider`'s adapter holds its costly reads with. */
  holder(provider: string): CredentialHold {
    return async <Value>(key: string, read: () => Promise<Value>, current?: StillCurrent<Value>): Promise<Value> => {
      const id = `${provider}\0${key}`
      for (;;) {
        const change = this.changes.get(provider) ?? 0
        const held = this.held.get(id)
        let reading: Promise<Value>
        if (held) held.asked = this.now()
        if (held && this.now() - held.at < this.holdMs) {
          // SAFETY: an entry is only ever made below, under this id, from this key's own `read`; an adapter gives one
          // key one kind of value.
          reading = held.reading as Promise<Value>
        } else {
          reading = read()
          const readAt = this.now()
          const entry: Held = { at: readAt, reading, asked: readAt, ...current && { check: async () => current(await reading, readAt) } }
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
