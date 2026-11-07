import assert from "node:assert/strict"
import { z } from "zod"
import {
  BORROW_INLINE_BYTES,
  BorrowAnswerSchema,
  BorrowPushSchema,
  GrantSchema,
  LeaseEventSchema,
  LeaseSchema,
  SourceAskSchema,
  type BorrowAnswer,
  type BorrowPush,
  type Borrower,
  type Grant,
  type Lease,
  type LeaseEvent,
  type Need,
  type SourceAnswer,
  type SourceAsk,
} from "./borrow.js"
import type { ConformanceTest } from "./conformance.js"

/*
 * What every broker owes its borrowers and its person, over its own transport: the seven rules of `borrow.ts`, each
 * case on a fresh account. A gateway runs it against its routes; a device's own broker runs it against its local
 * transport. Values are canaries the suite makes, so it can look for them in everything the broker says and keeps.
 */

/** A grant as the person gives it; the broker stamps who and when. */
export type GrantGiven = Omit<Grant, "grantedBy" | "grantedAt">

/** The person, at one of their devices: they give and revoke grants, read the log, and answer as a source. */
export interface BorrowPersonUnderTest {
  readonly account: string
  readonly device: string
  /** The grant as taken, or the status refusing it. `value` is the vault's, when the vault is its source. */
  grant(grant: GrantGiven, value?: Uint8Array): Promise<Grant | number>
  /** The status of the revocation: success, or not found. */
  revoke(grant: string): Promise<number>
  grants(): Promise<Grant[]>
  leases(): Promise<Lease[]>
  events(since?: number): Promise<LeaseEvent[]>
  /** What this device is asked as a source; asking makes it online. */
  asks(): Promise<SourceAsk[]>
  answer(ask: string, answer: SourceAnswer): Promise<BorrowAnswer | undefined>
}

/** A Thread of the person's at a place the broker serves, as its own credential names it. */
export interface BorrowerUnderTest {
  readonly borrower: Borrower
  borrow(need: Omit<Need, "for">): Promise<BorrowAnswer>
  renew(lease: string): Promise<BorrowAnswer>
  release(lease: string): Promise<void>
  /** What was pushed to it after `since`, as asking for its pushes answers. */
  pushes(since?: number): Promise<{ seq: number; pushes: Array<{ seq: number; push: BorrowPush }> }>
  /** A vault copy's value for one of its leases, or the status refusing it. */
  value(lease: string): Promise<Uint8Array | number>
}

export interface BorrowBrokerUnderTest {
  person(): Promise<BorrowPersonUnderTest>
  /** A Thread of `repository` (`owner/name`) of the person's account, at a place of the broker's choosing. */
  borrower(repository: string): Promise<BorrowerUnderTest>
  /**
   * A Thread of `repository` at one of the person's devices, as that device's own credential names it, for a broker
   * that serves device borrowers. `listed` says whether the account lists the Thread as running on that device: a
   * request naming any other Thread is refused where the device's credential is served, before a lease is issued or
   * reused. A broker that serves no device borrowers leaves it out, and its device cases don't run.
   */
  deviceBorrower?(repository: string, device: string, listed: boolean): Promise<BorrowerUnderTest>
  /** Everything the broker keeps for the account, as text, wherever it keeps it: no value may be in it in the clear. */
  kept(): Promise<string>
  close(): Promise<void>
}

const REPOSITORY = "conformance/shop"
const OTHER_REPOSITORY = "conformance/other"
const encoder = new TextEncoder()

function canary(size?: number): Uint8Array {
  const text = `CANARY_${crypto.randomUUID()}`
  if (size === undefined) return encoder.encode(`${text}\n`)
  return encoder.encode(text.padEnd(size, "x"))
}

function base64(bytes: Uint8Array): string {
  let text = ""
  for (const byte of bytes) text += String.fromCharCode(byte)
  return btoa(text)
}

