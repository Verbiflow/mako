import assert from "node:assert/strict"
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto"
import { execFileSync } from "node:child_process"
import { Git } from "@mako/git"
import { borrowSealContext } from "@mako/protocol/borrow"
import { CheckoutBorrowing } from "@mako/host/workspaces/checkout-borrowing"
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { aesSealer, fileSecrets, secretGrantId, type SecretKey } from "@mako/host/base/secrets"
import { GrantedSecrets, secretRef } from "@mako/host/base/secret-grants"

/**
 * The Mac's secret store as borrowing's vault on the device: records read in either format and written in the one
 * every build sharing the store reads, never rewritten by a read; every saved record a grant of the device's broker given when it was saved and
 * ended when it's replaced or deleted, and a Thread's harness taking a key only under a lease that the device's log
 * records by name and version, never by value.
 */

const root = mkdtempSync(join(tmpdir(), "mako-secret-grants-"))
const dataKey = randomBytes(32)
const key: SecretKey = { available: async () => true, key: async () => dataKey }
const store = fileSecrets(join(root, "secrets"), aesSealer(key))
const CANARY = `sk-canary-${randomUUID()}`
const SECOND = `sk-canary-${randomUUID()}`

// How a build before this one reads a record: format 1 only, under the store's own context. Whatever this build
// writes must open this way, for an older host sharing the store and for the app rolled back.
function olderRead(path: string): string {
  // SAFETY: the record is the store's own file; a field it lacks fails the assertions below.
  const file = JSON.parse(readFileSync(path, "utf8")) as { format: number; kind: string; name: string; version: string; sealed: string }
  assert.equal(file.format, 1, `${path} is in a format an older build can't read`)
  const [iv, tag, sealed] = file.sealed.split(".").map((part) => Buffer.from(part, "base64url"))
  const decipher = createDecipheriv("aes-256-gcm", dataKey, iv!)
  decipher.setAAD(Buffer.from(`mako-secret\0${file.kind}\0${file.name}\0${file.version}`))
  decipher.setAuthTag(tag!)
  return Buffer.concat([decipher.update(sealed!), decipher.final()]).toString("utf8")
}

// An older record opens, and reading it leaves it exactly as it was.
const version = randomUUID()
const iv = randomBytes(12)
const cipher = createCipheriv("aes-256-gcm", dataKey, iv)
cipher.setAAD(Buffer.from(`mako-secret\0saved-key\0older\0${version}`))
const data = Buffer.concat([cipher.update("older-value", "utf8"), cipher.final()])
mkdirSync(join(root, "secrets", "saved-key"), { recursive: true })
const olderPath = join(root, "secrets", "saved-key", "older.json")
writeFileSync(olderPath, JSON.stringify({ format: 1, sealer: "aes-256-gcm", kind: "saved-key", name: "older", version, savedAt: new Date().toISOString(), expiresAt: null, sealed: [iv, cipher.getAuthTag(), data].map((part) => part.toString("base64url")).join(".") }))
assert.equal((await store.read("saved-key", "older"))?.value, "older-value")
const olderBytes = readFileSync(olderPath, "utf8")
await store.list("saved-key")
await store.read("saved-key", "older")
assert.equal(readFileSync(olderPath, "utf8"), olderBytes, "a read never rewrites a record")
assert.equal(olderRead(olderPath), "older-value", "an older build still opens it")

// A record a later build wrote under borrowing's one seal (format 2) opens here.
const laterVersion = randomUUID()
const laterIv = randomBytes(12)
const laterCipher = createCipheriv("aes-256-gcm", dataKey, laterIv)
laterCipher.setAAD(Buffer.from(borrowSealContext("local", secretGrantId({ kind: "saved-key", name: "later", version: laterVersion }), laterVersion)))
const laterData = Buffer.concat([laterCipher.update("later-value", "utf8"), laterCipher.final()])
writeFileSync(join(root, "secrets", "saved-key", "later.json"), JSON.stringify({ format: 2, sealer: "aes-256-gcm", kind: "saved-key", name: "later", version: laterVersion, savedAt: new Date().toISOString(), expiresAt: null, sealed: [laterIv, laterCipher.getAuthTag(), laterData].map((part) => part.toString("base64url")).join(".") }))
assert.equal((await store.read("saved-key", "later"))?.value, "later-value", "a format 2 record opens")
await store.delete("saved-key", "later")

// Wrapped as the device's vault: the record saved before grants were kept gets one.
const secrets = new GrantedSecrets(store, join(root, "borrowing"))
await secrets.seed()
assert.deepEqual((await secrets.broker.grants()).map((grant) => grant.resource.ref), [secretRef("saved-key", "older")])

// Saving is the person's grant; a Thread's launch takes the key under a lease.
await secrets.write("saved-key", "connection/one", CANARY)
const thread = { thread: "thread-1", repository: "/work/shop" }
const lent = await secrets.lend("saved-key", "connection/one", thread, "the one connection's key for a launch", "launch-1")
assert.ok("lease" in lent, JSON.stringify(lent))
assert.equal(lent.record.value, CANARY)
assert.equal(lent.lease.delivery.secret, true)
const again = await secrets.lend("saved-key", "connection/one", thread, "the one connection's key for a launch", "launch-1")
assert.ok("lease" in again && again.lease.id === lent.lease.id, "one launch, one lease")

