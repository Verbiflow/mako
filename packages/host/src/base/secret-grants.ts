import { createHash } from "node:crypto"
import type { Borrower, Grant, Kind, Lease, Refusal, SourceAnswer, SourceAsk } from "@mako/protocol/borrow"
import { LocalBorrowing, type LocalBorrowingOptions, type SourceFn } from "./local-borrowing.js"
import { DEVICE_ACCOUNT, SECRET_KINDS, secretGrantId, type SecretKind, type SecretListing, type SecretRecord, type Secrets, type SecretWrite } from "./secrets.js"

/**
 * The host's secrets as borrowing's vault on this device: every saved record stands as a grant of the device's own
 * broker, given by the person when they saved it and ended when they delete or replace it, and a Thread on this
 * device takes a value only under a lease (`lend`), which the device's lease log records by name and version, never
 * by value. The device reading its own store (signing in, refreshing a harness's sign-in) is the source at work, not
 * a borrow, and reads as before.
 */
export const SECRET_DEVICE = "this-device"

export function secretRef(kind: SecretKind, name: string): string {
  return `${kind}/${name}`
}

/** The version a lease names: the SHA-256 of the record's own version, which is never derived from its value. */
export function secretVersion(record: Pick<SecretListing, "version">): string {
  return createHash("sha256").update(record.version).digest("hex")
}

export function secretGrant(record: SecretListing, at: number): Grant {
  const grant: Grant = {
    id: secretGrantId(record),
    resource: { kind: "credential", ref: secretRef(record.kind, record.name) },
    source: { kind: "device", device: SECRET_DEVICE },
    scope: { level: "account", account: DEVICE_ACCOUNT },
    within: "source-device",
    mode: "copy",
    access: "read",
    lifetime: record.expiresAt ? { until: "expires", at: Date.parse(record.expiresAt) } : { until: "revoked" },
    ask: "never",
    secret: true,
    label: secretRef(record.kind, record.name),
    grantedBy: { kind: "person", account: DEVICE_ACCOUNT },
    grantedAt: Date.parse(record.savedAt) || at,
    version: 1,
  }
  return grant
}

export type Lent = { lease: Lease; record: SecretRecord } | { refusal: Refusal }

export class GrantedSecrets implements Secrets {
  readonly broker: LocalBorrowing
  readonly #inner: Secrets
  #seeded: Promise<void> | undefined

  /** `more`: the sources of any other broker sharing `folder` (the device's checkouts), so either answers what the other asks. */
  constructor(inner: Secrets, folder?: string, more: Partial<Record<Kind, SourceFn>> = {}) {
    this.#inner = inner
    const options: LocalBorrowingOptions = { device: SECRET_DEVICE, account: DEVICE_ACCOUNT, sources: { ...more, credential: (ask: SourceAsk) => this.#source(ask) } }
    if (folder) options.folder = folder
    this.broker = new LocalBorrowing(options)
  }

  durable(): Promise<boolean> {
    return this.#inner.durable()
  }

  read(kind: SecretKind, name: string): Promise<SecretRecord | null> {
    return this.#inner.read(kind, name)
  }

  list(kind: SecretKind): Promise<SecretListing[]> {
    return this.#inner.list(kind)
  }

  async write(kind: SecretKind, name: string, value: string, options?: SecretWrite): Promise<SecretRecord> {
    await this.seed()
    const record = await this.#inner.write(kind, name, value, options)
    await this.#end(kind, name, record.version)
    await this.broker.grant(secretGrant(record, Date.now()))
    return record
  }

  async delete(kind: SecretKind, name: string): Promise<void> {
    await this.seed()
    await this.#inner.delete(kind, name)
    await this.#end(kind, name)
  }

  /** A grant for every record saved before grants were kept, once; one the person ended stays ended. */
  seed(): Promise<void> {
    this.#seeded ??= (async () => {
      for (const kind of SECRET_KINDS)
        for (const record of await this.#inner.list(kind).catch((): SecretListing[] => []))
          if (record.version !== "legacy") await this.broker.grant(secretGrant(record, Date.now()))
    })()
    return this.#seeded
  }

  /**
   * A saved value for a Thread on this device, under a lease: the device's grant decides, the log records it, and a
   * value replaced or deleted since ends the lease. `correlationId` makes one launch one lease.
   */
  async lend(kind: SecretKind, name: string, borrower: Omit<Borrower, "account" | "place">, why: string, correlationId: string): Promise<Lent> {
    await this.seed()
    const answer = await this.broker.borrow({
      kind: "credential",
      ref: secretRef(kind, name),
      for: { ...borrower, account: DEVICE_ACCOUNT, place: { kind: "device", device: SECRET_DEVICE } },
      why,
      correlationId,
      mode: "copy",
    })
    if ("refusal" in answer) return answer
    if (!("lease" in answer)) return { refusal: { refused: "unavailable", reason: "error" } }
    const record = await this.#inner.read(kind, name)
    if (!record || secretVersion(record) !== answer.lease.version) {
      await this.broker.release(answer.lease.id)
      return { refusal: { refused: "unavailable", reason: "changed" } }
    }
    return { lease: answer.lease, record }
  }

  /** Every grant of a record's earlier versions ends, revoked by the person who replaced or deleted it. */
  async #end(kind: SecretKind, name: string, keep?: string): Promise<void> {
    const ref = secretRef(kind, name)
    for (const grant of await this.broker.grants())
      if (grant.resource.kind === "credential" && grant.resource.ref === ref && grant.id !== (keep ? secretGrantId({ kind, name, version: keep }) : undefined))
        await this.broker.revoke(grant.id, { kind: "person", account: DEVICE_ACCOUNT })
  }

  /**
   * The version a lease of a saved record names now (`secretVersion`), from its listing alone: never its value.
   * Undefined for a record that isn't saved, or one saved before records had versions.
   */
  async version(kind: SecretKind, name: string): Promise<string | undefined> {
    const listed = (await this.#inner.list(kind).catch((): SecretListing[] => [])).find((record) => record.name === name)
    return listed && listed.version !== "legacy" ? secretVersion(listed) : undefined
  }

  async #source(ask: SourceAsk): Promise<SourceAnswer> {
    const [kind, ...rest] = ask.ref.split("/")
    const found = SECRET_KINDS.find((known) => known === kind)
    if (!found) return { answer: "unavailable", reason: "not-found" }
    const version = await this.version(found, rest.join("/"))
    return version ? { answer: "yes", version } : { answer: "unavailable", reason: "not-found" }
  }
}