/** The forms a value could leak in: its text, a line of it, and its base64. */
function leaks(value: Uint8Array): string[] {
  const text = new TextDecoder().decode(value).trim()
  return [text.slice(0, 48), base64(value).slice(0, 48)]
}

function vaultCopy(account: string, id: string, overrides: Partial<GrantGiven> = {}): GrantGiven {
  return {
    id,
    resource: { kind: "file", ref: ".env" },
    source: { kind: "vault" },
    scope: { level: "project", account, repository: REPOSITORY },
    mode: "copy",
    access: "read",
    lifetime: { until: "revoked" },
    ask: "never",
    secret: true,
    version: 1,
    ...overrides,
  }
}

const need = (correlationId: string, overrides: Partial<Omit<Need, "for">> = {}): Omit<Need, "for"> => ({ kind: "file", ref: ".env", why: "the dev server reads it", correlationId, ...overrides })

function leaseOf(answer: BorrowAnswer): Lease {
  BorrowAnswerSchema.parse(answer)
  assert.ok("lease" in answer, `expected a lease, got ${JSON.stringify(answer)}`)
  return LeaseSchema.parse(answer.lease)
}

function refusalOf(answer: BorrowAnswer): string {
  BorrowAnswerSchema.parse(answer)
  assert.ok("refusal" in answer, `expected a refusal, got ${JSON.stringify(answer)}`)
  return answer.refusal.refused
}

/** A broker refuses with a status where the answer would be. */
function refused(answer: Grant | Uint8Array | number): boolean {
  return z.number().safeParse(answer).success
}

function granted(given: Grant | number): Grant {
  const parsed = GrantSchema.safeParse(given)
  assert.ok(parsed.success, `the grant was refused with ${given}`)
  return parsed.data
}