// Replacing the value ends the lease on the old one and its grant; the next launch takes the new one.
await secrets.write("saved-key", "connection/one", SECOND)
assert.equal((await secrets.broker.lease(lent.lease.id))?.ended, "revoked")
const stale = await secrets.lend("saved-key", "connection/one", thread, "the one connection's key for a launch", "launch-1")
assert.ok("refusal" in stale && stale.refusal.refused === "revoked", "the old launch's lease isn't handed out again")
const next = await secrets.lend("saved-key", "connection/one", thread, "the one connection's key for a launch", "launch-2")
assert.ok("lease" in next && next.record.value === SECOND && next.lease.version !== lent.lease.version)

// The device's grants keep to it: a Thread on a cloud machine is refused, typed.
const away = await secrets.broker.borrow({ kind: "credential", ref: secretRef("saved-key", "connection/one"), for: { account: "local", repository: "/work/shop", thread: "cloud", place: { kind: "machine", machine: "m-1" } }, why: "a cloud Thread", correlationId: "away" })
assert.ok("refusal" in away && away.refusal.refused === "out-of-scope")

// Deleting ends every grant of it; a launch after that is refused.
await secrets.delete("saved-key", "connection/one")
const gone = await secrets.lend("saved-key", "connection/one", thread, "the one connection's key for a launch", "launch-3")
assert.ok("refusal" in gone && gone.refusal.refused === "revoked")
assert.ok(!(await secrets.broker.grants()).some((grant) => grant.resource.ref === secretRef("saved-key", "connection/one")))

// The device's log and state name what was lent and when, never a value; and the grants outlive the host.
const disk = readFileSync(join(root, "borrowing", "events.jsonl"), "utf8") + readFileSync(join(root, "borrowing", "state.json"), "utf8")
for (const value of [CANARY, SECOND, "older-value"]) assert.ok(!disk.includes(value), "no value on the broker's disk")
assert.ok(disk.includes('"event":"granted"') && disk.includes('"event":"revoked"'))
const reopened = new GrantedSecrets(store, join(root, "borrowing"))
assert.deepEqual((await reopened.broker.grants()).map((grant) => grant.resource.ref), [secretRef("saved-key", "older")])


// Every record this build wrote opens for an older build: the store can be shared with one, or rolled back to one.
for (const file of readdirSync(join(root, "secrets", "saved-key"), { recursive: true }).map(String).filter((name) => name.endsWith(".json")))
  olderRead(join(root, "secrets", "saved-key", file))
await store.write("saved-key", "rolling", "rolling-value")
assert.equal(olderRead(join(root, "secrets", "saved-key", "rolling.json")), "rolling-value", "a new record is written as an older build reads it")

// The device's checkout broker over the same folder is the same broker: a revoke made through one stands after the
// other writes, and a fresh one doesn't lend what was revoked.
{
  const folder = join(root, "borrowing-composed")
  const vault = new GrantedSecrets(store, folder)
  await vault.write("saved-key", "connection/two", CANARY)
  const checkouts = CheckoutBorrowing.open(new Git(), folder)
  await checkouts.seed()
  const grant = (await vault.broker.grants()).find((held) => held.resource.ref === secretRef("saved-key", "connection/two"))!
  await vault.broker.revoke(grant.id, { kind: "person", account: "local" })
  await checkouts.borrowing.tick()
  await checkouts.seed()
  const fresh = new GrantedSecrets(store, folder)
  assert.ok(!(await fresh.broker.grants()).some((held) => held.id === grant.id), "the revoked grant stays revoked")
  const refused = await fresh.lend("saved-key", "connection/two", { thread: "t-c", repository: "/work/shop" }, "a launch", "composed-1")
  assert.ok("refusal" in refused && refused.refusal.refused === "revoked", JSON.stringify(refused))

  // Another host process revokes a grant this one holds open; this one's next lend is refused.
  await vault.write("saved-key", "connection/three", SECOND)
  const third = (await vault.broker.grants()).find((held) => held.resource.ref === secretRef("saved-key", "connection/three"))!
  execFileSync(process.execPath, ["--import", "tsx", "-e", `
    const { LocalBorrowing } = await import("@mako/host/base/local-borrowing")
    const other = new LocalBorrowing({ folder: ${JSON.stringify(folder)}, device: "this-device", account: "local", sources: {} })
    await other.revoke(${JSON.stringify(third.id)}, { kind: "person", account: "local" })
  `], { cwd: process.cwd(), stdio: "inherit" })
  const after = await vault.lend("saved-key", "connection/three", { thread: "t-c", repository: "/work/shop" }, "a launch", "composed-2")
  assert.ok("refusal" in after && after.refusal.refused === "revoked", "a revoke from another host stands")
}

console.log("secret grants: older records read and never rewritten, format 2 read, every write readable by an older build, the checkout broker and another host over the same folder never undo a revoke, records saved earlier granted, a launch's key lent under a lease, one launch one lease, a replaced value ends its lease, the device's grants keep to it, deleting ends its grants, no value in the broker's log or state, grants kept across hosts")