/** The broker's seven rules, as its borrowers and its person meet them. Each case gets a fresh broker and account. */
export function runBorrowConformance(makeBroker: () => Promise<BorrowBrokerUnderTest>, test: ConformanceTest): void {
  const scenario = (name: string, body: (broker: BorrowBrokerUnderTest) => Promise<void>) =>
    test(`borrowing: ${name}`, async () => {
      const broker = await makeBroker()
      try {
        await body(broker)
      } finally {
        await broker.close()
      }
    })

  scenario("a device borrows only for a Thread the account lists as running there, under a grant naming that device", async (broker) => {
    if (!broker.deviceBorrower) return
    const person = await broker.person()
    const value = canary()
    granted(await person.grant(vaultCopy(person.account, "env", { devices: ["conformance-box"] }), value))
    const box = await broker.deviceBorrower(REPOSITORY, "conformance-box", true)
    const lease = leaseOf(await box.borrow(need("c-1")))
    assert.deepEqual(await box.value(lease.id), value)
    const elsewhere = await broker.deviceBorrower(REPOSITORY, "conformance-other", true)
    assert.equal(refusalOf(await elsewhere.borrow(need("c-1"))), "out-of-scope", "a device the grant doesn't name")
    // Another Thread named by the same device's credential, one the account doesn't list there: issued nothing, and
    // the lease the listed Thread holds doesn't open for it. Each holds on its own.
    const claimed = await broker.deviceBorrower(REPOSITORY, "conformance-box", false)
    assert.ok("refusal" in (await claimed.borrow(need("c-1"))), "an unlisted Thread is refused the need the listed one holds")
    assert.ok("refusal" in (await claimed.borrow(need("c-2"))), "and is issued nothing new")
    assert.ok(refused(await claimed.value(lease.id)), "and the listed Thread's lease doesn't open for it")
  })

  scenario("a lease held under a grant that changed away from its borrower is refused when it's asked for again", async (broker) => {
    if (!broker.deviceBorrower) return
    const person = await broker.person()
    granted(await person.grant(vaultCopy(person.account, "env", { devices: ["conformance-box"] }), canary()))
    const box = await broker.deviceBorrower(REPOSITORY, "conformance-box", true)
    const lease = leaseOf(await box.borrow(need("c-1")))
    granted(await person.grant(vaultCopy(person.account, "env", { devices: ["conformance-other"], version: 2 }), canary()))
    assert.ok("refusal" in (await box.borrow(need("c-1"))), "the cached lease isn't handed back")
    assert.ok(refused(await box.value(lease.id)), "and its value no longer opens")
  })

  scenario("a vault copy reaches its project's Threads and no other, and opens only for its own lease", async (broker) => {
    const person = await broker.person()
    const value = canary()
    granted(await person.grant(vaultCopy(person.account, "env"), value))
    const mine = await broker.borrower(REPOSITORY)
    const lease = leaseOf(await mine.borrow(need("c-1")))
    assert.equal(lease.grant, "env")
    assert.deepEqual(lease.borrower, mine.borrower)
    assert.deepEqual(lease.delivery, { transfer: "inline", secret: true, size: value.length })
    assert.deepEqual(await mine.value(lease.id), value)

    const other = await broker.borrower(OTHER_REPOSITORY)
    assert.equal(refusalOf(await other.borrow(need("c-1"))), "out-of-scope")
    assert.ok(refused(await other.value(lease.id)), "another Thread can't read the lease's value")
    assert.equal(refusalOf(await mine.borrow(need("c-2", { kind: "env", ref: "DATABASE_URL" }))), "no-grant")
  })

  scenario("a Thread's grant reaches that Thread only, and the narrowest grant wins", async (broker) => {
    const person = await broker.person()
    const one = await broker.borrower(REPOSITORY)
    const two = await broker.borrower(REPOSITORY)
    granted(await person.grant(vaultCopy(person.account, "wide", { scope: { level: "account", account: person.account } }), canary()))
    granted(await person.grant(vaultCopy(person.account, "narrow", { scope: { level: "thread", account: person.account, thread: one.borrower.thread } }), canary()))
    assert.equal(leaseOf(await one.borrow(need("c-1"))).grant, "narrow")
    assert.equal(leaseOf(await two.borrow(need("c-1"))).grant, "wide")
  })

  scenario("a revocation ends every lease under it, tells the borrower, and no lease is issued or renewed after", async (broker) => {
    const person = await broker.person()
    granted(await person.grant(vaultCopy(person.account, "env"), canary()))
    const mine = await broker.borrower(REPOSITORY)
    const lease = leaseOf(await mine.borrow(need("c-1")))
    const before = await mine.pushes()
    assert.ok([200, 204].includes(await person.revoke("env")))
    const after = await mine.pushes(before.seq)
    assert.deepEqual(after.pushes.map((entry) => BorrowPushSchema.parse(entry.push)), [{ push: "ended", lease: lease.id, why: "revoked" }])
    assert.ok(after.pushes.every((entry) => entry.seq > before.seq))
    assert.ok(refused(await mine.value(lease.id)), "a revoked lease's value doesn't open")
    assert.equal(refusalOf(await mine.renew(lease.id)), "revoked")
    assert.equal(refusalOf(await mine.borrow(need("c-1"))), "revoked", "the same need ended stays ended")
    assert.equal(refusalOf(await mine.borrow(need("c-2"))), "revoked")
    assert.deepEqual((await person.leases()).filter((each) => each.grant === "env"), [])
    assert.deepEqual((await person.grants()).filter((each) => each.id === "env"), [])
    assert.ok(refused(await person.grant(vaultCopy(person.account, "env", { version: 2 }), canary())), "a revoked grant doesn't come back")
    const events = await person.events()
    assert.ok(events.some((event) => event.event === "revoked" && event.lease === lease.id))
  })

  scenario("no lease outlives its grant", async (broker) => {
    const person = await broker.person()
    const at = Date.now() + 10 * 60_000
    granted(await person.grant(vaultCopy(person.account, "env", { lifetime: { until: "expires", at } }), canary()))
    const lease = leaseOf(await (await broker.borrower(REPOSITORY)).borrow(need("c-1")))
    assert.ok(lease.expiresAt <= at, "the lease ends by its grant's end")
  })

  scenario("no value is in the log, a listing, a push or anything kept in the clear", async (broker) => {
    const person = await broker.person()
    const value = canary()
    const large = canary(BORROW_INLINE_BYTES + 4_096)
    granted(await person.grant(vaultCopy(person.account, "env"), value))
    granted(await person.grant(vaultCopy(person.account, "big", { resource: { kind: "file", ref: "fixtures/big.json" } }), large))
    const mine = await broker.borrower(REPOSITORY)
    const small = leaseOf(await mine.borrow(need("c-1")))
    const big = leaseOf(await mine.borrow(need("c-2", { ref: "fixtures/big.json" })))
    assert.equal(big.delivery.transfer, "chunks")
    assert.deepEqual(await mine.value(big.id), large, "a large value comes back whole")
    await person.revoke("env")
    const said = JSON.stringify([await person.events(), await person.leases(), await person.grants(), await mine.pushes(), small, big, await broker.kept()])
    for (const leak of [...leaks(value), ...leaks(large)]) assert.ok(!said.includes(leak), "a value in what the broker says or keeps")
    for (const event of await person.events()) LeaseEventSchema.parse(event)
  })

  scenario("the same need under the same correlation ID is the same lease, and logged once", async (broker) => {
    const person = await broker.person()
    granted(await person.grant(vaultCopy(person.account, "env"), canary()))
    const mine = await broker.borrower(REPOSITORY)
    const first = leaseOf(await mine.borrow(need("c-1")))
    assert.deepEqual(leaseOf(await mine.borrow(need("c-1"))), first)
    assert.notEqual(leaseOf(await mine.borrow(need("c-2"))).id, first.id)
    const lines = (await person.events()).filter((event) => event.event === "granted" && event.correlationId === "c-1")
    assert.equal(lines.length, 1)
  })

  scenario("a device source is asked, its person on first use only, and its yes or no decides", async (broker) => {
    const person = await broker.person()
    granted(await person.grant(vaultCopy(person.account, "notes", { resource: { kind: "tree", ref: "~/notes" }, source: { kind: "device", device: person.device }, ask: "first-use", secret: false })))
    assert.deepEqual(await person.asks(), [])
    const mine = await broker.borrower(REPOSITORY)
    const waiting = await mine.borrow(need("c-1", { ref: "~/notes/a.md" }))
    assert.ok("pending" in waiting, JSON.stringify(waiting))
    const [ask] = (await person.asks()).map((each) => SourceAskSchema.parse(each))
    assert.ok(ask)
    assert.equal(ask.askPerson, true)
    const version = "a".repeat(64)
    const yes = await person.answer(ask.ask, { answer: "yes", version, size: 10 })
    assert.ok(yes)
    assert.equal(leaseOf(yes).version, version)
    assert.deepEqual(await mine.borrow(need("c-1", { ref: "~/notes/a.md" })), yes, "the waiting need answers with the yes")
    const pushes = await mine.pushes()
    assert.ok(pushes.pushes.some((entry) => entry.push.push === "decided" && entry.push.correlationId === "c-1"), "the yes is pushed to the borrower")

    await mine.borrow(need("c-2", { ref: "~/notes/b.md" }))
    const [second] = await person.asks()
    assert.ok(second)
    assert.equal(second.askPerson, false, "first use asks the person once per Thread")
    const no = await person.answer(second.ask, { answer: "no", by: { kind: "person", account: person.account, device: person.device } })
    assert.ok(no)
    assert.equal(refusalOf(no), "declined")
    assert.equal(await person.answer(second.ask, { answer: "yes", version }), undefined, "an ask is answered once")
  })

  scenario("a source that can't serve says why as a reason alone, which is all its borrower hears", async (broker) => {
    const person = await broker.person()
    granted(await person.grant(vaultCopy(person.account, "notes", { resource: { kind: "tree", ref: "~/notes" }, source: { kind: "device", device: person.device }, ask: "never", secret: false })))
    await person.asks()
    const mine = await broker.borrower(REPOSITORY)
    const waiting = await mine.borrow(need("c-1", { ref: "~/notes/a.md" }))
    assert.ok("pending" in waiting, JSON.stringify(waiting))
    const [ask] = await person.asks()
    assert.ok(ask)
    const secret = `cat: ${new TextDecoder().decode(canary()).trim()}: Permission denied`
    // SAFETY: the type refuses `detail`; the case is a transport that sends it anyway, and the broker refusing it.
    assert.equal(await person.answer(ask.ask, { answer: "unavailable", reason: "unreadable", detail: secret } as never), undefined, "an answer with words of its own isn't taken")
    const answered = await person.answer(ask.ask, { answer: "unavailable", reason: "unreadable" })
    assert.ok(answered)
    assert.deepEqual("refusal" in answered && answered.refusal, { refused: "unavailable", reason: "unreadable" })
    const pushed = (await mine.pushes()).pushes.find((entry) => entry.push.push === "decided" && entry.push.correlationId === "c-1")
    assert.ok(pushed && pushed.push.push === "decided")
    assert.deepEqual(pushed.push.answer, { refusal: { refused: "unavailable", reason: "unreadable" } })
    assert.ok("pending" in (await mine.borrow(need("c-1", { ref: "~/notes/a.md" }))), "only a lease and a person's no answer a need for good: asked again, the source is asked again")
    assert.ok((await person.events()).some((event) => event.event === "refused" && event.refused === "unavailable"))
  })

  scenario("a source that isn't there is typed: source-offline, never a missing file", async (broker) => {
    const person = await broker.person()
    granted(await person.grant(vaultCopy(person.account, "far", { resource: { kind: "tree", ref: "~/far" }, source: { kind: "device", device: "conformance-away" }, ask: "never", secret: false })))
    const answer = await (await broker.borrower(REPOSITORY)).borrow(need("c-1", { kind: "file", ref: "~/far/x" }))
    assert.equal(refusalOf(answer), "source-offline")
    assert.deepEqual("refusal" in answer && answer.refusal, { refused: "source-offline", source: { kind: "device", device: "conformance-away" }, lastSeen: null })
  })

  scenario("a new value of a vault copy is pushed to its lessees as a new version", async (broker) => {
    const person = await broker.person()
    granted(await person.grant(vaultCopy(person.account, "env"), canary()))
    const mine = await broker.borrower(REPOSITORY)
    const lease = leaseOf(await mine.borrow(need("c-1")))
    const before = await mine.pushes()
    const next = canary()
    granted(await person.grant(vaultCopy(person.account, "env", { version: 2 }), next))
    const pushed = (await mine.pushes(before.seq)).pushes.map((entry) => entry.push)
    const version = pushed.find((push) => push.push === "version")
    assert.ok(version && version.push === "version" && version.lease === lease.id && version.version !== lease.version, JSON.stringify(pushed))
    const renewed = leaseOf(await mine.borrow(need("c-3")))
    assert.equal(renewed.version, version.version)
    assert.deepEqual(await mine.value(renewed.id), next)
  })

  scenario("a release ends the lease without a push, and its value stops opening", async (broker) => {
    const person = await broker.person()
    granted(await person.grant(vaultCopy(person.account, "env"), canary()))
    const mine = await broker.borrower(REPOSITORY)
    const lease = leaseOf(await mine.borrow(need("c-1")))
    const before = await mine.pushes()
    await mine.release(lease.id)
    assert.deepEqual((await mine.pushes(before.seq)).pushes, [])
    assert.ok(refused(await mine.value(lease.id)))
    assert.ok((await person.events()).some((event) => event.event === "released" && event.lease === lease.id))
  })
}
